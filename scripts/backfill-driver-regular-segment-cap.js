// scripts/backfill-driver-regular-segment-cap.js
//
// Root cause: DRIVER_AIDE_AM and DRIVER_AIDE_PM records approved in Raw mode
// have actualHours = gross (timeIn→timeOut) window, but the correct payroll
// value is netWorkedHours (from computeTimeLogSummary — same value the
// Employee Punch Logs Report PDF shows under "Duration").
//
// DRY_RUN=true  → prints what would change, touches nothing
// DRY_RUN=false → patches actualHours = netWorkedHours, recomputes OT

require("module-alias/register");
const { PrismaClient }           = require("@prisma/client");
const { computeOtForCutoffBasis } = require("../src/services/Cutoff/cutoffOtService");

const prisma  = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== "false"; // default: dry run

// Only single-punch driver types — DRIVER_AIDE (3-segment model) has 3 approval
// records per TimeLog, so netWorkedHours would be triple-counted if patched here.
const DRIVER_PUNCH_TYPES = ["DRIVER_AIDE_AM", "DRIVER_AIDE_PM"];

async function main() {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  DRIVER actualHours → netWorkedHours backfill  [DRY_RUN=${DRY_RUN}]`);
  console.log(`${"═".repeat(64)}\n`);

  // ── 1. Find the Jun 10–23 cutoff period ────────────────────────────────────
  const cutoff = await prisma.cutoffPeriod.findFirst({
    where: {
      companyId:   "cmnegwuxm0004rf7fzo6wjrw2",
      periodStart: { gte: new Date("2026-06-09T00:00:00Z") },
      periodEnd:   { lte: new Date("2026-06-24T00:00:00Z") },
    },
    include: { company: { select: { id: true, name: true } } },
    orderBy: { periodStart: "asc" },
  });

  if (!cutoff) {
    console.log("❌  No cutoff period found.");
    return;
  }

  const { id: cutoffPeriodId, company } = cutoff;
  console.log(`Cutoff period : ${cutoffPeriodId}`);
  console.log(`Company       : ${company.name}`);
  console.log(`Period        : ${cutoff.periodStart.toISOString().slice(0,10)} → ${cutoff.periodEnd.toISOString().slice(0,10)}\n`);

  // ── 2. Fetch all approved driver punch records ──────────────────────────────
  const approvals = await prisma.timeLogApproval.findMany({
    where: {
      cutoffPeriodId,
      status:  "approved",
      timeLog: { punchType: { in: DRIVER_PUNCH_TYPES } },
    },
    select: {
      id:          true,
      actualHours: true,
      timeLog: {
        select: {
          id:             true,
          userId:         true,
          punchType:      true,
          timeIn:         true,
          netWorkedHours: true,
          user: { include: { profile: { select: { firstName: true, lastName: true } } } },
        },
      },
    },
    orderBy: { timeLog: { timeIn: "asc" } },
  });

  console.log(`── Approved driver-type records: ${approvals.length}\n`);

  if (approvals.length === 0) {
    console.log("Nothing to patch.");
    return;
  }

  // ── 3. Identify records where actualHours ≠ netWorkedHours ─────────────────
  const toFix = approvals.filter(a => {
    const actual = parseFloat(a.actualHours?.toString() ?? 0);
    const net    = parseFloat(a.timeLog.netWorkedHours?.toString() ?? 0);
    return Math.abs(actual - net) >= 0.01;
  });

  // ── 4. Per-employee summary ────────────────────────────────────────────────
  const byEmp = {};
  for (const a of approvals) {
    const uid  = a.timeLog.userId;
    const name = `${a.timeLog.user?.profile?.lastName ?? "?"}, ${a.timeLog.user?.profile?.firstName ?? "?"}`;
    if (!byEmp[uid]) byEmp[uid] = { name, records: [] };
    byEmp[uid].records.push(a);
  }

  console.log("── Per-employee: cutoff total vs PDF/net total ─────────────");
  console.log(`  ${"Name".padEnd(28)} ${"Cutoff".padStart(8)} ${"PDF/Net".padStart(8)} ${"Gap".padStart(8)} ${"To fix".padStart(8)}`);
  console.log(`  ${"─".repeat(62)}`);

  let grandGap = 0;
  for (const { name, records } of Object.values(byEmp)) {
    const cutoffTotal = records.reduce((s, r) => s + parseFloat(r.actualHours?.toString() ?? 0), 0);
    const netTotal    = records.reduce((s, r) => s + parseFloat(r.timeLog.netWorkedHours?.toString() ?? 0), 0);
    const gap         = parseFloat((cutoffTotal - netTotal).toFixed(2));
    const fixes       = records.filter(r => {
      const a = parseFloat(r.actualHours?.toString() ?? 0);
      const n = parseFloat(r.timeLog.netWorkedHours?.toString() ?? 0);
      return Math.abs(a - n) >= 0.01;
    }).length;
    grandGap += gap;
    console.log(`  ${name.padEnd(28)} ${cutoffTotal.toFixed(2).padStart(8)} ${netTotal.toFixed(2).padStart(8)} ${(gap > 0 ? "+" : "") + gap.toFixed(2).padStart(7)} ${fixes.toString().padStart(8)}`);
  }
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  ${"TOTAL gap".padEnd(28)} ${" ".padStart(8)} ${" ".padStart(8)} ${(grandGap > 0 ? "+" : "") + grandGap.toFixed(2).padStart(7)} ${toFix.length.toString().padStart(8)} records\n`);

  if (toFix.length === 0) {
    console.log("✅  All driver records already have correct actualHours.");
    return;
  }

  if (DRY_RUN) {
    console.log("── Records to patch (sample) ───────────────────────────────");
    for (const a of toFix.slice(0, 15)) {
      const actual = parseFloat(a.actualHours.toString()).toFixed(2);
      const net    = parseFloat(a.timeLog.netWorkedHours?.toString() ?? 0).toFixed(2);
      const date   = a.timeLog.timeIn.toISOString().slice(0, 10);
      const name   = `${a.timeLog.user?.profile?.lastName}, ${a.timeLog.user?.profile?.firstName}`;
      console.log(`  ${date}  ${name.padEnd(24)} ${a.timeLog.punchType.padEnd(16)} actual=${actual}h → net=${net}h`);
    }
    if (toFix.length > 15) console.log(`  ... and ${toFix.length - 15} more`);
    console.log(`\n⚠️   DRY RUN — no changes made.`);
    console.log(`    Re-run with:  DRY_RUN=false node scripts/backfill-driver-regular-segment-cap.js`);
    return;
  }

  // ── 5. Apply patches ────────────────────────────────────────────────────────
  console.log(`── Patching ${toFix.length} records…`);
  let patched = 0;
  for (const a of toFix) {
    const net = parseFloat(parseFloat(a.timeLog.netWorkedHours?.toString() ?? 0).toFixed(2));
    await prisma.timeLogApproval.update({
      where: { id: a.id },
      data:  { actualHours: net },
    });
    patched++;
  }
  console.log(`✅  ${patched} records patched.\n`);

  // ── 6. Recompute OT for all affected employees ─────────────────────────────
  const affectedUserIds = [...new Set(toFix.map(a => a.timeLog.userId))];
  console.log(`── Recomputing OT for ${affectedUserIds.length} employee(s)…`);
  for (const userId of affectedUserIds) {
    try {
      await computeOtForCutoffBasis(cutoffPeriodId, userId, company.id);
      const name = Object.values(byEmp).find(e => e.records[0]?.timeLog.userId === userId)?.name ?? userId;
      console.log(`  ✅  ${name}`);
    } catch (err) {
      console.error(`  ❌  OT recompute failed for ${userId}:`, err.message);
    }
  }

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  Done. Refresh the cutoff view to see updated totals.`);
  console.log(`${"═".repeat(64)}\n`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
