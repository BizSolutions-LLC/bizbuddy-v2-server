// scripts/backup-and-backfill-ot.js
// 1. Backs up every CutoffOtBlock row for affected cutoff periods to a timestamped
//    JSON file (scripts/backups/).
// 2. Calls the real recomputeAllOtForCutoff() service (same code path a normal
//    approval action triggers) to correct OT using the TR-excluded formula.
// 3. Prints a before/after diff per block.
//
// "Affected period" = any cutoff period on a cutoff-basis (otBasis: "cutoff")
// company that has at least one approved TRAINING TimeLogApproval record.

require("module-alias/register");
const fs   = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { recomputeAllOtForCutoff } = require("@services/Cutoff/cutoffOtService");

async function main() {
  const companies = await prisma.company.findMany({
    where:  { otBasis: "cutoff" },
    select: { id: true, name: true },
  });

  const affectedPeriods = []; // { periodId, companyId, companyName }

  for (const company of companies) {
    const trainingApprovals = await prisma.timeLogApproval.findMany({
      where: {
        status:  "approved",
        timeLog: { punchType: "TRAINING", user: { companyId: company.id } },
      },
      select: { cutoffPeriodId: true },
    });
    const periodIds = [...new Set(trainingApprovals.map((a) => a.cutoffPeriodId))];
    for (const periodId of periodIds) {
      affectedPeriods.push({ periodId, companyId: company.id, companyName: company.name });
    }
  }

  console.log(`Affected periods: ${affectedPeriods.length}`);
  affectedPeriods.forEach((p) => console.log(`  - ${p.companyName} / ${p.periodId}`));

  // ── 1. Backup ────────────────────────────────────────────────────────────
  const backupDir = path.join(__dirname, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp  = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(backupDir, `cutoffOtBlock-backup-${timestamp}.json`);

  const allBlocksBefore = [];
  for (const { periodId } of affectedPeriods) {
    const blocks = await prisma.cutoffOtBlock.findMany({ where: { cutoffPeriodId: periodId } });
    allBlocksBefore.push(...blocks);
  }

  fs.writeFileSync(backupFile, JSON.stringify(allBlocksBefore, null, 2));
  console.log(`\n✅ Backed up ${allBlocksBefore.length} CutoffOtBlock rows → ${backupFile}\n`);

  const beforeById = new Map(allBlocksBefore.map((b) => [b.id, b]));

  // ── 2. Backfill via the real service function ───────────────────────────
  for (const { periodId, companyId, companyName } of affectedPeriods) {
    console.log(`Recomputing OT — ${companyName} / period ${periodId} ...`);
    await recomputeAllOtForCutoff(periodId, companyId);
  }

  // ── 3. Diff ──────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("BEFORE → AFTER");
  console.log("═══════════════════════════════════════════════════════════════");

  for (const { periodId } of affectedPeriods) {
    const afterBlocks = await prisma.cutoffOtBlock.findMany({
      where: { cutoffPeriodId: periodId },
      include: { user: { include: { profile: true } } },
    });
    const afterByUser = new Map(afterBlocks.map((b) => [b.userId, b]));

    const beforeUserIds = new Set(
      allBlocksBefore.filter((b) => b.cutoffPeriodId === periodId).map((b) => b.userId)
    );
    const allUserIds = new Set([...beforeUserIds, ...afterByUser.keys()]);

    for (const userId of allUserIds) {
      const before = allBlocksBefore.find((b) => b.cutoffPeriodId === periodId && b.userId === userId);
      const after  = afterByUser.get(userId);
      const name   = after?.user?.profile
        ? `${after.user.profile.firstName} ${after.user.profile.lastName}`
        : userId;

      const beforeStr = before ? `${before.otHours}h (${before.status})` : "none";
      const afterStr  = after  ? `${after.otHours}h (${after.status})`  : "none (removed)";

      if (beforeStr !== afterStr) {
        console.log(`${name.padEnd(28)} period ${periodId.slice(-6)}: ${beforeStr.padEnd(20)} → ${afterStr}`);
      }
    }
  }
  console.log("═══════════════════════════════════════════════════════════════");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
