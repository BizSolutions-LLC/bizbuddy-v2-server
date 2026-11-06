// scripts/check-bb065-find-pending-jul29.js
//
// BB-065 — The targeted fix (fix-bb065-pending-estimate-jul29.js) found zero
// matches for status=PENDING, requestedDate=2026-07-29, estimatedNetHours=4.5.
// Widening the search to figure out why: could be a timezone shift on
// requestedDate (off by a day), a stored estimatedNetHours that isn't exactly
// 4.5, or a status string that isn't literally "PENDING".
//
// READ-ONLY — no writes.
//
// Usage: node scripts/check-bb065-find-pending-jul29.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

async function main() {
  // ── Wide net: any PENDING request with requestedDate within a few days of Jul 29 ──
  const wideDateMatches = await prisma.requestedTimeLog.findMany({
    where: {
      status: "PENDING",
      requestedDate: {
        gte: new Date("2026-07-27T00:00:00.000Z"),
        lte: new Date("2026-07-31T23:59:59.999Z"),
      },
    },
    include: {
      user: { select: { email: true, profile: { select: { firstName: true, lastName: true } } } },
    },
  });

  console.log(`=== PENDING requests with requestedDate between Jul 27-31, 2026: ${wideDateMatches.length} ===`);
  for (const r of wideDateMatches) {
    const name = r.user?.profile ? `${r.user.profile.firstName} ${r.user.profile.lastName}` : r.user?.email;
    console.log(`  --- ${r.id} ---`);
    console.log(`    employee: ${name}`);
    console.log(`    requestedDate: ${fmt(r.requestedDate)}`);
    console.log(`    requestedClockIn: ${fmt(r.requestedClockIn)}  requestedClockOut: ${fmt(r.requestedClockOut)}`);
    console.log(`    estimatedDuration: ${r.estimatedDuration}  estimatedNetHours: ${r.estimatedNetHours}  (typeof: ${typeof r.estimatedNetHours})`);
    console.log(`    reason: "${r.reason || "—"}"  status: "${r.status}"`);
    console.log(`    submittedAt: ${fmt(r.submittedAt)}`);
  }

  // ── Separately: any request (any status) whose clock times match 08:00-13:30 on any date ──
  const allPending = await prisma.requestedTimeLog.findMany({
    where: { status: "PENDING" },
    select: {
      id: true,
      requestedDate: true,
      requestedClockIn: true,
      requestedClockOut: true,
      estimatedNetHours: true,
      status: true,
      user: { select: { email: true, profile: { select: { firstName: true, lastName: true } } } },
    },
  });

  const clockMatches = allPending.filter((r) => {
    const inH = new Date(r.requestedClockIn).getUTCHours();
    const outH = new Date(r.requestedClockOut).getUTCHours();
    const outM = new Date(r.requestedClockOut).getUTCMinutes();
    return inH === 8 && outH === 13 && outM === 30;
  });

  console.log(`\n=== ALL PENDING requests (any date) with clockIn=08:00 UTC and clockOut=13:30 UTC: ${clockMatches.length} ===`);
  for (const r of clockMatches) {
    const name = r.user?.profile ? `${r.user.profile.firstName} ${r.user.profile.lastName}` : r.user?.email;
    console.log(`  id=${r.id} employee=${name} requestedDate=${fmt(r.requestedDate)} estimatedNetHours=${r.estimatedNetHours}`);
  }

  console.log(`\n=== Total PENDING requests in the whole table (sanity check): ${allPending.length} ===`);

  console.log("\nNo changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
