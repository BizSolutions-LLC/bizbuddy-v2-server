// Optional, one-off backfill: creates LeaveDay rows for approved Leave records
// that predate the Phase 4 proration logic (see docs/LEAVE_MODULE.md §13).
//
// Uniform backfill only — every day gets the leave's original whole-record
// isPaid value (no retroactive proration against historical balance, since
// there's no way to know what the balance actually was on each historical day).
// Uses the app's real calcDailyHours() so hours-per-day are accurate to actual
// scheduled shifts/holidays, not guessed at in raw SQL.
//
// Not required for the new approval flow — only new approvals need LeaveDay
// rows to work. Run this manually if/when you want historical data for reporting.
//
// Usage: node scripts/backfill-leave-days-legacy.js [--apply]
//   (no --apply = dry run, prints what would be inserted)

require("module-alias/register");
const { prisma } = require("@config/connection");
const { calcDailyHours } = require("@utils/leaveUtils");

const APPLY = process.argv.includes("--apply");

async function main() {
  const leaves = await prisma.leave.findMany({
    where: { status: "approved", days: { none: {} } },
    select: { id: true, userId: true, startDate: true, endDate: true, isPaid: true },
  });

  console.log(`Found ${leaves.length} approved leave(s) with no LeaveDay rows.`);

  let inserted = 0;
  for (const leave of leaves) {
    let days;
    try {
      days = await calcDailyHours(leave.userId, leave.startDate, leave.endDate);
    } catch (err) {
      console.warn(`  Skipping ${leave.id}: ${err.message}`);
      continue;
    }
    if (!days.length) continue;

    console.log(`  Leave ${leave.id}: ${days.length} day(s), isPaid=${leave.isPaid}`);

    if (APPLY) {
      await prisma.leaveDay.createMany({
        data: days.map((d) => ({
          leaveId: leave.id,
          date: new Date(d.date),
          isPaid: leave.isPaid,
          hours: d.hours,
        })),
        skipDuplicates: true,
      });
      inserted += days.length;
    }
  }

  console.log(APPLY ? `Inserted ${inserted} LeaveDay row(s).` : "Dry run only — pass --apply to write.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
