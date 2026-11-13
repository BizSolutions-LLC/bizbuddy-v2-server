// scripts/fix-bb124-josie-nov9-exclude-punch.js
//
// BB-124 — Josie Soriano (Piedmont Adult Day Program), Nov 9 2026.
// Her Driver/Aide punch (raw 6:51 AM → 2:45 PM, kept in originalTimeIn/Out)
// conflicted with an approved full-day Sick Leave. The conflict was resolved
// as "Honor Punch" by the non-segment-aware resolveConflict path, which
// rewrote the TimeLog to 6:45 → 8:00 AM and approved all 3 segments, while
// the leave lookup (BB-073 bug) failed, so the leave also stayed approved.
//
// Decision (2026-11-13): leave takes precedence. Exclude the punch, keep the
// sick leave exactly as it is (8h already deducted — no ledger change).
//
// What --apply writes (one transaction):
//   - TimeLog: timeIn/timeOut ← originalTimeIn/originalTimeOut (raw punch),
//     isApproved = false; driverAm/regular/driverPm segment hours = 0,
//     netWorkedHours = 0, rawOtMinutes = 0 — the same values
//     syncApprovedSegmentsToTimeLog writes when every segment is excluded.
//   - The 3 TimeLogApprovals: status "excluded", approvedClockIn/Out,
//     scheduledHours and actualHours cleared, note below. Same end state as
//     the Honor Leave button.
// Not touched: the Leave, its LeaveTransaction ledger, CutoffOtBlock rows
// (any OT block for that day is printed — exclude it in the UI if one shows).
//
// Safety checks before --apply:
//   - exactly one Driver/Aide TimeLog for Josie on Nov 9 (company zone)
//   - originalTimeIn/Out both present
//   - exactly 3 approvals, all in an open (not locked/processed) cutoff
//   - an approved Leave covers Nov 9
//   - the backup file doesn't exist yet
//
// Backup: scripts/backup-bb124-josie-nov9.json (previous TimeLog + approval
// fields), used by --revert.
//
// Usage:
//   node scripts/fix-bb124-josie-nov9-exclude-punch.js            # dry run
//   node scripts/fix-bb124-josie-nov9-exclude-punch.js --apply
//   node scripts/fix-bb124-josie-nov9-exclude-punch.js --revert   # restores from the backup

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const EMPLOYEE_EMAIL = "josiesoriano1225@gmail.com";
const LOCAL_DATE = "2026-11-09";
const NOTE = "BB-124: leave takes precedence (manual fix)";
const BACKUP_FILE = path.join(__dirname, "backup-bb124-josie-nov9.json");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

const TL_FIELDS = {
  id: true, userId: true, punchType: true, timeIn: true, timeOut: true,
  originalTimeIn: true, originalTimeOut: true, isApproved: true,
  autoClockOut: true, autoClockOutAt: true,
  driverAmSegmentHours: true, regularSegmentHours: true, driverPmSegmentHours: true,
  netWorkedHours: true, rawOtMinutes: true,
};
const AP_FIELDS = {
  id: true, timeLogId: true, cutoffPeriodId: true, segmentType: true, status: true,
  approvedBy: true, approvedAt: true, notes: true,
  approvedClockIn: true, approvedClockOut: true, scheduledHours: true, actualHours: true,
  cutoffPeriod: { select: { id: true, status: true, periodStart: true, periodEnd: true } },
};

function fmt(d, tz) {
  return d ? moment.tz(d, tz).format("YYYY-MM-DD hh:mm A z") : "—";
}

async function loadState() {
  const company = await prisma.company.findUnique({
    where:  { id: COMPANY_ID },
    select: { id: true, name: true, timeZone: true, leaveConflictAutoRevert: true },
  });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found`);
  const tz = company.timeZone || "America/Los_Angeles";

  const users = await prisma.user.findMany({
    where:  { companyId: COMPANY_ID, email: { equals: EMPLOYEE_EMAIL, mode: "insensitive" } },
    select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
  });
  if (users.length !== 1) throw new Error(`Expected 1 user with ${EMPLOYEE_EMAIL} in PadPro, found ${users.length}`);
  const user = users[0];

  const dayStart = moment.tz(LOCAL_DATE, tz).startOf("day").toDate();
  const dayEnd   = moment.tz(LOCAL_DATE, tz).endOf("day").toDate();

  const timeLogs = await prisma.timeLog.findMany({
    where:   { userId: user.id, timeIn: { gte: dayStart, lte: dayEnd } },
    select:  TL_FIELDS,
    orderBy: { timeIn: "asc" },
  });

  const approvals = timeLogs.length === 1
    ? await prisma.timeLogApproval.findMany({ where: { timeLogId: timeLogs[0].id }, select: AP_FIELDS })
    : [];

  // Leave dates are calendar dates (stored around noon company time) — match by day string.
  const leaveCandidates = await prisma.leave.findMany({
    where: {
      userId:    user.id,
      startDate: { lte: moment.tz(LOCAL_DATE, tz).add(1, "day").endOf("day").toDate() },
      endDate:   { gte: moment.tz(LOCAL_DATE, tz).subtract(1, "day").startOf("day").toDate() },
    },
    select: {
      id: true, leaveType: true, status: true, isPaid: true, startDate: true, endDate: true,
      actualPaidHours: true, actualUnpaidHours: true, leaveReason: true,
    },
  });
  const leaves = leaveCandidates.filter((l) => {
    const s = l.startDate.toISOString().slice(0, 10);
    const e = l.endDate.toISOString().slice(0, 10);
    return LOCAL_DATE >= s && LOCAL_DATE <= e;
  });
  const ledger = leaves.length
    ? await prisma.leaveTransaction.findMany({
        where:   { leaveId: { in: leaves.map((l) => l.id) } },
        select:  { type: true, hours: true, balanceBefore: true, balanceAfter: true, note: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const otBlocks = await prisma.cutoffOtBlock.findMany({
    where:  { userId: user.id, date: new Date(`${LOCAL_DATE}T00:00:00.000Z`) },
    select: { id: true, cutoffPeriodId: true, otHours: true, status: true },
  });

  return { company, tz, user, timeLogs, approvals, leaves, ledger, otBlocks };
}

function printState(s) {
  const { company, tz, user, timeLogs, approvals, leaves, ledger, otBlocks } = s;
  const name = [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(" ");
  console.log(`Company: ${company.name} (${company.id}) tz=${tz} leaveConflictAutoRevert=${company.leaveConflictAutoRevert}`);
  console.log(`User:    ${name} <${user.email}> (${user.id})\n`);

  console.log(`TimeLogs on ${LOCAL_DATE}: ${timeLogs.length}`);
  for (const t of timeLogs) {
    console.log(`  ${t.id} ${t.punchType} isApproved=${t.isApproved} autoClockOut=${t.autoClockOut}`);
    console.log(`    current : ${fmt(t.timeIn, tz)} → ${fmt(t.timeOut, tz)}`);
    console.log(`    original: ${fmt(t.originalTimeIn, tz)} → ${fmt(t.originalTimeOut, tz)}`);
    console.log(`    hours   : AM=${t.driverAmSegmentHours} REG=${t.regularSegmentHours} PM=${t.driverPmSegmentHours} net=${t.netWorkedHours} rawOtMin=${t.rawOtMinutes}`);
  }

  console.log(`\nApprovals: ${approvals.length}`);
  for (const a of approvals) {
    console.log(`  ${a.id} ${a.segmentType ?? "(regular)"} status=${a.status} approvedBy=${a.approvedBy ?? "null"} cutoff=${a.cutoffPeriodId} (${a.cutoffPeriod?.status})`);
    console.log(`    approved: ${fmt(a.approvedClockIn, tz)} → ${fmt(a.approvedClockOut, tz)} sched=${a.scheduledHours} actual=${a.actualHours}`);
    console.log(`    notes   : ${a.notes ?? ""}`);
  }

  console.log(`\nLeaves covering ${LOCAL_DATE}: ${leaves.length}`);
  for (const l of leaves) {
    console.log(`  ${l.id} status=${l.status} isPaid=${l.isPaid} paid=${l.actualPaidHours} unpaid=${l.actualUnpaidHours} ${l.startDate.toISOString()} → ${l.endDate.toISOString()} "${l.leaveReason ?? ""}"`);
  }
  for (const x of ledger) {
    console.log(`    ledger ${x.createdAt.toISOString()} ${x.type} hours=${x.hours} ${x.balanceBefore}→${x.balanceAfter} ${x.note ?? ""}`);
  }

  console.log(`\nCutoffOtBlocks on ${LOCAL_DATE}: ${otBlocks.length}`);
  for (const b of otBlocks) console.log(`  ${b.id} cutoff=${b.cutoffPeriodId} ${b.otHours}h status=${b.status}`);
  console.log("");
}

function checkSafety(s) {
  const problems = [];
  if (s.timeLogs.length !== 1) problems.push(`expected 1 TimeLog, found ${s.timeLogs.length}`);
  const t = s.timeLogs[0];
  if (t && !String(t.punchType).startsWith("DRIVER_AIDE")) problems.push(`TimeLog punchType is ${t.punchType}, not Driver/Aide`);
  if (t && (!t.originalTimeIn || !t.originalTimeOut)) problems.push("originalTimeIn/Out missing — nothing to restore");
  if (s.approvals.length !== 3) problems.push(`expected 3 approvals, found ${s.approvals.length}`);
  for (const a of s.approvals) {
    if (!a.cutoffPeriod) problems.push(`approval ${a.id} has no cutoff period`);
    else if (["locked", "processed"].includes(a.cutoffPeriod.status)) problems.push(`approval ${a.id} is in a ${a.cutoffPeriod.status} cutoff`);
  }
  if (!s.leaves.some((l) => l.status === "approved")) problems.push(`no approved leave covers ${LOCAL_DATE}`);
  if (fs.existsSync(BACKUP_FILE)) problems.push(`backup already exists at ${BACKUP_FILE} — already applied?`);
  return problems;
}

async function apply(s) {
  const t = s.timeLogs[0];
  const backup = {
    ticket:    "BB-124",
    appliedAt: new Date().toISOString(),
    timeLog:   t,
    approvals: s.approvals.map(({ cutoffPeriod, ...a }) => a),
  };
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${BACKUP_FILE}`);

  await prisma.$transaction(async (tx) => {
    await tx.timeLog.update({
      where: { id: t.id },
      data: {
        timeIn:               t.originalTimeIn,
        timeOut:              t.originalTimeOut,
        isApproved:           false,
        driverAmSegmentHours: 0,
        regularSegmentHours:  0,
        driverPmSegmentHours: 0,
        netWorkedHours:       0,
        rawOtMinutes:         0,
      },
    });
    for (const a of s.approvals) {
      await tx.timeLogApproval.update({
        where: { id: a.id },
        data: {
          status:           "excluded",
          approvedAt:       new Date(),
          notes:            NOTE,
          approvedClockIn:  null,
          approvedClockOut: null,
          scheduledHours:   null,
          actualHours:      null,
        },
      });
    }
  });
  console.log(`✅ Applied: TimeLog ${t.id} restored to raw punch, ${s.approvals.length} approvals excluded. Leave untouched.`);
}

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup at ${BACKUP_FILE} — nothing to revert.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  const t = backup.timeLog;
  await prisma.$transaction(async (tx) => {
    await tx.timeLog.update({
      where: { id: t.id },
      data: {
        timeIn:               new Date(t.timeIn),
        timeOut:              t.timeOut ? new Date(t.timeOut) : null,
        isApproved:           t.isApproved,
        driverAmSegmentHours: t.driverAmSegmentHours,
        regularSegmentHours:  t.regularSegmentHours,
        driverPmSegmentHours: t.driverPmSegmentHours,
        netWorkedHours:       t.netWorkedHours,
        rawOtMinutes:         t.rawOtMinutes,
      },
    });
    for (const a of backup.approvals) {
      await tx.timeLogApproval.update({
        where: { id: a.id },
        data: {
          status:           a.status,
          approvedAt:       a.approvedAt ? new Date(a.approvedAt) : null,
          notes:            a.notes,
          approvedClockIn:  a.approvedClockIn ? new Date(a.approvedClockIn) : null,
          approvedClockOut: a.approvedClockOut ? new Date(a.approvedClockOut) : null,
          scheduledHours:   a.scheduledHours,
          actualHours:      a.actualHours,
        },
      });
    }
  });
  fs.renameSync(BACKUP_FILE, BACKUP_FILE.replace(/\.json$/, `.reverted-${Date.now()}.json`));
  console.log(`↩️  Reverted TimeLog ${t.id} and ${backup.approvals.length} approvals from backup.`);
}

async function main() {
  if (REVERT) return revert();

  const state = await loadState();
  printState(state);

  const problems = checkSafety(state);
  if (problems.length) {
    console.log("⛔ Safety checks failed — nothing written:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const t = state.timeLogs[0];
  console.log("Plan:");
  console.log(`  TimeLog ${t.id}: ${fmt(t.timeIn, state.tz)} → ${fmt(t.timeOut, state.tz)}  ⇒  ${fmt(t.originalTimeIn, state.tz)} → ${fmt(t.originalTimeOut, state.tz)}, segment/net hours 0`);
  for (const a of state.approvals) console.log(`  Approval ${a.id} (${a.segmentType}): ${a.status} ⇒ excluded`);
  console.log("  Leave: unchanged\n");

  if (!APPLY) {
    console.log("Dry run — re-run with --apply to write.");
    return;
  }
  await apply(state);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
