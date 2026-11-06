// scripts/check-cutoff-no-department-feb2026.js
//
// Same diagnostic as check-cutoff-no-department-jan2026.js, applied to the
// "No Department" CutoffPeriod for Feb 4-17, 2026. Target-period resolution
// uses the company-timezone end-of-day extension on periodEnd from the
// start (learned from the Jan 2026 fix's round-2: a naive UTC-midnight
// periodEnd comparison misses punches on the period's last calendar day in
// the company's local timezone).
//
// READ-ONLY — no writes. Run this before fix-cutoff-no-department-feb2026.js.
//
// Usage:
//   node scripts/check-cutoff-no-department-feb2026.js

const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TARGET_PERIOD_START = "2026-02-04";
const TARGET_PERIOD_END = "2026-02-17";

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
    console.log(
      `No "No Department" CutoffPeriod found for ${TARGET_PERIOD_START} -> ${TARGET_PERIOD_END}. Nothing to check.`
    );
    return;
  }

  const targetPeriodCache = new Map();

  for (const period of noDeptPeriods) {
    const company = await prisma.company.findUnique({
      where: { id: period.companyId },
      select: { timeZone: true },
    });
    const companyTimezone = company?.timeZone || "America/Los_Angeles";

    console.log(
      `\n=== CutoffPeriod ${period.id} | ${fmt(period.periodStart)} -> ${fmt(period.periodEnd)} | company=${period.companyId} | status=${period.status} | paymentDate=${fmt(period.paymentDate)} | timezone=${companyTimezone} ===`
    );

    const approvals = await prisma.timeLogApproval.findMany({
      where: { cutoffPeriodId: period.id },
      select: {
        id: true,
        timeLogId: true,
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
          `BLOCKED (no department) | approval=${approval.id} | seg=${approval.segmentType ?? "-"} | ${employeeName} | timeIn=${timeIn ? fmt(timeIn) : "?"}`
        );
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
        console.log(
          `BLOCKED (no target period) | approval=${approval.id} | seg=${approval.segmentType ?? "-"} | ${employeeName} | dept=${user.department?.name || user.departmentId} | timeIn=${timeIn ? fmt(timeIn) : "?"}`
        );
        continue;
      }

      movable++;
      console.log(
        `MOVABLE | approval=${approval.id} | seg=${approval.segmentType ?? "-"} | ${employeeName} | dept=${user.department?.name || user.departmentId} | timeIn=${timeIn ? fmt(timeIn) : "?"} -> target period ${targetPeriod.id} (${fmt(targetPeriod.periodStart)} -> ${fmt(targetPeriod.periodEnd)})`
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
