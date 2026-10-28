// scripts/check-cutoff-no-department-jan2026.js
//
// BB-086 data-fix diagnostic. The backtrack PadPro import bug created a
// company-wide ("No Department") CutoffPeriod for Jan 7-20, 2026 that swept
// in every employee's punches for that window, instead of each employee's
// punch landing in their own department's already-correctly-scoped period
// (Driver/Aide, Staff, Staff Supervisor — same exact dates, already exist).
//
// This script:
//   1. Finds the CutoffPeriod row(s) matching
//      { departmentId: null, periodStart: 2026-01-07, periodEnd: 2026-01-20 }.
//   2. Loads every TimeLogApproval under it, joined to TimeLog -> User.
//   3. For each approval, resolves the correct target department CutoffPeriod
//      (open, same company, employee's real departmentId, covering the
//      TimeLog's date) and classifies it as:
//        - MOVABLE            — target period found
//        - BLOCKED (no dept)  — employee has no departmentId assigned
//        - BLOCKED (no period)— employee has a department, but no open
//                                CutoffPeriod covers this date for it
//
// READ-ONLY — no writes. Run this before fix-cutoff-no-department-jan2026.js.
//
// Usage:
//   node scripts/check-cutoff-no-department-jan2026.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TARGET_PERIOD_START = "2026-01-07";
const TARGET_PERIOD_END = "2026-01-20";

function fmt(date) {
  return new Date(date).toISOString().slice(0, 10);
}

async function resolveTargetPeriod({ companyId, departmentId, timeInDate, cache }) {
  const cacheKey = `${companyId}_${departmentId}`;
  if (!cache.has(cacheKey)) {
    const periods = await prisma.cutoffPeriod.findMany({
      where: { companyId, departmentId, status: "open" },
      select: { id: true, periodStart: true, periodEnd: true, departmentId: true },
    });
    cache.set(cacheKey, periods);
  }
  const periods = cache.get(cacheKey);
  return (
    periods.find(
      (p) => new Date(p.periodStart) <= timeInDate && new Date(p.periodEnd) >= timeInDate
    ) || null
  );
}

async function main() {
  const noDeptPeriods = await prisma.cutoffPeriod.findMany({
    where: {
      departmentId: null,
      periodStart: new Date(`${TARGET_PERIOD_START}T00:00:00.000Z`),
      periodEnd: new Date(`${TARGET_PERIOD_END}T00:00:00.000Z`),
    },
  });

  if (noDeptPeriods.length === 0) {
    console.log(
      `No "No Department" CutoffPeriod found for ${TARGET_PERIOD_START} -> ${TARGET_PERIOD_END}. Nothing to check.`
    );
    return;
  }

  const targetPeriodCache = new Map();

  for (const period of noDeptPeriods) {
    console.log(
      `\n=== CutoffPeriod ${period.id} | ${fmt(period.periodStart)} -> ${fmt(period.periodEnd)} | company=${period.companyId} | status=${period.status} ===`
    );

    const approvals = await prisma.timeLogApproval.findMany({
      where: { cutoffPeriodId: period.id },
      select: {
        id: true,
        timeLogId: true,
        status: true,
        segmentType: true,
        timeLog: {
          select: {
            id: true,
            timeIn: true,
            userId: true,
            user: {
              select: {
                id: true,
                departmentId: true,
                profile: { select: { firstName: true, lastName: true } },
                department: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    console.log(`${approvals.length} TimeLogApproval row(s) found.\n`);

    let movable = 0;
    let blockedNoDept = 0;
    let blockedNoPeriod = 0;

    for (const approval of approvals) {
      const user = approval.timeLog?.user;
      const employeeName = user?.profile
        ? `${user.profile.firstName || ""} ${user.profile.lastName || ""}`.trim()
        : approval.timeLog?.userId || "(unknown)";
      const timeIn = approval.timeLog?.timeIn ? new Date(approval.timeLog.timeIn) : null;

      if (!user?.departmentId) {
        blockedNoDept++;
        console.log(
          `BLOCKED (no department) | approval=${approval.id} | seg=${approval.segmentType ?? "-"} | ${employeeName} | date=${timeIn ? fmt(timeIn) : "?"}`
        );
        continue;
      }

      const targetPeriod = await resolveTargetPeriod({
        companyId: period.companyId,
        departmentId: user.departmentId,
        timeInDate: timeIn,
        cache: targetPeriodCache,
      });

      if (!targetPeriod) {
        blockedNoPeriod++;
        console.log(
          `BLOCKED (no target period) | approval=${approval.id} | seg=${approval.segmentType ?? "-"} | ${employeeName} | dept=${user.department?.name || user.departmentId} | date=${timeIn ? fmt(timeIn) : "?"}`
        );
        continue;
      }

      movable++;
      console.log(
        `MOVABLE | approval=${approval.id} | seg=${approval.segmentType ?? "-"} | ${employeeName} | dept=${user.department?.name || user.departmentId} | date=${timeIn ? fmt(timeIn) : "?"} -> target period ${targetPeriod.id} (${fmt(targetPeriod.periodStart)} -> ${fmt(targetPeriod.periodEnd)})`
      );
    }

    console.log(
      `\n--- Summary for ${period.id} --- movable=${movable} | blocked-no-department=${blockedNoDept} | blocked-no-target-period=${blockedNoPeriod}`
    );
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
