// scripts/fix-bb065-arlene-jul29-recompute.js
//
// BB-065 — First staged backfill record: RequestedTimeLog 433f297e-7981-4881-817f-d55289a1f40b
// (Arlene Backeng, requestedDate 2026-07-29, reason "forgot_to_clock", status APPROVED,
// approvedAt 2026-08-04) -> linked TimeLog cmsf9f4as0mktrl51d4sok3eg.
//
// Two separate things are wrong on this one record:
//   1. RequestedTimeLog.estimatedNetHours is stale (4.5h, from the old "always deduct
//      minimumLunchMinutes" formula) — cosmetic only, doesn't feed payroll once approved.
//   2. TimeLog.netWorkedHours is NULL — never computed at all. This IS the real,
//      payroll-facing gap (approveRequestedPunchLog didn't call computeTimeLogSummary
//      before today's BB-065 fix).
//
// This script fixes BOTH on this single record, as the first verification step before
// broadening to the other 6 NEVER_COMPUTED rows found by
// check-bb065-request-punch-lunch-deduction-scope.js:
//   - Sets TimeLog.autoLunchDeductionMinutes = 0 (per the BB-065 policy: a manually
//     requested/approved punch takes the claimed span at face value, no assumed lunch).
//   - Calls computeTimeLogSummary(TIMELOG_ID) to populate netWorkedHours etc. for real.
//   - Updates RequestedTimeLog.estimatedDuration/estimatedNetHours to match, for
//     audit-trail consistency.
//
// Usage:
//   node scripts/fix-bb065-arlene-jul29-recompute.js           -> dry run (prints only)
//   node scripts/fix-bb065-arlene-jul29-recompute.js --apply   -> writes for real
//   node scripts/fix-bb065-arlene-jul29-recompute.js --revert  -> restores from backup JSON

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();

const REQUEST_ID = "433f297e-7981-4881-817f-d55289a1f40b";
const TIMELOG_ID = "cmsf9f4as0mktrl51d4sok3eg";
const BACKUP_FILE = path.join(__dirname, "backup-bb065-arlene-jul29-recompute.json");

const DRY_RUN = !process.argv.includes("--apply") && !process.argv.includes("--revert");
const REVERT = process.argv.includes("--revert");

function fmtHours(n) {
  return n === null || n === undefined ? "null" : `${n}h`;
}

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup file found at ${BACKUP_FILE}. Run without --apply first, then --apply, before reverting.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));

  await prisma.timeLog.update({
    where: { id: TIMELOG_ID },
    data: {
      autoLunchDeductionMinutes: backup.timeLog.autoLunchDeductionMinutes,
      netWorkedHours: backup.timeLog.netWorkedHours,
      lateHours: backup.timeLog.lateHours,
      undertimeHours: backup.timeLog.undertimeHours,
      lunchDeductionMinutes: backup.timeLog.lunchDeductionMinutes,
      totalBreakMinutes: backup.timeLog.totalBreakMinutes,
      regularSegmentHours: backup.timeLog.regularSegmentHours,
      driverAmSegmentHours: backup.timeLog.driverAmSegmentHours,
      driverPmSegmentHours: backup.timeLog.driverPmSegmentHours,
      rawOtMinutes: backup.timeLog.rawOtMinutes,
      scheduledHours: backup.timeLog.scheduledHours,
      grossHours: backup.timeLog.grossHours,
      isTooEarlyPunch: backup.timeLog.isTooEarlyPunch,
      calculatedAt: backup.timeLog.calculatedAt,
    },
  });

  await prisma.requestedTimeLog.update({
    where: { id: REQUEST_ID },
    data: {
      estimatedDuration: backup.requestedTimeLog.estimatedDuration,
      estimatedNetHours: backup.requestedTimeLog.estimatedNetHours,
    },
  });

  console.log(`Reverted TimeLog ${TIMELOG_ID} and RequestedTimeLog ${REQUEST_ID} to their pre-fix state.`);
}

async function main() {
  if (REVERT) {
    await revert();
    return;
  }

  console.log(DRY_RUN ? "DRY RUN — pass --apply to write changes\n" : "APPLYING changes\n");

  const request = await prisma.requestedTimeLog.findUnique({ where: { id: REQUEST_ID } });
  if (!request) {
    console.log(`No RequestedTimeLog found with id ${REQUEST_ID}. Aborting.`);
    return;
  }
  if (request.status !== "APPROVED" || request.createdTimeLogId !== TIMELOG_ID) {
    console.log(
      `RequestedTimeLog ${REQUEST_ID} no longer matches expectations ` +
        `(status=${request.status}, createdTimeLogId=${request.createdTimeLogId}) — aborting rather than guessing.`
    );
    return;
  }

  const timeLog = await prisma.timeLog.findUnique({ where: { id: TIMELOG_ID } });
  if (!timeLog) {
    console.log(`No TimeLog found with id ${TIMELOG_ID}. Aborting.`);
    return;
  }
  if (timeLog.netWorkedHours !== null) {
    console.log(
      `TimeLog ${TIMELOG_ID} already has netWorkedHours=${fmtHours(timeLog.netWorkedHours)} — ` +
        `already computed, nothing to do here. Re-run the diagnostic if this is unexpected.`
    );
    return;
  }

  const grossMinutes = Math.round(
    (new Date(request.requestedClockOut).getTime() - new Date(request.requestedClockIn).getTime()) / 60000
  );
  const correctedNetHours = +(grossMinutes / 60).toFixed(2);

  console.log("=== Current state ===");
  console.log(`  RequestedTimeLog.estimatedDuration: ${request.estimatedDuration} min  estimatedNetHours: ${fmtHours(request.estimatedNetHours)}`);
  console.log(`  TimeLog.autoLunchDeductionMinutes: ${timeLog.autoLunchDeductionMinutes ?? "null"}`);
  console.log(`  TimeLog.netWorkedHours: ${fmtHours(timeLog.netWorkedHours)}  calculatedAt: ${timeLog.calculatedAt || "null"}`);

  console.log("\n=== Planned changes ===");
  console.log(`  RequestedTimeLog.estimatedDuration -> ${grossMinutes} min, estimatedNetHours -> ${correctedNetHours}h`);
  console.log(`  TimeLog.autoLunchDeductionMinutes -> 0 (no assumed lunch, per BB-065 policy)`);
  console.log(`  Then run computeTimeLogSummary(${TIMELOG_ID}) to populate netWorkedHours and related fields for real.`);

  if (DRY_RUN) {
    console.log("\nDry run only — no changes written. Re-run with --apply to write.");
    return;
  }

  // ── Backup before writing ────────────────────────────────────────────────
  fs.writeFileSync(
    BACKUP_FILE,
    JSON.stringify(
      {
        requestedTimeLog: { id: REQUEST_ID, estimatedDuration: request.estimatedDuration, estimatedNetHours: request.estimatedNetHours },
        timeLog: {
          id: TIMELOG_ID,
          autoLunchDeductionMinutes: timeLog.autoLunchDeductionMinutes,
          netWorkedHours: timeLog.netWorkedHours,
          lateHours: timeLog.lateHours,
          undertimeHours: timeLog.undertimeHours,
          lunchDeductionMinutes: timeLog.lunchDeductionMinutes,
          totalBreakMinutes: timeLog.totalBreakMinutes,
          regularSegmentHours: timeLog.regularSegmentHours,
          driverAmSegmentHours: timeLog.driverAmSegmentHours,
          driverPmSegmentHours: timeLog.driverPmSegmentHours,
          rawOtMinutes: timeLog.rawOtMinutes,
          scheduledHours: timeLog.scheduledHours,
          grossHours: timeLog.grossHours,
          isTooEarlyPunch: timeLog.isTooEarlyPunch,
          calculatedAt: timeLog.calculatedAt,
        },
      },
      null,
      2
    )
  );
  console.log(`\nBackup written to ${BACKUP_FILE}`);

  // ── Apply ─────────────────────────────────────────────────────────────────
  await prisma.timeLog.update({
    where: { id: TIMELOG_ID },
    data: { autoLunchDeductionMinutes: 0 },
  });

  const derived = await computeTimeLogSummary(TIMELOG_ID);

  await prisma.requestedTimeLog.update({
    where: { id: REQUEST_ID },
    data: { estimatedDuration: grossMinutes, estimatedNetHours: correctedNetHours },
  });

  console.log("\n=== After ===");
  console.log(`  computeTimeLogSummary returned: ${JSON.stringify(derived, null, 2)}`);

  const finalTimeLog = await prisma.timeLog.findUnique({ where: { id: TIMELOG_ID } });
  const finalRequest = await prisma.requestedTimeLog.findUnique({ where: { id: REQUEST_ID } });
  console.log(`\n  TimeLog.netWorkedHours: ${fmtHours(finalTimeLog.netWorkedHours)}`);
  console.log(`  RequestedTimeLog.estimatedNetHours: ${fmtHours(finalRequest.estimatedNetHours)}`);
  console.log("\nDone. Verify this looks right before broadening to the other 6 NEVER_COMPUTED rows.");
  console.log(`To undo: node scripts/fix-bb065-arlene-jul29-recompute.js --revert`);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
