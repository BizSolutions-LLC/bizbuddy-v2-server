// scripts/check-cutoff-no-department-all.js
//
// Finds EVERY "No Department" CutoffPeriod (departmentId: null, any dates)
// still in the database and runs the same BB-086 diagnostic against each one
// — no need to hunt for date ranges one at a time in the UI.
//
// For each one, classifies every TimeLogApproval under it as:
//   - MOVABLE             — an open department CutoffPeriod exists that
//                            covers the employee's TimeLog date (company-
//                            timezone end-of-day extension on periodEnd)
//   - BLOCKED (no dept)   — employee has no departmentId assigned
//   - BLOCKED (no period) — employee has a department, but no open period
//                           covers this date for it
//
// READ-ONLY — no writes. Run this before fix-cutoff-no-department-all.js.
//
// Usage:
//   node scripts/check-cutoff-no-department-all.js

const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function fmt(date) {
  return new Date(date).toISOString();
}

async function resolveTargetPeriod({ companyId, departmentId, timeInDate, companyTimezone, cache }) {
  const cacheKey = `${companyId}_${departmentId}`;
  if (!cache.has(cacheKey)) {
    const periods = await prisma.cutoffPeriod.findMany({
      where: { companyId, departmentId, status: "open" },
      select: { id: true, periodStart: true, periodEnd: true },
    });
    cache.set(cacheKey, periods);
  }
  const periods = cache.get(cacheKey);
  return (
    periods.find((p) => {
      const start = new Date(p.periodStart);
      const endDateStr = new Date(p.periodEnd).toISOString().slice(0, 10);
      const endEOD = moment.tz(endDateStr, companyTimezone).endOf("day").toDate();
      return start <= timeInDate && endEOD >= timeInDate;
    }) || null
  );
}

async function main() {
  const noDeptPeriods = await prisma.cutoffPeriod.findMany({
    where: { departmentId: null },
    orderBy: { periodStart: "asc" },
  });

  if (noDeptPeriods.length === 0) {
    console.log(`No "No Department" CutoffPeriod rows found at all. Nothing to check.`);
    return;
  }

  console.log(`Found ${noDeptPeriods.length} "No Department" CutoffPeriod row(s) total.\n`);

  const targetPeriodCache = new Map();
  let grandMovable = 0;
  let grandBlockedNoDept = 0;
  let grandBlockedNoPeriod = 0;

  for (const period of noDeptPeriods) {
    const company = await prisma.company.findUnique({
      where: { id: period.companyId },
      select: { timeZone: true },
    });
    const companyTimezone = company?.timeZone || "America/Los_Angeles";

    console.log(
      `\n=== CutoffPeriod ${period.id} | ${fmt(period.periodStart).slice(0, 10)} -> ${fmt(period.periodEnd).slice(0, 10)} | company=${period.companyId} | status=${period.status} | paymentDate=${fmt(period.paymentDate).slice(0, 10)} ===`
    );

    if (period.status !== "open") {
      console.log(`SKIPPED — status is "${period.status}", not "open". Won't be touched by the fix script either.`);
      continue;
    }

    const approvals = await prisma.timeLogApproval.findMany({
      where: { cutoffPeriodId: period.id },
      select: {
        id: true,
        segmentType: true,
        timeLog: {
          select: {
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

    console.log(`${approvals.length} TimeLogApproval row(s) found.`);

    let movable = 0;
    let blockedNoDept = 0;
    let blockedNoPeriod = 0;

    for (const approval of approvals) {
      const user = approval.timeLog?.user;
      const timeIn = approval.timeLog?.timeIn ? new Date(approval.timeLog.timeIn) : null;

      if (!user?.departmentId) {
        blockedNoDept++;
        continue;
      }

      const targetPeriod = await resolveTargetPeriod({
        companyId: period.companyId,
        departmentId: user.departmentId,
        timeInDate: timeIn,
        companyTimezone,
        cache: targetPeriodCache,
      });

      if (!targetPeriod) {
        blockedNoPeriod++;
        continue;
      }

      movable++;
    }

    console.log(`--- movable=${movable} | blocked-no-department=${blockedNoDept} | blocked-no-target-period=${blockedNoPeriod}`);

    grandMovable += movable;
    grandBlockedNoDept += blockedNoDept;
    grandBlockedNoPeriod += blockedNoPeriod;
  }

  console.log(
    `\n=== TOTAL across all "No Department" periods === movable=${grandMovable} | blocked-no-department=${grandBlockedNoDept} | blocked-no-target-period=${grandBlockedNoPeriod}`
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
