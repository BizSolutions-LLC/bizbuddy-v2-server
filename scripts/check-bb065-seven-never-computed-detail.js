// scripts/check-bb065-seven-never-computed-detail.js
//
// BB-065 (follow-up) — Deep, read-only look at the 7 specific RequestedTimeLog ->
// TimeLog rows found by check-bb065-request-punch-lunch-deduction-scope.js with
// netWorkedHours still NULL. Goal: understand WHY these 7 specifically were never
// computed, when 17 other approved-before-the-fix requests in the same window DID
// get computed correctly (presumably via a later cutoff-period sweep). Candidate
// explanations this script checks for each row:
//   - No CutoffPeriod exists yet covering that company/department/date at all.
//   - A CutoffPeriod exists but is still "open" (not yet processed/locked) —
//     recompute may simply not have reached it yet.
//   - A CutoffPeriod exists, is "locked"/"processed", but this TimeLog has no
//     TimeLogApproval row — it was never swept into that period's approval set.
//   - Multiple/overlapping TimeLog rows for the same user+date (could indicate
//     the approval created a record alongside another punch for the same day).
//
// READ-ONLY — no writes, no calls to computeTimeLogSummary or any mutation.
//
// Usage: node scripts/check-bb065-seven-never-computed-detail.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const REQUEST_IDS = [
  "8a010499-55fc-4fc2-bf6e-a25e9abd8d4b", // Arlene Backeng   | 2026-07-20
  "d479eddb-d764-4d56-922f-1882885f59b5", // Robert Ramirez   | 2026-08-03
  "b62ba53a-266b-4d45-b8f9-2055e5320fdb", // Gemma Navarette  | 2026-08-01
  "6269e5ca-ed99-4c21-8e95-1e06e01bed07", // Gemma Navarette  | 2026-07-31
  "227e1e60-4dad-4bae-8616-48f097a412cb", // Gemma Navarette  | 2026-07-30
  "f1f904b3-2130-466c-ae24-ab388725967a", // Gemma Navarette  | 2026-07-09
  "433f297e-7981-4881-817f-d55289a1f40b", // Arlene Backeng   | 2026-07-29
];

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtHours(n) {
  if (n === null || n === undefined) return "null";
  return `${Number(n)}h`;
}

function dayBounds(dateLike) {
  const d = new Date(dateLike);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
}

async function main() {
  console.log(`=== Detailed look at ${REQUEST_IDS.length} NEVER_COMPUTED rows ===\n`);

  for (const requestId of REQUEST_IDS) {
    const request = await prisma.requestedTimeLog.findUnique({
      where: { id: requestId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            companyId: true,
            departmentId: true,
            profile: { select: { firstName: true, lastName: true } },
            company: {
              select: {
                name: true,
                timeZone: true,
                minimumLunchMinutes: true,
                autoBreakBasis: true,
                defaultShiftHours: true,
              },
            },
          },
        },
        approver: {
          select: { email: true, profile: { select: { firstName: true, lastName: true } } },
        },
      },
    });

    if (!request) {
      console.log(`--- RequestedTimeLog ${requestId} --- NOT FOUND\n`);
      continue;
    }

    const name = request.user?.profile
      ? `${request.user.profile.firstName} ${request.user.profile.lastName}`
      : request.user?.email;
    const approverName = request.approver?.profile
      ? `${request.approver.profile.firstName} ${request.approver.profile.lastName}`
      : request.approver?.email || "—";

    console.log(`════════════════════════════════════════════════════════════════`);
    console.log(`RequestedTimeLog ${request.id}`);
    console.log(`  employee: ${name} (userId=${request.userId}, companyId=${request.user?.companyId}, departmentId=${request.user?.departmentId || "—"})`);
    console.log(`  company: ${request.user?.company?.name || "—"} (tz=${request.user?.company?.timeZone || "—"})`);
    console.log(`  company.minimumLunchMinutes: ${request.user?.company?.minimumLunchMinutes ?? "—"}  autoBreakBasis: ${request.user?.company?.autoBreakBasis || "—"}`);
    console.log(`  status: ${request.status}  reason: "${request.reason || "—"}"`);
    console.log(`  requestedDate: ${fmt(request.requestedDate)}`);
    console.log(`  requestedClockIn: ${fmt(request.requestedClockIn)}  requestedClockOut: ${fmt(request.requestedClockOut)}`);
    console.log(`  estimatedDuration: ${request.estimatedDuration ?? "null"} min  estimatedNetHours: ${fmtHours(request.estimatedNetHours)}`);
    console.log(`  submittedAt: ${fmt(request.submittedAt)}`);
    console.log(`  approvedAt: ${fmt(request.approvedAt)}  approvedBy: ${approverName}`);
    console.log(`  createdTimeLogId: ${request.createdTimeLogId}`);

    // ── Linked TimeLog, full detail ──────────────────────────────────────────
    const timeLog = await prisma.timeLog.findUnique({
      where: { id: request.createdTimeLogId },
    });

    if (!timeLog) {
      console.log(`\n  linked TimeLog: NOT FOUND (dangling reference)\n`);
      continue;
    }

    console.log(`\n  --- Linked TimeLog ${timeLog.id} ---`);
    console.log(`    userId: ${timeLog.userId}`);
    console.log(`    timeIn: ${fmt(timeLog.timeIn)}  timeOut: ${fmt(timeLog.timeOut)}`);
    console.log(`    status (open/closed flag): ${timeLog.status}`);
    console.log(`    punchType: ${timeLog.punchType}`);
    console.log(`    isApproved: ${timeLog.isApproved}`);
    console.log(`    coffeeBreaks: ${JSON.stringify(timeLog.coffeeBreaks)}`);
    console.log(`    lunchBreak: ${JSON.stringify(timeLog.lunchBreak)}`);
    console.log(`    autoLunchApplied: ${timeLog.autoLunchApplied}  autoLunchDeductionMinutes: ${timeLog.autoLunchDeductionMinutes ?? "null"}`);
    console.log(`    grossHours: ${fmtHours(timeLog.grossHours)}`);
    console.log(`    netWorkedHours: ${fmtHours(timeLog.netWorkedHours)}`);
    console.log(`    lunchDeductionMinutes: ${timeLog.lunchDeductionMinutes ?? "null"}`);
    console.log(`    lateHours: ${timeLog.lateHours ?? "null"}  undertimeHours: ${timeLog.undertimeHours ?? "null"}`);
    console.log(`    rawOtMinutes: ${timeLog.rawOtMinutes ?? "null"}`);
    console.log(`    scheduledHours: ${fmtHours(timeLog.scheduledHours)}`);
    console.log(`    calculatedAt: ${fmt(timeLog.calculatedAt)}  <-- null means computeTimeLogSummary has NEVER run on this row`);
    console.log(`    createdAt: ${fmt(timeLog.createdAt)}  updatedAt: ${fmt(timeLog.updatedAt)}`);
    console.log(`    deviceInfo: ${JSON.stringify(timeLog.deviceInfo)}`);
    console.log(`    remarks: ${JSON.stringify(timeLog.remarks)}`);

    // ── UserShift for that date ──────────────────────────────────────────────
    const { start, end } = dayBounds(request.requestedDate);
    const userShift = await prisma.userShift.findFirst({
      where: { userId: request.userId, assignedDate: { gte: start, lte: end } },
      include: { shift: { select: { shiftName: true, startTime: true, endTime: true } } },
    });
    console.log(`\n  UserShift for ${fmt(request.requestedDate).slice(0, 10)}: ${
      userShift ? `${userShift.shift?.shiftName} (status=${userShift.status})` : "none assigned"
    }`);

    // ── CutoffPeriod(s) covering this date for this company/department ──────
    const cutoffPeriods = await prisma.cutoffPeriod.findMany({
      where: {
        companyId: request.user?.companyId,
        OR: [{ departmentId: request.user?.departmentId || undefined }, { departmentId: null }],
        periodStart: { lte: request.requestedDate },
        periodEnd: { gte: request.requestedDate },
      },
      select: { id: true, periodStart: true, periodEnd: true, status: true, departmentId: true, isAutoGenerated: true },
    });

    if (cutoffPeriods.length === 0) {
      console.log(`  CutoffPeriod covering this date: NONE FOUND — this date has no cutoff period at all yet.`);
    } else {
      for (const cp of cutoffPeriods) {
        console.log(
          `  CutoffPeriod ${cp.id}: ${fmt(cp.periodStart).slice(0, 10)} to ${fmt(cp.periodEnd).slice(0, 10)} ` +
            `status=${cp.status} departmentId=${cp.departmentId || "company-wide"} autoGenerated=${cp.isAutoGenerated}`
        );
      }
    }

    // ── TimeLogApproval rows for this TimeLog ────────────────────────────────
    const approvals = await prisma.timeLogApproval.findMany({
      where: { timeLogId: timeLog.id },
      select: { id: true, status: true, cutoffPeriodId: true, actualHours: true, scheduledHours: true, segmentType: true, createdAt: true },
    });
    if (approvals.length === 0) {
      console.log(`  TimeLogApproval rows for this TimeLog: NONE — this TimeLog was never swept into any cutoff period's approval set.`);
    } else {
      for (const a of approvals) {
        console.log(
          `  TimeLogApproval ${a.id}: status=${a.status} cutoffPeriodId=${a.cutoffPeriodId || "—"} ` +
            `actualHours=${fmtHours(a.actualHours)} scheduledHours=${fmtHours(a.scheduledHours)} segmentType=${a.segmentType || "—"}`
        );
      }
    }

    // ── Other TimeLogs for this user on the same date (context) ─────────────
    const sameDayLogs = await prisma.timeLog.findMany({
      where: { userId: request.userId, timeIn: { gte: start, lte: end }, id: { not: timeLog.id } },
      select: { id: true, timeIn: true, timeOut: true, punchType: true, netWorkedHours: true },
    });
    if (sameDayLogs.length > 0) {
      console.log(`  Other TimeLog rows same day for this user: ${sameDayLogs.length}`);
      for (const l of sameDayLogs) {
        console.log(`    - ${l.id} | ${fmt(l.timeIn)} - ${fmt(l.timeOut)} | ${l.punchType} | netWorkedHours=${fmtHours(l.netWorkedHours)}`);
      }
    } else {
      console.log(`  Other TimeLog rows same day for this user: none.`);
    }

    console.log("");
  }

  console.log(`════════════════════════════════════════════════════════════════`);
  console.log("No changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
