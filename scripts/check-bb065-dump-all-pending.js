// scripts/check-bb065-dump-all-pending.js
//
// BB-065 — Prior narrower searches (by UTC date range, by UTC clock hour) both
// came back with zero matches for the Jul 29 08:00-13:30 pending request, which
// means an assumption about how requestedDate/requestedClockIn are stored is
// wrong (likely a timezone offset — requestedClockIn is probably stored as the
// actual instant corresponding to company-local time, not literally 08:00 UTC).
// Rather than guess again, this dumps ALL PENDING requests in full, with clock
// times rendered in each employee's company timezone so we can eyeball the
// right one directly.
//
// READ-ONLY — no writes.
//
// Usage: node scripts/check-bb065-dump-all-pending.js

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

function fmtUtc(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtLocal(d, tz) {
  if (!d) return "—";
  return moment(d).tz(tz || "UTC").format("YYYY-MM-DD (ddd) hh:mm A z");
}

async function main() {
  const pending = await prisma.requestedTimeLog.findMany({
    where: { status: "PENDING" },
    orderBy: { requestedDate: "asc" },
    include: {
      user: {
        select: {
          email: true,
          profile: { select: { firstName: true, lastName: true } },
          company: { select: { name: true, timeZone: true } },
        },
      },
    },
  });

  console.log(`=== All PENDING RequestedTimeLog rows: ${pending.length} ===\n`);

  for (const r of pending) {
    const name = r.user?.profile ? `${r.user.profile.firstName} ${r.user.profile.lastName}` : r.user?.email;
    const tz = r.user?.company?.timeZone || "UTC";
    console.log(`--- ${r.id} ---`);
    console.log(`  employee: ${name}  company: ${r.user?.company?.name || "—"} (tz=${tz})`);
    console.log(`  reason: "${r.reason || "—"}"`);
    console.log(`  requestedDate: UTC=${fmtUtc(r.requestedDate)}  local=${fmtLocal(r.requestedDate, tz)}`);
    console.log(`  requestedClockIn: UTC=${fmtUtc(r.requestedClockIn)}  local=${fmtLocal(r.requestedClockIn, tz)}`);
    console.log(`  requestedClockOut: UTC=${fmtUtc(r.requestedClockOut)}  local=${fmtLocal(r.requestedClockOut, tz)}`);
    console.log(`  estimatedDuration: ${r.estimatedDuration} min  estimatedNetHours: ${r.estimatedNetHours}`);
    console.log(`  submittedAt: ${fmtUtc(r.submittedAt)}`);
    console.log("");
  }

  console.log("No changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
