// scripts/check-cutoff-no-department-jan2026-round2.js
//
// Follow-up to check/fix-cutoff-no-department-jan2026.js. After round 1,
// 73 TimeLogApproval rows were left "blocked — no target period" even though
// all 73 belong to departments that DO have an open CutoffPeriod for
// Jan 7-20, 2026 (the same 3 departments round 1 successfully moved 663
// other rows into). That's suspicious on its own.
//
// Suspected cause: round 1's date-matching compared each TimeLog.timeIn
// against the target period's raw periodEnd (UTC midnight of the last
// calendar day), the same naive comparison the "Timezone-Aware Sync EOD"
// project convention warns against. The existing syncApprovalRecords()
// (cutoffPeriodController.js) avoids this by extending periodEnd to
// end-of-day in the COMPANY's timezone before comparing, since a late punch's
// UTC timestamp can roll into the next calendar day. This script re-checks
// the still-blocked rows using that same company-timezone-aware boundary.
//
// READ-ONLY — no writes.
//
// Usage:
//   node scripts/check-cutoff-no-department-jan2026-round2.js

const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TARGET_PERIOD_START = "2026-01-07";
const TARGET_PERIOD_END = "2026-01-20";

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
    where: {
      departmentId: null,
      periodStart: new Date(`${TARGET_PERIOD_START}T00:00:00.000Z`),
      periodEnd: new Date(`${TARGET_PERIOD_END}T00:00:00.000Z`),
    },
  });

  if (noDeptPeriods.length === 0) {
    console.log("No 'No Department' CutoffPeriod found for this range. Nothing left to check.");
    return;
  }

  const targetPeriodCache = new Map();

  for (const period of noDeptPeriods) {
    const company = await prisma.company.findUnique({
      where: { id: period.companyId },
      select: { timeZone: true },
    });
    const companyTimezone = company?.timeZone || "America/Los_Angeles";

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

    console.log(
      `\n=== Still in "No Department" period ${period.id} (company timezone: ${companyTimezone}) ===`
    );
    console.log(`${approvals.length} row(s) remaining.\n`);

    let nowMovable = 0;
    let stillBlocked = 0;

    for (const approval of approvals) {
      const user = approval.timeLog?.user;
      const timeIn = approval.timeLog?.timeIn ? new Date(approval.timeLog.timeIn) : null;
      const employeeName = user?.profile
        ? `${user.profile.firstName || ""} ${user.profile.lastName || ""}`.trim()
        : approval.timeLog?.userId || "(unknown)";

      if (!user?.departmentId) {
        console.log(`STILL BLOCKED (no department) | approval=${approval.id} | ${employeeName}`);
        stillBlocked++;
        continue;
      }

      const targetPeriod = await resolveTargetPeriod({
        companyId: period.companyId,
        departmentId: user.departmentId,
        timeInDate: timeIn,
        companyTimezone,
        cache: targetPeriodCache,
      });

      if (targetPeriod) {
        nowMovable++;
        console.log(
          `NOW MOVABLE | approval=${approval.id} | seg=${approval.segmentType ?? "-"} | ${employeeName} | dept=${user.department?.name || user.departmentId} | timeIn=${timeIn ? fmt(timeIn) : "?"} -> target ${targetPeriod.id} (${fmt(targetPeriod.periodStart)} -> ${fmt(targetPeriod.periodEnd)})`
        );
      } else {
        stillBlocked++;
        console.log(
          `STILL BLOCKED (no target period) | approval=${approval.id} | seg=${approval.segmentType ?? "-"} | ${employeeName} | dept=${user.department?.name || user.departmentId} | timeIn=${timeIn ? fmt(timeIn) : "?"}`
        );
      }
    }

    console.log(`\n--- Summary --- now-movable=${nowMovable} | still-blocked=${stillBlocked}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
