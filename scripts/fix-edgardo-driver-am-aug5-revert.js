// scripts/fix-edgardo-driver-am-aug5-revert.js
//
// Reverts Edgardo Nuestro's (ednuestro58@yahoo.com) Aug 5, 2026 Driver AM
// TimeLogApproval segment from "excluded" back to "pending" — the same
// data-level effect as the existing Reset button (PATCH
// /api/cutoff-periods/:id/approvals/:approvalId/reset -> resetApproval,
// src/controllers/Features/cutoffPeriodController.js:1854-1935), which
// already supports resetting "excluded" rows. The Driver AM row has no
// Reset button in the UI (a frontend-only display gap), so this replicates
// that endpoint's exact steps directly against this one row:
//   1. Refuse if the CutoffPeriod is locked/processed.
//   2. Refuse unless current status is "excluded".
//   3. Restore TimeLog.timeIn/timeOut from originalTimeIn/originalTimeOut
//      (if set) and set isApproved: false.
//   4. Re-run computeTimeLogSummary(timeLogId) to restore segment-hours fields.
//   5. Reset the TimeLogApproval row to a blank pending state.
//   6. Recompute OT for that day via recomputeOtForTimeLog.
//
// Run scripts/check-edgardo-driver-am-aug5.js first and review its output —
// this script re-resolves the same record dynamically (by email + date +
// segmentType) and aborts rather than guessing if more than one candidate
// TimeLog/approval is found, or if the state doesn't match what's expected.
//
// Usage:
//   node scripts/fix-edgardo-driver-am-aug5-revert.js           -> dry run (prints only)
//   node scripts/fix-edgardo-driver-am-aug5-revert.js --apply   -> writes for real
//   node scripts/fix-edgardo-driver-am-aug5-revert.js --revert  -> restores from backup JSON

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");
const { recomputeOtForTimeLog } = require("@services/Cutoff/cutoffOtService");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();

const EMPLOYEE_EMAIL = "ednuestro58@yahoo.com";
const TARGET_DATE = "2026-08-05";
const BACKUP_FILE = path.join(__dirname, "backup-edgardo-driver-am-aug5-revert.json");

const DRY_RUN = !process.argv.includes("--apply") && !process.argv.includes("--revert");
const REVERT = process.argv.includes("--revert");

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtHours(n) {
  if (n === null || n === undefined) return "null";
  return `${Number(n)}h`;
}

async function resolveTarget() {
  const user = await prisma.user.findFirst({
    where: { email: { equals: EMPLOYEE_EMAIL, mode: "insensitive" } },
    select: { id: true, companyId: true },
  });
  if (!user) throw new Error(`No User found with email ${EMPLOYEE_EMAIL}.`);

  const company = await prisma.company.findUnique({
    where: { id: user.companyId },
    select: { timeZone: true },
  });
  const companyTz = company?.timeZone || "America/Los_Angeles";
  const dayStart = moment.tz(TARGET_DATE, companyTz).startOf("day").toDate();
  const dayEnd = moment.tz(TARGET_DATE, companyTz).endOf("day").toDate();

  const timeLogs = await prisma.timeLog.findMany({
    where: { userId: user.id, timeIn: { gte: dayStart, lte: dayEnd } },
    select: { id: true, timeIn: true, originalTimeIn: true, originalTimeOut: true },
  });
  if (timeLogs.length !== 1) {
    throw new Error(
      `Expected exactly 1 TimeLog for ${EMPLOYEE_EMAIL} on ${TARGET_DATE}, found ${timeLogs.length}. Aborting rather than guessing.`
    );
  }
  const timeLog = timeLogs[0];

  const approvals = await prisma.timeLogApproval.findMany({
    where: { timeLogId: timeLog.id, segmentType: "driver_am" },
    include: { cutoffPeriod: { select: { id: true, status: true } } },
  });
  if (approvals.length !== 1) {
    throw new Error(
      `Expected exactly 1 driver_am TimeLogApproval for TimeLog ${timeLog.id}, found ${approvals.length}. Aborting rather than guessing.`
    );
  }
  const approval = approvals[0];

  return { user, companyId: user.companyId, timeLog, approval };
}

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup file found at ${BACKUP_FILE}. Run without --apply first, then --apply, before reverting.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));

  await prisma.timeLog.update({
    where: { id: backup.timeLog.id },
    data: {
      timeIn: backup.timeLog.timeIn,
      timeOut: backup.timeLog.timeOut,
      isApproved: backup.timeLog.isApproved,
      netWorkedHours: backup.timeLog.netWorkedHours,
      driverAmSegmentHours: backup.timeLog.driverAmSegmentHours,
      regularSegmentHours: backup.timeLog.regularSegmentHours,
      driverPmSegmentHours: backup.timeLog.driverPmSegmentHours,
      rawOtMinutes: backup.timeLog.rawOtMinutes,
      scheduledHours: backup.timeLog.scheduledHours,
      grossHours: backup.timeLog.grossHours,
      lateHours: backup.timeLog.lateHours,
      undertimeHours: backup.timeLog.undertimeHours,
      lunchDeductionMinutes: backup.timeLog.lunchDeductionMinutes,
      totalBreakMinutes: backup.timeLog.totalBreakMinutes,
      autoLunchDeductionMinutes: backup.timeLog.autoLunchDeductionMinutes,
      calculatedAt: backup.timeLog.calculatedAt,
    },
  });

  await prisma.timeLogApproval.update({
    where: { id: backup.approval.id },
    data: {
      status: backup.approval.status,
      actualHours: backup.approval.actualHours,
      approvedClockIn: backup.approval.approvedClockIn,
      approvedClockOut: backup.approval.approvedClockOut,
      approvedBy: backup.approval.approvedBy,
      approvedAt: backup.approval.approvedAt,
      editedHours: backup.approval.editedHours,
      scheduledHours: backup.approval.scheduledHours,
      notes: backup.approval.notes,
    },
  });

  console.log(`Reverted TimeLog ${backup.timeLog.id} and TimeLogApproval ${backup.approval.id} to their pre-fix (excluded) state.`);
}

async function main() {
  if (REVERT) {
    await revert();
    return;
  }

  console.log(DRY_RUN ? "DRY RUN — pass --apply to write changes\n" : "APPLYING changes\n");

  const { companyId, timeLog: tlSlim, approval } = await resolveTarget();

  if (approval.status !== "excluded") {
    console.log(
      `TimeLogApproval ${approval.id} has status "${approval.status}", not "excluded" — ` +
        `already resolved, or state has changed since this script was written. Aborting.`
    );
    return;
  }
  if (approval.cutoffPeriod && (approval.cutoffPeriod.status === "locked" || approval.cutoffPeriod.status === "processed")) {
    console.log(
      `Cutoff period ${approval.cutoffPeriod.id} is "${approval.cutoffPeriod.status}" — resetApproval refuses to ` +
        `touch approvals in a locked/processed cutoff period, so this script does too. Aborting.`
    );
    return;
  }

  const timeLog = await prisma.timeLog.findUnique({ where: { id: tlSlim.id } });

  console.log("=== Current state ===");
  console.log(`  TimeLogApproval ${approval.id} (segmentType: driver_am)`);
  console.log(`    status: ${approval.status}  notes: "${approval.notes || "—"}"`);
  console.log(`    approvedBy: ${approval.approvedBy || "—"}  approvedAt: ${fmt(approval.approvedAt)}`);
  console.log(`  TimeLog ${timeLog.id}`);
  console.log(`    timeIn: ${fmt(timeLog.timeIn)}  timeOut: ${fmt(timeLog.timeOut)}`);
  console.log(`    originalTimeIn: ${fmt(timeLog.originalTimeIn)}  originalTimeOut: ${fmt(timeLog.originalTimeOut)}`);
  console.log(`    isApproved: ${timeLog.isApproved}`);
  console.log(`    netWorkedHours: ${fmtHours(timeLog.netWorkedHours)}  driverAmSegmentHours: ${fmtHours(timeLog.driverAmSegmentHours)}`);

  console.log("\n=== Planned changes (mirrors resetApproval) ===");
  console.log(`  1. TimeLog.timeIn/timeOut <- originalTimeIn/originalTimeOut (if set), isApproved -> false`);
  console.log(`  2. Recompute TimeLog via computeTimeLogSummary(${timeLog.id})`);
  console.log(`  3. TimeLogApproval ${approval.id} -> status: "pending", clear actualHours/approvedClockIn/approvedClockOut/approvedBy/approvedAt/editedHours/scheduledHours`);
  console.log(`  4. Recompute OT via recomputeOtForTimeLog(${timeLog.id}, ${approval.cutoffPeriod?.id}, ${companyId})`);

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
          id: timeLog.id,
          timeIn: timeLog.timeIn,
          timeOut: timeLog.timeOut,
          isApproved: timeLog.isApproved,
          netWorkedHours: timeLog.netWorkedHours,
          driverAmSegmentHours: timeLog.driverAmSegmentHours,
          regularSegmentHours: timeLog.regularSegmentHours,
          driverPmSegmentHours: timeLog.driverPmSegmentHours,
          rawOtMinutes: timeLog.rawOtMinutes,
          scheduledHours: timeLog.scheduledHours,
          grossHours: timeLog.grossHours,
          lateHours: timeLog.lateHours,
          undertimeHours: timeLog.undertimeHours,
          lunchDeductionMinutes: timeLog.lunchDeductionMinutes,
          totalBreakMinutes: timeLog.totalBreakMinutes,
          autoLunchDeductionMinutes: timeLog.autoLunchDeductionMinutes,
          calculatedAt: timeLog.calculatedAt,
        },
        approval: {
          id: approval.id,
          status: approval.status,
          actualHours: approval.actualHours,
          approvedClockIn: approval.approvedClockIn,
          approvedClockOut: approval.approvedClockOut,
          approvedBy: approval.approvedBy,
          approvedAt: approval.approvedAt,
          editedHours: approval.editedHours,
          scheduledHours: approval.scheduledHours,
          notes: approval.notes,
        },
      },
      null,
      2
    )
  );
  console.log(`\nBackup written to ${BACKUP_FILE}`);

  // ── Apply — mirrors resetApproval exactly ───────────────────────────────
  if (timeLog.originalTimeIn) {
    await prisma.timeLog.update({
      where: { id: timeLog.id },
      data: { timeIn: timeLog.originalTimeIn, timeOut: timeLog.originalTimeOut, isApproved: false },
    });
  } else {
    await prisma.timeLog.update({ where: { id: timeLog.id }, data: { isApproved: false } });
  }

  try {
    await computeTimeLogSummary(timeLog.id);
  } catch (e) {
    console.error("Recompute failed after TimeLog restore:", e.message);
  }

  const updated = await prisma.timeLogApproval.update({
    where: { id: approval.id },
    data: {
      status: "pending",
      actualHours: null,
      approvedClockIn: null,
      approvedClockOut: null,
      approvedBy: null,
      approvedAt: null,
      editedHours: null,
      scheduledHours: null,
    },
  });

  if (approval.cutoffPeriod?.id) {
    try {
      await recomputeOtForTimeLog(timeLog.id, approval.cutoffPeriod.id, companyId);
    } catch (e) {
      console.error("OT recompute failed after reset:", e.message);
    }
  }

  console.log("\n=== After ===");
  const finalTimeLog = await prisma.timeLog.findUnique({ where: { id: timeLog.id } });
  console.log(`  TimeLogApproval ${updated.id} status: ${updated.status}`);
  console.log(`  TimeLog.netWorkedHours: ${fmtHours(finalTimeLog.netWorkedHours)}  driverAmSegmentHours: ${fmtHours(finalTimeLog.driverAmSegmentHours)}`);
  console.log("\nDone. The Driver AM segment is back to pending and needs a fresh Approve/Exclude decision through the cutoff-review screen.");
  console.log(`To undo: node scripts/fix-edgardo-driver-am-aug5-revert.js --revert`);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
