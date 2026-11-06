// scripts/fix-bb062-remove-arlene-missing-clockout.js
//
// BB-062 — Delete Arlene Backeng's orphaned 07/27/2026 TimeLog record
// (timeIn 2026-07-27T15:05:53.074Z, status=true, timeOut=null). Confirmed by
// scripts/check-bb062-arlene-missing-clockout.js: no LiveUser row exists for
// her at all, so this session is unreachable by the auto-close cron
// (autoClockOutJob.js) and can never be approved as-is.
//
// This script targets EXACTLY that one confirmed record by id — it does not
// re-derive "whichever open record exists" — and re-verifies its state
// (status=true, timeOut=null, correct user) immediately before deleting, so
// it refuses to act if something about the record has already changed.
//
// Cascade-deleted automatically by the DB (onDelete: Cascade in schema):
//   LiveUser, TimeLogApproval, ContestTimeLog, Overtime rows tied to this
//   TimeLog. (Confirmed via check script: none currently exist for this
//   record, so no cascade deletions are expected — but the script checks
//   and reports them regardless, in case that's changed since.)
// NOT cascaded (FK is nullable, no onDelete rule → set to NULL instead):
//   RequestedTimeLog.createdTimeLogId, if any request row was created from
//   this TimeLog.
//
// Usage:
//   node scripts/fix-bb062-remove-arlene-missing-clockout.js            (dry run — prints only, no writes)
//   node scripts/fix-bb062-remove-arlene-missing-clockout.js --apply    (writes a backup JSON, then deletes)
//   node scripts/fix-bb062-remove-arlene-missing-clockout.js --revert   (restores from the backup JSON)

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TARGET_TIMELOG_ID = "cms3d0g900qq0t051h43yvmrd";
const FIRST_NAME = "Arlene";
const LAST_NAME = "Backeng";

const BACKUP_FILE = path.join(__dirname, "backup-bb062-arlene-missing-clockout.json");

const DRY_RUN = !process.argv.includes("--apply") && !process.argv.includes("--revert");
const REVERT = process.argv.includes("--revert");

// Scalar (non-relation) TimeLog columns — used to rebuild the row on revert.
const TIMELOG_SCALAR_FIELDS = [
  "id", "userId", "timeIn", "timeOut", "coffeeBreaks", "lunchBreak",
  "deviceInfo", "location", "status", "createdAt", "updatedAt", "lateHours",
  "contestedPolicyApproved", "originalTimeIn", "originalTimeOut",
  "isApproved", "punchType", "remarks", "autoClockOut", "autoClockOutAt",
  "autoLunchDeductionMinutes", "autoLunchApplied", "autoCoffeeApplied",
  "undertimeHours", "netWorkedHours", "lunchDeductionMinutes",
  "totalBreakMinutes", "regularSegmentHours", "driverAmSegmentHours",
  "driverPmSegmentHours", "rawOtMinutes", "scheduledHours", "grossHours",
  "calculatedAt", "isTooEarlyPunch",
];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

async function gatherRelated(timeLogId) {
  const [liveUser, approvals, contests, overtimeRows, referencingRequests] = await Promise.all([
    prisma.liveUser.findUnique({ where: { timeLogId } }),
    prisma.timeLogApproval.findMany({ where: { timeLogId } }),
    prisma.contestTimeLog.findMany({ where: { timeLogId } }),
    prisma.overtime.findMany({ where: { timeLogId } }),
    prisma.requestedTimeLog.findMany({ where: { createdTimeLogId: timeLogId } }),
  ]);
  return { liveUser, approvals, contests, overtimeRows, referencingRequests };
}

function printRelated(related) {
  console.log(`  LiveUser row: ${related.liveUser ? related.liveUser.id : "none"}`);
  console.log(`  TimeLogApproval rows: ${related.approvals.length}`);
  console.log(`  ContestTimeLog rows: ${related.contests.length}`);
  console.log(`  Overtime rows: ${related.overtimeRows.length}`);
  console.log(
    `  RequestedTimeLog rows referencing this as createdTimeLogId: ${related.referencingRequests.length}` +
      (related.referencingRequests.length
        ? ` (ids: ${related.referencingRequests.map((r) => r.id).join(", ")} — will have createdTimeLogId set to NULL, not deleted)`
        : "")
  );
}

async function runApply() {
  const user = await prisma.user.findFirst({
    where: {
      profile: {
        firstName: { equals: FIRST_NAME, mode: "insensitive" },
        lastName: { equals: LAST_NAME, mode: "insensitive" },
      },
    },
  });
  if (!user) {
    console.log(`No user found matching "${FIRST_NAME} ${LAST_NAME}". Aborting.`);
    return;
  }

  const timeLog = await prisma.timeLog.findUnique({ where: { id: TARGET_TIMELOG_ID } });
  if (!timeLog) {
    console.log(`TimeLog ${TARGET_TIMELOG_ID} no longer exists. Nothing to do. Aborting.`);
    return;
  }
  if (timeLog.userId !== user.id || timeLog.status !== true || timeLog.timeOut !== null) {
    console.log("Record state no longer matches what was confirmed. Refusing to act.");
    console.log(`  userId matches: ${timeLog.userId === user.id}`);
    console.log(`  status: ${timeLog.status} (expected true)`);
    console.log(`  timeOut: ${timeLog.timeOut} (expected null)`);
    console.log("Re-run scripts/check-bb062-arlene-missing-clockout.js to re-confirm before retrying.");
    return;
  }

  const related = await gatherRelated(TARGET_TIMELOG_ID);

  console.log("=== About to delete ===");
  console.log(`  TimeLog ${timeLog.id} — timeIn ${timeLog.timeIn.toISOString()}, user ${user.email}`);
  printRelated(related);

  if (DRY_RUN) {
    console.log("\nDry run only — no changes made. Re-run with --apply to execute.");
    return;
  }

  const backup = {
    deletedAt: new Date().toISOString(),
    timeLog,
    liveUser: related.liveUser,
    approvals: related.approvals,
    contests: related.contests,
    overtimeRows: related.overtimeRows,
    referencingRequestIds: related.referencingRequests.map((r) => r.id),
  };
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written to ${BACKUP_FILE}`);

  await prisma.timeLog.delete({ where: { id: TARGET_TIMELOG_ID } });
  console.log(`Deleted TimeLog ${TARGET_TIMELOG_ID}.`);
}

async function runRevert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup file at ${BACKUP_FILE}. Nothing to revert.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));

  const existing = await prisma.timeLog.findUnique({ where: { id: backup.timeLog.id } });
  if (existing) {
    console.log(`TimeLog ${backup.timeLog.id} already exists — revert already applied, or record was recreated separately. Aborting.`);
    return;
  }

  await prisma.timeLog.create({ data: pick(backup.timeLog, TIMELOG_SCALAR_FIELDS) });
  console.log(`Restored TimeLog ${backup.timeLog.id}.`);

  if (backup.liveUser) {
    await prisma.liveUser.create({
      data: pick(backup.liveUser, [
        "id", "userId", "companyId", "timeLogId", "scheduledEnd",
        "warnAt", "closeAt", "warningSent", "createdAt",
      ]),
    });
    console.log(`Restored LiveUser ${backup.liveUser.id}.`);
  }
  for (const a of backup.approvals || []) {
    await prisma.timeLogApproval.create({ data: a });
    console.log(`Restored TimeLogApproval ${a.id}.`);
  }
  for (const c of backup.contests || []) {
    await prisma.contestTimeLog.create({ data: c });
    console.log(`Restored ContestTimeLog ${c.id}.`);
  }
  for (const o of backup.overtimeRows || []) {
    await prisma.overtime.create({ data: o });
    console.log(`Restored Overtime ${o.id}.`);
  }
  if ((backup.referencingRequestIds || []).length) {
    await prisma.requestedTimeLog.updateMany({
      where: { id: { in: backup.referencingRequestIds } },
      data: { createdTimeLogId: backup.timeLog.id },
    });
    console.log(`Re-linked ${backup.referencingRequestIds.length} RequestedTimeLog row(s) back to the restored TimeLog.`);
  }

  console.log("\nRevert complete.");
}

async function main() {
  if (REVERT) {
    await runRevert();
  } else {
    await runApply();
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
