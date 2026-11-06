// scripts/check-alec-duna-aug28-detail.js
//
// Follow-up diagnostic for Alec Duna's punch on 2026-08-28. This is a
// READ-ONLY script — no writes, no computeTimeLogSummary calls.
//
// What it checks:
//   1. Resolves the User row for Alec Duna (guards against no match / multiple
//      matches rather than guessing).
//   2. Every TimeLog for that user on 2026-08-28 (company-local day), with the
//      full set of raw + derived fields.
//   3. Every TimeLogApproval segment linked to those TimeLog rows, including
//      the CutoffPeriod each belongs to.
//   4. Any RequestedTimeLog (punch correction request) for 2026-08-28.
//   5. Any Leave record overlapping 2026-08-28, in case an approved leave is
//      interacting with the punch (see BB-073).
//
// Usage: node scripts/check-alec-duna-aug28-detail.js

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

const FIRST_NAME = "Alec";
const LAST_NAME = "Duna";
const FOCUS_DATE = "2026-08-28";

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtHours(n) {
  if (n === null || n === undefined) return "null";
  return `${Number(n)}h`;
}

async function main() {
  // ── 1. Resolve the employee ────────────────────────────────────────────
  const users = await prisma.user.findMany({
    where: {
      profile: {
        firstName: { equals: FIRST_NAME, mode: "insensitive" },
        lastName: { equals: LAST_NAME, mode: "insensitive" },
      },
    },
    include: {
      profile: true,
      company: { select: { name: true, timeZone: true } },
    },
  });

  if (users.length === 0) {
    console.log(`No user found matching "${FIRST_NAME} ${LAST_NAME}". Aborting.`);
    return;
  }
  if (users.length > 1) {
    console.log(`Multiple users match "${FIRST_NAME} ${LAST_NAME}" — disambiguate before proceeding:`);
    for (const u of users) {
      console.log(`  id=${u.id} email=${u.email} companyId=${u.companyId}`);
    }
    return;
  }

  const user = users[0];
  console.log("=== Employee ===");
  console.log(`  id: ${user.id}`);
  console.log(`  name: ${user.profile?.firstName} ${user.profile?.lastName}`);
  console.log(`  email: ${user.email}`);
  console.log(`  employeeId: ${user.employeeId || "—"}`);
  console.log(`  companyId: ${user.companyId}  departmentId: ${user.departmentId || "—"}`);

  const companyTz = user.company?.timeZone || "America/Los_Angeles";
  console.log(`  company: ${user.company?.name || "—"}  timeZone: ${companyTz}`);

  const dayStart = moment.tz(FOCUS_DATE, companyTz).startOf("day").toDate();
  const dayEnd = moment.tz(FOCUS_DATE, companyTz).endOf("day").toDate();

  // ── 2. TimeLog rows for the focus date ─────────────────────────────────
  console.log(`\n=== TimeLog rows on ${FOCUS_DATE} (company-tz day: ${fmt(dayStart)} .. ${fmt(dayEnd)}) ===`);
  const timeLogs = await prisma.timeLog.findMany({
    where: { userId: user.id, timeIn: { gte: dayStart, lte: dayEnd } },
    orderBy: { timeIn: "asc" },
  });

  if (timeLogs.length === 0) {
    console.log("  none found — check the date/timezone assumption above.");
  }

  for (const tl of timeLogs) {
    console.log(`  --- TimeLog ${tl.id} ---`);
    console.log(`    status: ${tl.status}  isApproved: ${tl.isApproved}  punchType: ${tl.punchType}`);
    console.log(`    timeIn: ${fmt(tl.timeIn)}  timeOut: ${fmt(tl.timeOut)}`);
    console.log(`    originalTimeIn: ${fmt(tl.originalTimeIn)}  originalTimeOut: ${fmt(tl.originalTimeOut)}`);
    console.log(`    autoClockOut: ${tl.autoClockOut}  autoClockOutAt: ${fmt(tl.autoClockOutAt)}`);
    console.log(`    isTooEarlyPunch: ${tl.isTooEarlyPunch}`);
    console.log(`    netWorkedHours: ${fmtHours(tl.netWorkedHours)}  undertimeHours: ${fmtHours(tl.undertimeHours)}`);
    console.log(`    grossHours: ${fmtHours(tl.grossHours)}  scheduledHours: ${fmtHours(tl.scheduledHours)}`);
    console.log(`    regularSegmentHours: ${fmtHours(tl.regularSegmentHours)}`);
    console.log(`    driverAmSegmentHours: ${fmtHours(tl.driverAmSegmentHours)}`);
    console.log(`    driverPmSegmentHours: ${fmtHours(tl.driverPmSegmentHours)}`);
    console.log(`    rawOtMinutes: ${tl.rawOtMinutes ?? "null"}`);
    console.log(`    calculatedAt: ${fmt(tl.calculatedAt)}`);

    const approvals = await prisma.timeLogApproval.findMany({
      where: { timeLogId: tl.id },
      orderBy: { segmentType: "asc" },
      include: { cutoffPeriod: { select: { id: true, status: true, periodStart: true, periodEnd: true } } },
    });

    console.log(`    TimeLogApproval rows: ${approvals.length}`);
    for (const a of approvals) {
      console.log(`      --- TimeLogApproval ${a.id} (segmentType: ${a.segmentType ?? "null"}) ---`);
      console.log(`          status: ${a.status}  notes: "${a.notes || "—"}"`);
      console.log(`          approvedBy: ${a.approvedBy || "—"}  approvedAt: ${fmt(a.approvedAt)}`);
      console.log(`          segmentStart: ${fmt(a.segmentStart)}  segmentEnd: ${fmt(a.segmentEnd)}`);
      console.log(
        `          actualHours: ${fmtHours(a.actualHours)}  scheduledHours: ${fmtHours(a.scheduledHours)}  editedHours: ${fmtHours(a.editedHours)}`
      );
      console.log(`          approvedClockIn: ${fmt(a.approvedClockIn)}  approvedClockOut: ${fmt(a.approvedClockOut)}`);
      console.log(
        `          cutoffPeriod: ${a.cutoffPeriod ? `${a.cutoffPeriod.id} (status: ${a.cutoffPeriod.status}, ${fmt(a.cutoffPeriod.periodStart)} .. ${fmt(a.cutoffPeriod.periodEnd)})` : "none"}`
      );
    }
  }

  // ── 3. RequestedTimeLog (punch correction requests) for the focus date ──
  console.log(`\n=== RequestedTimeLog rows for ${FOCUS_DATE} ===`);
  const requests = await prisma.requestedTimeLog.findMany({
    where: { userId: user.id, requestedDate: { gte: dayStart, lte: dayEnd } },
    orderBy: { submittedAt: "asc" },
  });

  if (requests.length === 0) {
    console.log("  none found.");
  } else {
    for (const r of requests) {
      console.log(`  --- RequestedTimeLog ${r.id} ---`);
      console.log(`    status: ${r.status}  requestedPunchType: ${r.requestedPunchType ?? "null"}`);
      console.log(`    requestedClockIn: ${fmt(r.requestedClockIn)}  requestedClockOut: ${fmt(r.requestedClockOut)}`);
      console.log(`    estimatedDuration: ${r.estimatedDuration ?? "null"}  estimatedNetHours: ${fmtHours(r.estimatedNetHours)}`);
      console.log(`    reason: "${r.reason || "—"}"  description: "${r.description || "—"}"`);
      console.log(`    approverId: ${r.approverId || "—"}  approvedAt: ${fmt(r.approvedAt)}  rejectionReason: "${r.rejectionReason || "—"}"`);
      console.log(`    createdTimeLogId: ${r.createdTimeLogId || "—"}`);
      console.log(`    submittedAt: ${fmt(r.submittedAt)}  updatedAt: ${fmt(r.updatedAt)}`);
    }
  }

  // ── 4. Leave records overlapping the focus date ─────────────────────────
  console.log(`\n=== Leave records covering ${FOCUS_DATE} ===`);
  const leaves = await prisma.leave.findMany({
    where: {
      userId: user.id,
      startDate: { lte: dayEnd },
      endDate: { gte: dayStart },
    },
    select: {
      id: true, leaveType: true, status: true, startDate: true, endDate: true,
      isPaid: true, actualPaidHours: true, actualUnpaidHours: true, updatedAt: true,
    },
  });

  if (leaves.length === 0) {
    console.log("  none found.");
  } else {
    for (const l of leaves) {
      console.log(`  --- Leave ${l.id} ---`);
      console.log(`    leaveType: ${l.leaveType}  status: ${l.status}  isPaid: ${l.isPaid}`);
      console.log(`    startDate: ${fmt(l.startDate)}  endDate: ${fmt(l.endDate)}`);
      console.log(`    actualPaidHours: ${fmtHours(l.actualPaidHours)}  actualUnpaidHours: ${fmtHours(l.actualUnpaidHours)}`);
      console.log(`    updatedAt: ${fmt(l.updatedAt)}`);
    }
  }

  console.log("\nDone. No changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
