// scripts/fix-alec-duna-aug28-remove-lunch.js
//
// TimeLog cmtd3l8jn02ztrj4zgyg5o7yf (Alec Duna, 2026-08-28, REGULAR punch) has
// lunchBreak = { start: 2026-08-28T15:20:36.176Z, end: 2026-08-28T20:34:45.783Z }
// — starting ~52s after clock-in and ending ~14s before clock-out, spanning
// 314.2 of the 315-minute shift. That produced netWorkedHours=0.02h on a
// shift that was almost certainly worked normally (lunch punch mistimed/
// accidental, not a real break).
//
// Per user decision: treat this as a clean punch with no lunch break at all.
//
// This script:
//   1. Clears TimeLog.lunchBreak to null.
//   2. Sets TimeLog.autoLunchDeductionMinutes = 0 (explicit "no lunch deducted"
//      marker — matches the BB-065 fix convention — so this stays correct even
//      if the company's minimumLunchMinutes changes later; it's currently 0
//      for Piedmont Adult Day Program, which is why clearing lunchBreak alone
//      would also land on a 0-minute deduction today).
//   3. Calls computeTimeLogSummary(TIMELOG_ID) to recompute netWorkedHours and
//      all other derived fields for real, instead of hand-computing them.
//
// The TimeLogApproval on this TimeLog is still "pending" (not yet approved),
// so no approval/cutoff sync-back is needed — the corrected netWorkedHours
// will simply be what gets approved.
//
// Usage:
//   node scripts/fix-alec-duna-aug28-remove-lunch.js           -> dry run (prints only)
//   node scripts/fix-alec-duna-aug28-remove-lunch.js --apply   -> writes for real
//   node scripts/fix-alec-duna-aug28-remove-lunch.js --revert  -> restores from backup JSON

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();

const TIMELOG_ID = "cmtd3l8jn02ztrj4zgyg5o7yf";
const EXPECTED_LUNCH_START = "2026-08-28T15:20:36.176Z";
const EXPECTED_LUNCH_END = "2026-08-28T20:34:45.783Z";
const BACKUP_FILE = path.join(__dirname, "backup-alec-duna-aug28-remove-lunch.json");

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
      lunchBreak: backup.timeLog.lunchBreak,
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

  console.log(`Reverted TimeLog ${TIMELOG_ID} to its pre-fix state (lunchBreak and derived fields restored).`);
}

async function main() {
  if (REVERT) {
    await revert();
    return;
  }

  console.log(DRY_RUN ? "DRY RUN — pass --apply to write changes\n" : "APPLYING changes\n");

  const timeLog = await prisma.timeLog.findUnique({ where: { id: TIMELOG_ID } });
  if (!timeLog) {
    console.log(`No TimeLog found with id ${TIMELOG_ID}. Aborting.`);
    return;
  }

  const lb = timeLog.lunchBreak;
  const matchesExpected =
    lb && lb.start === EXPECTED_LUNCH_START && lb.end === EXPECTED_LUNCH_END;

  if (!matchesExpected) {
    console.log(
      `TimeLog ${TIMELOG_ID}.lunchBreak no longer matches the expected value from the diagnostic ` +
        `(found: ${JSON.stringify(lb)}) — aborting rather than guessing.`
    );
    return;
  }

  console.log("=== Current state ===");
  console.log(`  lunchBreak: ${JSON.stringify(lb)}`);
  console.log(`  autoLunchDeductionMinutes: ${timeLog.autoLunchDeductionMinutes ?? "null"}`);
  console.log(`  lunchDeductionMinutes: ${timeLog.lunchDeductionMinutes ?? "null"}`);
  console.log(`  netWorkedHours: ${fmtHours(timeLog.netWorkedHours)}  grossHours: ${fmtHours(timeLog.grossHours)}`);

  console.log("\n=== Planned changes ===");
  console.log(`  lunchBreak -> null`);
  console.log(`  autoLunchDeductionMinutes -> 0 (explicit no-lunch marker)`);
  console.log(`  Then run computeTimeLogSummary(${TIMELOG_ID}) to recompute netWorkedHours and related fields.`);

  if (DRY_RUN) {
    console.log("\nDry run only — no changes written. Re-run with --apply to write.");
    return;
  }

  // ── Backup before writing ────────────────────────────────────────────────
  fs.writeFileSync(
    BACKUP_FILE,
    JSON.stringify(
      {
        timeLog: {
          id: TIMELOG_ID,
          lunchBreak: timeLog.lunchBreak,
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
    data: { lunchBreak: null, autoLunchDeductionMinutes: 0 },
  });

  const derived = await computeTimeLogSummary(TIMELOG_ID);

  console.log("\n=== After ===");
  console.log(`  computeTimeLogSummary returned: ${JSON.stringify(derived, null, 2)}`);

  const finalTimeLog = await prisma.timeLog.findUnique({ where: { id: TIMELOG_ID } });
  console.log(`\n  TimeLog.lunchBreak: ${JSON.stringify(finalTimeLog.lunchBreak)}`);
  console.log(`  TimeLog.netWorkedHours: ${fmtHours(finalTimeLog.netWorkedHours)}`);
  console.log(`  TimeLog.lunchDeductionMinutes: ${finalTimeLog.lunchDeductionMinutes ?? "null"}`);
  console.log("\nDone. Verify netWorkedHours now reflects the full shift before approving.");
  console.log(`To undo: node scripts/fix-alec-duna-aug28-remove-lunch.js --revert`);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
