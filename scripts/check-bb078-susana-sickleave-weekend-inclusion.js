// scripts/check-bb078-susana-sickleave-weekend-inclusion.js
//
// BB-078 — Susana Pagaran's Sick Leave (Wed Aug 12 - Fri Aug 21, 2026) shows Saturday
// and Sunday counted in its "Actual Day-by-Day Outcome" panel. BB-054 made weekend
// inclusion an explicit opt-out (Leave.includeWeekends, default true) rather than a bug —
// this script confirms which side of that this specific record actually landed on:
// includeWeekends stored true/false, plus the persisted LeaveDay rows so the Sat/Sun
// hours can be seen directly instead of inferred from the UI screenshot.
//
// Lists ALL Leave rows overlapping August 2026 (not filtered by type/email — earlier,
// narrower versions of this script found nothing, so this widens to a sanity-check pass;
// scan the printed employee/leaveType/policy.name to find Susana's record by eye).
//
// READ-ONLY — no writes.
//
// Usage: node scripts/check-bb078-susana-sickleave-weekend-inclusion.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const totalLeaveCount = await prisma.leave.count();
  console.log(`Sanity check: ${totalLeaveCount} total Leave row(s) reachable in this DB.\n`);

  if (totalLeaveCount === 0) {
    console.log("The Leave table is empty from this script's connection — this is likely pointed at the wrong");
    console.log("DATABASE_URL (a different DB than what the app/UI actually reads). Verify .env before digging further.");
    return;
  }

  // Dropped the leaveType text filter — the schema comment on Leave.leaveType notes it's a
  // "legacy/display field" that "still holds the policy id today," so a substring match like
  // "sick" may never hit real data. Widened to just the August 2026 date-range overlap, and
  // joined `policy.name` so we can see the actual human-readable leave type per row instead.
  const leaves = await prisma.leave.findMany({
    where: {
      OR: [
        { startDate: { gte: new Date("2026-08-01"), lte: new Date("2026-08-31") } },
        { endDate: { gte: new Date("2026-08-01"), lte: new Date("2026-08-31") } },
      ],
    },
    orderBy: { startDate: "desc" },
    select: {
      id: true,
      leaveType: true,
      status: true,
      isPaid: true,
      startDate: true,
      endDate: true,
      includeWeekends: true,
      excludedShiftIds: true,
      requestedStartTime: true,
      requestedEndTime: true,
      createdAt: true,
      policy: { select: { leaveType: true } },
      User: { select: { email: true, employeeId: true } },
      days: { orderBy: { date: "asc" }, select: { date: true, isPaid: true, hours: true } },
    },
  });

  if (leaves.length === 0) {
    console.log("No Leave rows at all overlap August 2026. Double-check the year/month, or that this DB has this data.");
    return;
  }

  console.log(`=== ${leaves.length} Leave row(s) overlapping August 2026 (any type) ===\n`);

  for (const leave of leaves) {
    const start = leave.startDate.toISOString().slice(0, 10);
    const end = leave.endDate.toISOString().slice(0, 10);
    console.log(`--- Leave ${leave.id} — ${start}..${end} (status: ${leave.status}) ---`);
    console.log(`  employee: ${leave.User?.email || "(no email)"} / employeeId=${leave.User?.employeeId || "n/a"}`);
    console.log(`  leaveType (raw): ${leave.leaveType} | policy.leaveType: ${leave.policy?.leaveType || "(no policy linked)"}`);
    console.log(`  includeWeekends: ${leave.includeWeekends}`);
    console.log(`  excludedShiftIds: ${JSON.stringify(leave.excludedShiftIds)}`);
    console.log(`  isPaid (submitted intent): ${leave.isPaid}`);
    console.log(`  requestedStartTime/EndTime: ${leave.requestedStartTime || "null"} / ${leave.requestedEndTime || "null"}`);
    console.log(`  createdAt: ${leave.createdAt.toISOString()}`);
    console.log(`  LeaveDay rows (${leave.days.length}):`);

    for (const d of leave.days) {
      const dateStr = d.date.toISOString().slice(0, 10);
      const dow = d.date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
      const isWeekend = d.date.getUTCDay() === 0 || d.date.getUTCDay() === 6;
      console.log(
        `    ${dateStr} (${dow})${isWeekend ? " [WEEKEND]" : ""}: ${Number(d.hours)}h ${d.isPaid ? "Paid" : "Unpaid"}`
      );
    }
    console.log("");
  }

  console.log("No changes were made by this script.");
  console.log(
    "Interpretation: if includeWeekends is true, weekends being counted matches BB-054's documented default " +
      "(opt-out design — see docs/CLIENT_LEAVE_CONTRACT.md). If includeWeekends is false but the LeaveDay rows " +
      "above still show nonzero hours on the [WEEKEND] rows, that would be a genuine bug in calcDailyHours/the " +
      "approval flow, not a default-behavior question."
  );
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
