// scripts/fix-cutoff-no-department-all.js
//
// Companion to check-cutoff-no-department-all.js — run that first.
//
// Finds EVERY open "No Department" CutoffPeriod (departmentId: null, any
// dates) and moves each one's TimeLogApproval rows into the correct, already-
// existing, open department CutoffPeriod for the same dates — the same
// BB-086 fix as fix-cutoff-no-department.js, applied to all remaining
// periods in one run instead of one date range at a time.
//
// Only touches rows where a target department period is unambiguously
// resolvable (company-timezone end-of-day extension on periodEnd used for
// matching):
//   - Employees with no departmentId assigned are left untouched.
//   - Employees whose department has no open CutoffPeriod covering the date
//     are left untouched.
// Periods with status other than "open" are skipped entirely, untouched.
//
// Writes ONE combined backup file, scripts/backup-cutoff-no-department-all.json,
// containing every row moved across every period, before making any changes.
//
// Does NOT delete any emptied "No Department" periods and does NOT recompute
// OT/hours — after running this, use the existing per-period "Sync" action
// on each affected department period (this script prints the full list at
// the end).
//
// Usage:
//   node scripts/fix-cutoff-no-department-all.js

const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BACKUP_PATH = path.join(__dirname, "backup-cutoff-no-department-all.json");

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
    where: { departmentId: null, status: "open" },
    orderBy: { periodStart: "asc" },
  });

  if (noDeptPeriods.length === 0) {
    console.log(`No open "No Department" CutoffPeriod rows found. Nothing to do.`);
    return;
  }

  console.log(`Found ${noDeptPeriods.length} open "No Department" CutoffPeriod row(s) to process.\n`);

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

    const periodLabel = `${new Date(period.periodStart).toISOString().slice(0, 10)} -> ${new Date(period.periodEnd).toISOString().slice(0, 10)}`;

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

    let periodMoved = 0;

    for (const approval of approvals) {
      const user = approval.timeLog?.user;
      const timeIn = approval.timeLog?.timeIn ? new Date(approval.timeLog.timeIn) : null;

      if (!user?.departmentId) {
        skippedNoDept.push({ approvalId: approval.id, userId: approval.timeLog?.userId, sourcePeriod: period.id, sourcePeriodLabel: periodLabel });
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
          sourcePeriod: period.id,
          sourcePeriodLabel: periodLabel,
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
      periodMoved++;
    }

    console.log(`[${periodLabel}] ${period.id}: ${periodMoved} of ${approvals.length} row(s) resolved.`);
  }

  console.log(
    `\nResolved: ${moves.length} movable, ${skippedNoDept.length} skipped (no department), ${skippedNoPeriod.length} skipped (no target period).`
  );

  if (moves.length === 0) {
    console.log("Nothing movable — no changes made.");
    return;
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), moves }, null, 2));
  console.log(`Backup written to ${BACKUP_PATH} (${moves.length} row(s)).`);

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
    `\nNext step: run the "Sync" action on each affected department period to recompute OT/hours (${affectedPeriodIds.length} period(s)):\n${affectedPeriodIds.join("\n")}`
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
