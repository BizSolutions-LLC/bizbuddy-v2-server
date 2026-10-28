// scripts/fix-cutoff-no-department-jan2026-round2.js
//
// Round 2 of the BB-086 data fix. Round 1 (fix-cutoff-no-department-jan2026.js)
// moved 663 rows but left 73 "blocked - no target period" even though their
// department periods exist, because it compared TimeLog.timeIn against the
// target period's raw UTC periodEnd. check-cutoff-no-department-jan2026-round2.js
// confirmed all 73 are punches on the period's last calendar day (Jan 20) in
// the company's timezone (America/Los_Angeles) whose UTC timestamp only
// "looks" later than the raw UTC-midnight periodEnd. Using the same
// company-timezone end-of-day extension syncApprovalRecords() already uses
// resolves all 73.
//
// Writes its own backup (scripts/backup-cutoff-no-department-jan2026-round2.json)
// before making any changes.
//
// Usage:
//   node scripts/fix-cutoff-no-department-jan2026-round2.js

const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TARGET_PERIOD_START = "2026-01-07";
const TARGET_PERIOD_END = "2026-01-20";
const BACKUP_PATH = path.join(__dirname, "backup-cutoff-no-department-jan2026-round2.json");

async function resolveTargetPeriod({ companyId, departmentId, timeInDate, companyTimezone, cache }) {
  const cacheKey = `${companyId}_${departmentId}`;
  if (!cache.has(cacheKey)) {
    const periods = await prisma.cutoffPeriod.findMany({
      where: { companyId, departmentId, status: "open" },
      select: { id: true, periodStart: true, periodEnd: true },
    });
    cache.set(cacheKey, periods);
  }
  const periods = cache.get(cacheKey);
  return (
    periods.find((p) => {
      const start = new Date(p.periodStart);
      const endDateStr = new Date(p.periodEnd).toISOString().slice(0, 10);
      const endEOD = moment.tz(endDateStr, companyTimezone).endOf("day").toDate();
      return start <= timeInDate && endEOD >= timeInDate;
    }) || null
  );
}

async function main() {
  const noDeptPeriods = await prisma.cutoffPeriod.findMany({
    where: {
      departmentId: null,
      periodStart: new Date(`${TARGET_PERIOD_START}T00:00:00.000Z`),
      periodEnd: new Date(`${TARGET_PERIOD_END}T00:00:00.000Z`),
    },
  });

  if (noDeptPeriods.length === 0) {
    console.log("No 'No Department' CutoffPeriod found for this range. Nothing to do.");
    return;
  }

  const targetPeriodCache = new Map();
  const moves = [];
  const skippedNoDept = [];
  const skippedNoPeriod = [];

  for (const period of noDeptPeriods) {
    const company = await prisma.company.findUnique({
      where: { id: period.companyId },
      select: { timeZone: true },
    });
    const companyTimezone = company?.timeZone || "America/Los_Angeles";

    const approvals = await prisma.timeLogApproval.findMany({
      where: { cutoffPeriodId: period.id },
      select: {
        id: true,
        timeLogId: true,
        timeLog: {
          select: {
            timeIn: true,
            userId: true,
            user: { select: { id: true, departmentId: true } },
          },
        },
      },
    });

    for (const approval of approvals) {
      const user = approval.timeLog?.user;
      const timeIn = approval.timeLog?.timeIn ? new Date(approval.timeLog.timeIn) : null;

      if (!user?.departmentId) {
        skippedNoDept.push({ approvalId: approval.id, userId: approval.timeLog?.userId });
        continue;
      }

      const targetPeriod = await resolveTargetPeriod({
        companyId: period.companyId,
        departmentId: user.departmentId,
        timeInDate: timeIn,
        companyTimezone,
        cache: targetPeriodCache,
      });

      if (!targetPeriod) {
        skippedNoPeriod.push({
          approvalId: approval.id,
          userId: user.id,
          departmentId: user.departmentId,
        });
        continue;
      }

      moves.push({
        approvalId: approval.id,
        timeLogId: approval.timeLogId,
        userId: user.id,
        oldCutoffPeriodId: period.id,
        newCutoffPeriodId: targetPeriod.id,
      });
    }
  }

  console.log(
    `Resolved: ${moves.length} movable, ${skippedNoDept.length} skipped (no department), ${skippedNoPeriod.length} skipped (no target period).`
  );

  if (moves.length === 0) {
    console.log("Nothing movable — no changes made.");
    return;
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), moves }, null, 2));
  console.log(`Backup written to ${BACKUP_PATH} (${moves.length} row(s)).`);

  let updated = 0;
  for (const move of moves) {
    await prisma.timeLogApproval.update({
      where: { id: move.approvalId },
      data: { cutoffPeriodId: move.newCutoffPeriodId },
    });
    updated++;
  }

  console.log(`\nDone. ${updated} TimeLogApproval row(s) moved to their correct department period.`);
  if (skippedNoDept.length > 0) {
    console.log(`${skippedNoDept.length} row(s) left untouched — employee has no department assigned:`);
    console.log(skippedNoDept);
  }
  if (skippedNoPeriod.length > 0) {
    console.log(`${skippedNoPeriod.length} row(s) left untouched — no open department period covers this date:`);
    console.log(skippedNoPeriod);
  }

  const affectedPeriodIds = [...new Set(moves.map((m) => m.newCutoffPeriodId))];
  console.log(
    `\nNext step: run the "Sync" action on each affected department period to recompute OT/hours: ${affectedPeriodIds.join(", ")}`
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
