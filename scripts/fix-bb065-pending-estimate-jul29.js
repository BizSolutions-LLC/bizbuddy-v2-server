// scripts/fix-bb065-pending-estimate-jul29.js
//
// BB-065 — Correct the stale estimatedNetHours on the still-PENDING Request Punch
// for Wed Jul 29, 2026 (08:00 AM - 01:30 PM, "Forgot To Clock") currently showing
// 4.50h in the pending queue. Per the BB-065 policy decision, a manual request has
// no break data to assume from, so the claimed span should be taken at face value:
// 08:00-13:30 = 5.50h gross, not 4.50h (which was computed under the old, now-
// removed, "always deduct minimumLunchMinutes" rule).
//
// This request is still PENDING — no TimeLog exists for it yet, so this only
// corrects the display estimate on RequestedTimeLog. It does NOT touch payroll
// data. (Already-approved records with the same problem are handled separately —
// see check-bb065-request-punch-lunch-deduction-scope.js for that list.)
//
// SAFETY: this script requires EXACTLY ONE unambiguous match before writing
// anything. If zero or multiple rows match, it aborts without making any change.
//
// This is a WRITE. Review the "would update" output below before running for
// real — run once to preview, confirm the single match is correct, then it
// performs the update.
//
// Usage: node scripts/fix-bb065-pending-estimate-jul29.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

async function main() {
  const candidates = await prisma.requestedTimeLog.findMany({
    where: {
      status: "PENDING",
      requestedDate: {
        gte: new Date("2026-07-29T00:00:00.000Z"),
        lte: new Date("2026-07-29T23:59:59.999Z"),
      },
      estimatedNetHours: 4.5,
    },
    include: {
      user: {
        select: { email: true, companyId: true, profile: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  if (candidates.length === 0) {
    console.log(
      "No PENDING RequestedTimeLog found for 2026-07-29 with estimatedNetHours=4.5. " +
        "Nothing to fix (already corrected, or the criteria no longer match — check manually before assuming)."
    );
    return;
  }

  if (candidates.length > 1) {
    console.log(`Found ${candidates.length} matching rows — refusing to update ambiguously. Disambiguate manually:`);
    for (const c of candidates) {
      const name = c.user?.profile ? `${c.user.profile.firstName} ${c.user.profile.lastName}` : c.user?.email;
      console.log(`  id=${c.id} employee=${name} clockIn=${fmt(c.requestedClockIn)} clockOut=${fmt(c.requestedClockOut)}`);
    }
    return;
  }

  const target = candidates[0];
  const name = target.user?.profile ? `${target.user.profile.firstName} ${target.user.profile.lastName}` : target.user?.email;

  const grossMinutes = Math.round(
    (new Date(target.requestedClockOut).getTime() - new Date(target.requestedClockIn).getTime()) / 60000
  );
  const correctedNetHours = +(grossMinutes / 60).toFixed(2);

  console.log("=== Found exactly one match ===");
  console.log(`  RequestedTimeLog id: ${target.id}`);
  console.log(`  employee: ${name}`);
  console.log(`  requestedClockIn: ${fmt(target.requestedClockIn)}  requestedClockOut: ${fmt(target.requestedClockOut)}`);
  console.log(`  current estimatedDuration: ${target.estimatedDuration} min   current estimatedNetHours: ${target.estimatedNetHours}h`);
  console.log(`  corrected estimatedDuration: ${grossMinutes} min   corrected estimatedNetHours: ${correctedNetHours}h`);

  const updated = await prisma.requestedTimeLog.update({
    where: { id: target.id },
    data: {
      estimatedDuration: grossMinutes,
      estimatedNetHours: correctedNetHours,
    },
  });

  console.log("\n=== Updated ===");
  console.log(`  RequestedTimeLog ${updated.id}: estimatedDuration=${updated.estimatedDuration} estimatedNetHours=${updated.estimatedNetHours}`);
  console.log("Done. This only changed the pending-queue display estimate — no TimeLog/payroll data was touched.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
