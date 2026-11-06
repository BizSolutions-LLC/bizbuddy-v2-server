// scripts/check-cutoff-jan21-feb3-2026.js
//
// Diagnostic only — checks whether a "No Department" CutoffPeriod for
// Jan 21 - Feb 3, 2026 currently exists, and if not, whether there's
// evidence it existed and was deleted (orphaned TimeLog rows in that date
// range with zero TimeLogApproval attached, which would happen if a period
// covering them was hard-deleted).
//
// Context: delete-cutoff-no-department-jan2026.js only ever matched periods
// with the EXACT dates periodStart=2026-01-07 / periodEnd=2026-01-20 AND
// departmentId: null (a Prisma equality filter, not a range) — it could not
// have matched or deleted a Jan 21 - Feb 3 period regardless of department.
// This script exists to confirm the actual current state either way rather
// than assume.
//
// READ-ONLY — no writes.
//
// Usage:
//   node scripts/check-cutoff-jan21-feb3-2026.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RANGE_START = "2026-01-21";
const RANGE_END = "2026-02-03";

function fmt(date) {
  return new Date(date).toISOString().slice(0, 10);
}

async function main() {
  // 1. Any CutoffPeriod at all overlapping this range (any department).
  const periods = await prisma.cutoffPeriod.findMany({
    where: {
      OR: [
        { periodStart: new Date(`${RANGE_START}T00:00:00.000Z`) },
        { periodEnd: new Date(`${RANGE_END}T00:00:00.000Z`) },
      ],
    },
    include: { department: { select: { name: true } } },
    orderBy: [{ companyId: "asc" }, { departmentId: "asc" }],
  });

  console.log(`=== CutoffPeriod rows with periodStart=${RANGE_START} or periodEnd=${RANGE_END} ===`);
  if (periods.length === 0) {
    console.log("NONE FOUND — no period (any department) currently has these exact dates.\n");
  } else {
    for (const p of periods) {
      const approvalCount = await prisma.timeLogApproval.count({ where: { cutoffPeriodId: p.id } });
      console.log(
        `id=${p.id} | dept=${p.department?.name || "No Department"} | company=${p.companyId} | ${fmt(p.periodStart)} -> ${fmt(p.periodEnd)} | status=${p.status} | approvals=${approvalCount}`
      );
    }
    console.log("");
  }

  // 2. Orphan check: TimeLog rows whose timeIn falls in this range but have
  // zero TimeLogApproval rows pointing at them at all (any period). If a
  // period covering these was deleted (cascade), its approvals are gone,
  // and these TimeLogs would now show 0 approvals where they should show 1
  // (or 3, for DRIVER_AIDE segments).
  const rangeStart = new Date(`${RANGE_START}T00:00:00.000Z`);
  const rangeEndExclusive = new Date(`${RANGE_END}T23:59:59.999Z`);

  const timeLogsInRange = await prisma.timeLog.findMany({
    where: {
      timeIn: { gte: rangeStart, lte: rangeEndExclusive },
      timeOut: { not: null },
    },
    select: {
      id: true,
      userId: true,
      timeIn: true,
      punchType: true,
      user: { select: { departmentId: true, profile: { select: { firstName: true, lastName: true } } } },
      approvals: { select: { id: true, cutoffPeriodId: true } },
    },
  });

  const orphans = timeLogsInRange.filter((tl) => tl.approvals.length === 0);

  console.log(`=== TimeLog rows in ${RANGE_START}..${RANGE_END} with ZERO TimeLogApproval rows ===`);
  console.log(`${orphans.length} of ${timeLogsInRange.length} completed TimeLog(s) in this range have no approval record at all.\n`);
  if (orphans.length > 0) {
    console.log("This is evidence a covering CutoffPeriod for these existed and was deleted (cascade removed their approvals), or they were never synced. Sample (first 20):");
    for (const tl of orphans.slice(0, 20)) {
      const name = tl.user?.profile ? `${tl.user.profile.firstName || ""} ${tl.user.profile.lastName || ""}`.trim() : tl.userId;
      console.log(`  timeLog=${tl.id} | ${name} | dept=${tl.user?.departmentId || "(none)"} | timeIn=${new Date(tl.timeIn).toISOString()} | punchType=${tl.punchType}`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
