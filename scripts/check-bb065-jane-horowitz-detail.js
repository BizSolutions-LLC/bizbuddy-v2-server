// scripts/check-bb065-jane-horowitz-detail.js
//
// BB-065 (follow-up) — Targeted look at the Wed Jul 29, 2026 pending Request Punch
// (08:00 AM - 01:30 PM, "Forgot To Clock", shown as 4.50h) and the adjacent
// "Total hours: 4.97" stat tile on the same screen, which matches neither the
// stored estimate (4.50h) nor the corrected face-value span (5.50h).
//
// APPROVER_ID is Jane Horowitz's User id — she is the APPROVER on this request,
// not the employee. This script finds the real requesting employee via her
// pending approvals, then pulls full detail for that employee.
//
// READ-ONLY — no writes, no calls to computeTimeLogSummary or any mutation.
//
// Usage: node scripts/check-bb065-jane-horowitz-detail.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const APPROVER_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Jane Horowitz — the approver

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtHours(n) {
  if (n === null || n === undefined) return "null";
  return `${Number(n)}h`;
}

const APPROVER_SELECT = {
  id: true,
  email: true,
  role: true,
  companyId: true,
  departmentId: true,
  profile: { select: { firstName: true, lastName: true } },
};

async function resolveApprover() {
  const asUser = await prisma.user.findUnique({ where: { id: APPROVER_ID }, select: APPROVER_SELECT });
  if (asUser) return { approver: asUser, via: "User.id direct match" };

  const asRequest = await prisma.requestedTimeLog.findUnique({
    where: { id: APPROVER_ID },
    select: { approverId: true },
  });
  if (asRequest?.approverId) {
    const u = await prisma.user.findUnique({ where: { id: asRequest.approverId }, select: APPROVER_SELECT });
    if (u) return { approver: u, via: "RequestedTimeLog.id -> approverId" };
  }

  const asTimeLogApprover = await prisma.timeLog.findUnique({
    where: { id: APPROVER_ID },
    select: { userId: true },
  });
  if (asTimeLogApprover?.userId) {
    const u = await prisma.user.findUnique({ where: { id: asTimeLogApprover.userId }, select: APPROVER_SELECT });
    if (u) return { approver: u, via: "TimeLog.id -> userId (NOTE: this treats the id as an employee, not an approver)" };
  }

  const byName = await prisma.user.findFirst({
    where: {
      profile: { firstName: { equals: "Jane", mode: "insensitive" }, lastName: { equals: "Horowitz", mode: "insensitive" } },
    },
    select: APPROVER_SELECT,
  });
  if (byName) return { approver: byName, via: 'name lookup fallback: "Jane Horowitz"' };

  return null;
}

async function main() {
  const resolved = await resolveApprover();

  if (!resolved) {
    console.log(`Could not resolve ${APPROVER_ID} against User, RequestedTimeLog, or TimeLog, and no ` +
      `"Jane Horowitz" user was found by name either. Aborting — need a valid id or exact name.`);
    return;
  }

  const approver = resolved.approver;
  console.log(`=== Resolved via: ${resolved.via} ===`);

  console.log(`=== Approver ===`);
  console.log(`  id: ${approver.id}`);
  console.log(`  name: ${approver.profile?.firstName} ${approver.profile?.lastName}`);
  console.log(`  email: ${approver.email}  role: ${approver.role}`);
  console.log(`  companyId: ${approver.companyId}  departmentId: ${approver.departmentId || "—"}`);

  // ── All RequestedTimeLog rows where this user is the approver ───────────
  const requestsForApprover = await prisma.requestedTimeLog.findMany({
    where: { approverId: APPROVER_ID },
    orderBy: { requestedDate: "desc" },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          companyId: true,
          departmentId: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  console.log(`\n=== RequestedTimeLog rows with this approver: ${requestsForApprover.length} ===`);
  for (const r of requestsForApprover) {
    const name = r.user?.profile ? `${r.user.profile.firstName} ${r.user.profile.lastName}` : r.user?.email;
    console.log(`  --- ${r.id} ---`);
    console.log(`    employee: ${name} (userId=${r.userId})`);
    console.log(`    status: ${r.status}  reason: "${r.reason || "—"}"`);
    console.log(`    requestedDate: ${fmt(r.requestedDate)}`);
    console.log(`    requestedClockIn: ${fmt(r.requestedClockIn)}  requestedClockOut: ${fmt(r.requestedClockOut)}`);
    console.log(`    estimatedDuration: ${r.estimatedDuration ?? "null"} min  estimatedNetHours: ${fmtHours(r.estimatedNetHours)}`);
    console.log(`    submittedAt: ${fmt(r.submittedAt)}  approvedAt: ${fmt(r.approvedAt)}`);
  }

  // ── Identify the Jul 29, 2026 request specifically ───────────────────────
  let target = requestsForApprover.find((r) => fmt(r.requestedDate).startsWith("2026-07-29"));

  if (!target) {
    console.log(
      `\nNo Jul 29, 2026 request found where approverId = ${approver.id} (${approver.profile?.firstName} ${approver.profile?.lastName}). ` +
        `Broadening the search to the whole company (${approver.companyId}) for that date, regardless of approverId...`
    );

    const companyWideCandidates = await prisma.requestedTimeLog.findMany({
      where: {
        requestedDate: {
          gte: new Date("2026-07-29T00:00:00.000Z"),
          lte: new Date("2026-07-29T23:59:59.999Z"),
        },
        user: { companyId: approver.companyId },
      },
      include: {
        user: {
          select: { id: true, email: true, companyId: true, departmentId: true, profile: { select: { firstName: true, lastName: true } } },
        },
      },
    });

    console.log(`\n=== Company-wide RequestedTimeLog rows for 2026-07-29: ${companyWideCandidates.length} ===`);
    for (const r of companyWideCandidates) {
      const name = r.user?.profile ? `${r.user.profile.firstName} ${r.user.profile.lastName}` : r.user?.email;
      const approverMatch = r.approverId === approver.id ? "MATCHES resolved Jane id" : `DOES NOT match (stored approverId=${r.approverId || "null"})`;
      console.log(`  --- ${r.id} ---`);
      console.log(`    employee: ${name} (userId=${r.userId})`);
      console.log(`    status: ${r.status}  reason: "${r.reason || "—"}"`);
      console.log(`    requestedClockIn: ${fmt(r.requestedClockIn)}  requestedClockOut: ${fmt(r.requestedClockOut)}`);
      console.log(`    estimatedNetHours: ${fmtHours(r.estimatedNetHours)}`);
      console.log(`    stored approverId: ${r.approverId || "null"} — ${approverMatch}`);
    }

    target = companyWideCandidates.find(
      (r) => fmt(r.requestedClockIn).includes("T08:00") || fmtHours(r.estimatedNetHours) === "4.5h"
    ) || companyWideCandidates[0];

    if (!target) {
      console.log(`\nStill nothing found company-wide for that date. Stopping here.`);
      return;
    }
    console.log(`\nUsing ${target.id} as the target request going forward.`);
  }

  const employee = target.user;
  const employeeName = employee?.profile ? `${employee.profile.firstName} ${employee.profile.lastName}` : employee?.email;

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`Target request identified: ${target.id} — employee ${employeeName} (userId=${employee.id})`);
  console.log(`════════════════════════════════════════════════════════════════`);

  const employeeFull = await prisma.user.findUnique({
    where: { id: employee.id },
    include: {
      profile: true,
      company: {
        select: {
          name: true,
          timeZone: true,
          minimumLunchMinutes: true,
          autoBreakBasis: true,
          defaultShiftHours: true,
          otBasis: true,
          dailyOtThresholdHours: true,
          weeklyOtThresholdHours: true,
          cutoffOtThresholdHours: true,
        },
      },
    },
  });

  console.log(`\n=== Employee detail ===`);
  console.log(`  id: ${employeeFull.id}`);
  console.log(`  name: ${employeeFull.profile?.firstName} ${employeeFull.profile?.lastName}`);
  console.log(`  email: ${employeeFull.email}`);
  console.log(`  companyId: ${employeeFull.companyId}  departmentId: ${employeeFull.departmentId || "—"}`);
  console.log(`  company: ${employeeFull.company?.name || "—"} (tz=${employeeFull.company?.timeZone || "—"})`);
  console.log(`  company.minimumLunchMinutes: ${employeeFull.company?.minimumLunchMinutes ?? "—"}  autoBreakBasis: ${employeeFull.company?.autoBreakBasis || "—"}`);
  console.log(`  company OT config: otBasis=${employeeFull.company?.otBasis || "—"} dailyOtThresholdHours=${employeeFull.company?.dailyOtThresholdHours ?? "—"} weeklyOtThresholdHours=${employeeFull.company?.weeklyOtThresholdHours ?? "—"} cutoffOtThresholdHours=${employeeFull.company?.cutoffOtThresholdHours ?? "—"}`);

  // ── All RequestedTimeLog rows for this employee (any approver) ──────────
  const employeeRequests = await prisma.requestedTimeLog.findMany({
    where: { userId: employee.id },
    orderBy: { requestedDate: "desc" },
  });
  console.log(`\n=== RequestedTimeLog rows for this employee: ${employeeRequests.length} ===`);
  for (const r of employeeRequests) {
    console.log(`  --- ${r.id} ---`);
    console.log(`    status: ${r.status}  reason: "${r.reason || "—"}"`);
    console.log(`    requestedDate: ${fmt(r.requestedDate)}`);
    console.log(`    requestedClockIn: ${fmt(r.requestedClockIn)}  requestedClockOut: ${fmt(r.requestedClockOut)}`);
    console.log(`    estimatedDuration: ${r.estimatedDuration ?? "null"} min  estimatedNetHours: ${fmtHours(r.estimatedNetHours)}`);
    console.log(`    submittedAt: ${fmt(r.submittedAt)}  approvedAt: ${fmt(r.approvedAt)}`);
    console.log(`    createdTimeLogId: ${r.createdTimeLogId || "—"}`);
  }

  // ── All TimeLog rows for this employee in the surrounding window ────────
  const windowStart = new Date("2026-06-01T00:00:00.000Z");
  const windowEnd = new Date();

  const timeLogs = await prisma.timeLog.findMany({
    where: { userId: employee.id, timeIn: { gte: windowStart, lte: windowEnd } },
    orderBy: { timeIn: "asc" },
  });

  console.log(`\n=== TimeLog rows for this employee, ${fmt(windowStart).slice(0, 10)} to today: ${timeLogs.length} ===`);
  let sumNetWorkedHours = 0;
  let sumGrossHours = 0;
  for (const t of timeLogs) {
    console.log(`  --- ${t.id} ---`);
    console.log(`    timeIn: ${fmt(t.timeIn)}  timeOut: ${fmt(t.timeOut)}`);
    console.log(`    punchType: ${t.punchType}  status: ${t.status}  isApproved: ${t.isApproved}`);
    console.log(`    grossHours: ${fmtHours(t.grossHours)}  netWorkedHours: ${fmtHours(t.netWorkedHours)}`);
    console.log(`    lunchDeductionMinutes: ${t.lunchDeductionMinutes ?? "null"}  rawOtMinutes: ${t.rawOtMinutes ?? "null"}`);
    console.log(`    regularSegmentHours: ${fmtHours(t.regularSegmentHours)}  driverAmSegmentHours: ${fmtHours(t.driverAmSegmentHours)}  driverPmSegmentHours: ${fmtHours(t.driverPmSegmentHours)}`);
    console.log(`    calculatedAt: ${fmt(t.calculatedAt)}`);
    if (t.netWorkedHours != null) sumNetWorkedHours += Number(t.netWorkedHours);
    if (t.grossHours != null) sumGrossHours += Number(t.grossHours);
  }
  console.log(`\n  Sum of netWorkedHours across these TimeLog rows: ${sumNetWorkedHours.toFixed(2)}h`);
  console.log(`  Sum of grossHours across these TimeLog rows: ${sumGrossHours.toFixed(2)}h`);

  // ── TimeLogApproval rows (actualHours is the payroll-facing figure) ─────
  const timeLogIds = timeLogs.map((t) => t.id);
  const approvals = timeLogIds.length
    ? await prisma.timeLogApproval.findMany({
        where: { timeLogId: { in: timeLogIds } },
        select: { id: true, timeLogId: true, status: true, actualHours: true, scheduledHours: true, segmentType: true, cutoffPeriodId: true },
      })
    : [];

  console.log(`\n=== TimeLogApproval rows across those TimeLogs: ${approvals.length} ===`);
  let sumActualHours = 0;
  for (const a of approvals) {
    console.log(`  timeLogId=${a.timeLogId} status=${a.status} actualHours=${fmtHours(a.actualHours)} scheduledHours=${fmtHours(a.scheduledHours)} segmentType=${a.segmentType || "—"} cutoffPeriodId=${a.cutoffPeriodId || "—"}`);
    if (a.actualHours != null) sumActualHours += Number(a.actualHours);
  }
  console.log(`\n  Sum of actualHours across TimeLogApproval rows: ${sumActualHours.toFixed(2)}h`);

  // ── CutoffPeriods covering this window for her company/department ───────
  const cutoffPeriods = await prisma.cutoffPeriod.findMany({
    where: {
      companyId: employeeFull.companyId,
      OR: [{ departmentId: employeeFull.departmentId || undefined }, { departmentId: null }],
      periodEnd: { gte: windowStart },
    },
    select: { id: true, periodStart: true, periodEnd: true, status: true, departmentId: true },
    orderBy: { periodStart: "asc" },
  });
  console.log(`\n=== CutoffPeriods covering this window: ${cutoffPeriods.length} ===`);
  for (const cp of cutoffPeriods) {
    console.log(`  ${cp.id}: ${fmt(cp.periodStart).slice(0, 10)} to ${fmt(cp.periodEnd).slice(0, 10)} status=${cp.status} departmentId=${cp.departmentId || "company-wide"}`);
  }

  console.log(`\n=== Candidate figures to compare against the UI's "4.97" ===`);
  console.log(`  Stored estimatedNetHours on the Jul 29 pending request: ${fmtHours(target.estimatedNetHours)}`);
  console.log(`  Corrected face-value (no lunch deduction) for 08:00-13:30: 5.50h`);
  console.log(`  Sum of netWorkedHours across all TimeLog rows in window: ${sumNetWorkedHours.toFixed(2)}h`);
  console.log(`  Sum of grossHours across all TimeLog rows in window: ${sumGrossHours.toFixed(2)}h`);
  console.log(`  Sum of actualHours across all TimeLogApproval rows: ${sumActualHours.toFixed(2)}h`);
  console.log(`  None of these may match 4.97 exactly — if so, the "Total hours" tile is likely computed`);
  console.log(`  by a different endpoint/date-range than what this script queried.`);

  console.log("\nNo changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
