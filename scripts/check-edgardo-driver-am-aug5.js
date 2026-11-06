// scripts/check-edgardo-driver-am-aug5.js
//
// Edgardo Nuestro (ednuestro58@yahoo.com) — Aug 5, 2026 Driver Day shift shows
// 3 TimeLogApproval segments on one TimeLog: Driver AM is "Excluded" (no hours,
// no Reset button in the UI), Regular and Driver PM are both "Approved".
//
// This is a READ-ONLY diagnostic — no writes, no computeTimeLogSummary calls.
// It finds the exact TimeLog / TimeLogApproval / CutoffPeriod ids involved,
// prints their full state, and checks for a Leave record covering Aug 5 (to
// rule in/out the known BB-073 auto-exclude-via-leave scenario, where an
// approved leave conflicting with a punch force-excludes it, and cancelling
// the leave doesn't always undo that exclusion).
//
// Usage: node scripts/check-edgardo-driver-am-aug5.js

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

const EMPLOYEE_EMAIL = "ednuestro58@yahoo.com";

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtHours(n) {
  if (n === null || n === undefined) return "null";
  return `${Number(n)}h`;
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: { equals: EMPLOYEE_EMAIL, mode: "insensitive" } },
    select: {
      id: true,
      email: true,
      companyId: true,
      departmentId: true,
      profile: { select: { firstName: true, lastName: true } },
    },
  });

  if (!user) {
    console.log(`No User found with email ${EMPLOYEE_EMAIL}. Aborting.`);
    return;
  }

  console.log("=== User ===");
  console.log(`  id: ${user.id}`);
  console.log(`  name: ${user.profile?.firstName} ${user.profile?.lastName}`);
  console.log(`  companyId: ${user.companyId}  departmentId: ${user.departmentId || "—"}`);

  const company = await prisma.company.findUnique({
    where: { id: user.companyId },
    select: { name: true, timeZone: true },
  });
  const companyTz = company?.timeZone || "America/Los_Angeles";
  console.log(`  company: ${company?.name}  timeZone: ${companyTz}`);

  const dayStart = moment.tz("2026-08-05", companyTz).startOf("day").toDate();
  const dayEnd = moment.tz("2026-08-05", companyTz).endOf("day").toDate();

  console.log(`\n=== TimeLog rows on 2026-08-05 (company-tz day: ${fmt(dayStart)} .. ${fmt(dayEnd)}) ===`);
  const timeLogs = await prisma.timeLog.findMany({
    where: { userId: user.id, timeIn: { gte: dayStart, lte: dayEnd } },
    orderBy: { timeIn: "asc" },
  });

  if (timeLogs.length === 0) {
    console.log("  none found — check the date/timezone assumption above.");
  }

  for (const tl of timeLogs) {
    console.log(`  --- TimeLog ${tl.id} ---`);
    console.log(`    punchType: ${tl.punchType}  isApproved: ${tl.isApproved}`);
    console.log(`    timeIn: ${fmt(tl.timeIn)}  timeOut: ${fmt(tl.timeOut)}`);
    console.log(`    originalTimeIn: ${fmt(tl.originalTimeIn)}  originalTimeOut: ${fmt(tl.originalTimeOut)}`);
    console.log(`    netWorkedHours: ${fmtHours(tl.netWorkedHours)}`);
    console.log(`    driverAmSegmentHours: ${fmtHours(tl.driverAmSegmentHours)}`);
    console.log(`    regularSegmentHours: ${fmtHours(tl.regularSegmentHours)}`);
    console.log(`    driverPmSegmentHours: ${fmtHours(tl.driverPmSegmentHours)}`);
    console.log(`    rawOtMinutes: ${tl.rawOtMinutes ?? "null"}`);

    const approvals = await prisma.timeLogApproval.findMany({
      where: { timeLogId: tl.id },
      orderBy: { segmentType: "asc" },
      include: { cutoffPeriod: { select: { id: true, status: true, periodStart: true, periodEnd: true } } },
    });

    console.log(`    TimeLogApproval rows: ${approvals.length}`);
    for (const a of approvals) {
      const marker = a.segmentType === "driver_am" ? "  <-- DRIVER AM (target)" : "";
      console.log(`      --- TimeLogApproval ${a.id} (segmentType: ${a.segmentType ?? "null"})${marker}`);
      console.log(`          status: ${a.status}  notes: "${a.notes || "—"}"`);
      console.log(`          approvedBy: ${a.approvedBy || "—"}  approvedAt: ${fmt(a.approvedAt)}`);
      console.log(`          segmentStart: ${fmt(a.segmentStart)}  segmentEnd: ${fmt(a.segmentEnd)}`);
      console.log(`          actualHours: ${fmtHours(a.actualHours)}  scheduledHours: ${fmtHours(a.scheduledHours)}  editedHours: ${fmtHours(a.editedHours)}`);
      console.log(`          approvedClockIn: ${fmt(a.approvedClockIn)}  approvedClockOut: ${fmt(a.approvedClockOut)}`);
      console.log(`          cutoffPeriod: ${a.cutoffPeriod ? `${a.cutoffPeriod.id} (status: ${a.cutoffPeriod.status}, ${fmt(a.cutoffPeriod.periodStart)} .. ${fmt(a.cutoffPeriod.periodEnd)})` : "none"}`);
    }
  }

  console.log(`\n=== Leave records covering 2026-08-05 for this user ===`);
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
    console.log("  none — the Driver AM exclusion is likely not the BB-073 leave-conflict scenario.");
  } else {
    for (const l of leaves) {
      console.log(`  --- Leave ${l.id} ---`);
      console.log(`    leaveType: ${l.leaveType}  status: ${l.status}  isPaid: ${l.isPaid}`);
      console.log(`    startDate: ${fmt(l.startDate)}  endDate: ${fmt(l.endDate)}`);
      console.log(`    actualPaidHours: ${fmtHours(l.actualPaidHours)}  actualUnpaidHours: ${fmtHours(l.actualUnpaidHours)}`);
      console.log(`    updatedAt: ${fmt(l.updatedAt)}`);
    }
    console.log(`  If any of these is CANCELLED/rejected but the Driver AM row above still shows`);
    console.log(`  "Auto-excluded: approved leave on this day" in its notes, that confirms the BB-073 stuck state.`);
  }

  console.log(`\nDone. Share this output before running fix-edgardo-driver-am-aug5-revert.js.`);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
