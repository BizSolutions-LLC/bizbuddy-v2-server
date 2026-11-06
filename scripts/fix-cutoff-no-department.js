// scripts/fix-cutoff-no-department.js
//
// Generalized version of fix-cutoff-no-department-jan2026.js /
// fix-cutoff-no-department-feb2026.js — same BB-086 data fix, for any
// "No Department" CutoffPeriod date range instead of a hardcoded one.
// Companion to check-cutoff-no-department.js — run that first.
//
// Moves TimeLogApproval rows out of the "No Department" CutoffPeriod for the
// given dates into each employee's correct, already-existing, open
// department CutoffPeriod for the same dates. Uses the company-timezone
// end-of-day extension on periodEnd when matching (a naive UTC-midnight
// comparison misses punches on the period's last calendar day).
//
// Only touches rows where a target department period is unambiguously
// resolvable:
//   - Employees with no departmentId assigned are left untouched.
//   - Employees whose department has no open CutoffPeriod covering the date
//     are left untouched.
//
// Writes a backup of every row changed to
// scripts/backup-cutoff-no-department-<periodStart>_<periodEnd>.json before
// making any changes.
//
// Does NOT delete the emptied "No Department" period and does NOT recompute
// OT/hours — after running this, use the existing per-period "Sync" action
// on each affected department period.
//
// Usage:
//   node scripts/fix-cutoff-no-department.js <periodStart> <periodEnd>
//   node scripts/fix-cutoff-no-department.js 2026-02-18 2026-03-03

const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const [, , periodStartArg, periodEndArg] = process.argv;

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
  if (!periodStartArg || !periodEndArg) {
    console.log("Usage: node scripts/fix-cutoff-no-department.js <periodStart YYYY-MM-DD> <periodEnd YYYY-MM-DD>");
    process.exitCode = 1;
    return;
  }

  const backupPath = path.join(
    __dirname,
    `backup-cutoff-no-department-${periodStartArg}_${periodEndArg}.json`
  );

  const noDeptPeriods = await prisma.cutoffPeriod.findMany({
    where: {
      departmentId: null,
      periodStart: new Date(`${periodStartArg}T00:00:00.000Z`),
      periodEnd: new Date(`${periodEndArg}T00:00:00.000Z`),
    },
  });

  if (noDeptPeriods.length === 0) {
    console.log(`No "No Department" CutoffPeriod found for ${periodStartArg} -> ${periodEndArg}. Nothing to do.`);
    return;
  }

  const targetPeriodCache = new Map();
  const moves = [];
  const skippedNoDept = [];
  const skippedNoPeriod = [];

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
        timeLogId: true,
        timeLog: {
          select: {
            timeIn: true,
            userId: true,
            user: { select: { id: true, departmentId: true } },
          },
        },
      },
    });

    for (const approval of approvals) {
      const user = approval.timeLog?.user;
      const timeIn = approval.timeLog?.timeIn ? new Date(approval.timeLog.timeIn) : null;

      if (!user?.departmentId) {
        skippedNoDept.push({ approvalId: approval.id, userId: approval.timeLog?.userId });
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
        skippedNoPeriod.push({
          approvalId: approval.id,
          userId: user.id,
          departmentId: user.departmentId,
        });
        continue;
      }

      moves.push({
        approvalId: approval.id,
        timeLogId: approval.timeLogId,
        userId: user.id,
        oldCutoffPeriodId: period.id,
        newCutoffPeriodId: targetPeriod.id,
      });
    }
  }

  console.log(
    `Resolved: ${moves.length} movable, ${skippedNoDept.length} skipped (no department), ${skippedNoPeriod.length} skipped (no target period).`
  );

  if (moves.length === 0) {
    console.log("Nothing movable — no changes made.");
    return;
  }

  fs.writeFileSync(backupPath, JSON.stringify({ generatedAt: new Date().toISOString(), moves }, null, 2));
  console.log(`Backup written to ${backupPath} (${moves.length} row(s)).`);

  let updated = 0;
  for (const move of moves) {
    await prisma.timeLogApproval.update({
      where: { id: move.approvalId },
      data: { cutoffPeriodId: move.newCutoffPeriodId },
    });
    updated++;
  }

  console.log(`\nDone. ${updated} TimeLogApproval row(s) moved to their correct department period.`);
  if (skippedNoDept.length > 0) {
    console.log(`${skippedNoDept.length} row(s) left untouched — employee has no department assigned:`);
    console.log(skippedNoDept);
  }
  if (skippedNoPeriod.length > 0) {
    console.log(`${skippedNoPeriod.length} row(s) left untouched — no open department period covers this date:`);
    console.log(skippedNoPeriod);
  }

  const affectedPeriodIds = [...new Set(moves.map((m) => m.newCutoffPeriodId))];
  console.log(
    `\nNext step: run the "Sync" action on each affected department period to recompute OT/hours: ${affectedPeriodIds.join(", ")}`
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
