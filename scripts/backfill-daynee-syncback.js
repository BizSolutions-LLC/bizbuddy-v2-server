// scripts/backfill-daynee-syncback.js
// One-time backfill: for DRIVER_AIDE timelogs where all 3 segments are approved
// but the TimeLog fields were never synced back (approved before v2.10.19).
//
// Runs syncApprovedSegmentsToTimeLog logic inline for the qualifying record
// belonging to Daynee Cuaresma for Jun 10 only (test run).
//
// Also zeroes rawOtMinutes — for approved DRIVER_AIDE punches in raw mode,
// post-window time is absorbed into the PM segment's actualHours; the per-punch
// OT stub is no longer meaningful and should not render in the UI.
//
// DRY RUN by default — pass --apply to write changes.

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DRY_RUN = !process.argv.includes("--apply");

async function main() {
  console.log(DRY_RUN ? "🔍 DRY RUN — pass --apply to commit changes\n" : "✏️  APPLYING changes\n");

  const user = await prisma.user.findFirst({
    where: {
      profile: {
        AND: [
          { firstName: { contains: "Daynee",   mode: "insensitive" } },
          { lastName:  { contains: "Cuaresma", mode: "insensitive" } },
        ],
      },
    },
    include: { profile: true },
  });

  if (!user) { console.log("❌ User not found."); return; }
  console.log(`User: ${user.profile?.firstName} ${user.profile?.lastName} (${user.id})\n`);

  // Jun 10 only (America/Los_Angeles = UTC-7 in June → Jun 10 00:00 PDT = 07:00 UTC)
  const periodStart = new Date("2026-06-10T07:00:00.000Z");
  const periodEnd   = new Date("2026-06-11T07:00:00.000Z");

  const timeLogs = await prisma.timeLog.findMany({
    where: {
      userId:    user.id,
      punchType: "DRIVER_AIDE",
      timeIn:    { gte: periodStart, lt: periodEnd },
    },
    include: {
      approvals: {
        where:  { status: "approved" },
        select: { segmentType: true, actualHours: true, cutoffPeriodId: true },
      },
    },
    orderBy: { timeIn: "asc" },
  });

  let updated = 0;

  for (const tl of timeLogs) {
    // Verify all 3 segments are approved
    const segMap = {};
    for (const a of tl.approvals) {
      if (a.actualHours != null) segMap[a.segmentType] = parseFloat(a.actualHours);
    }

    if (segMap.driver_am == null || segMap.regular == null || segMap.driver_pm == null) {
      console.log(`⚠️  ${tl.timeIn.toISOString().slice(0,10)} — skipped: not all 3 segments approved`);
      continue;
    }

    const newNet = parseFloat((segMap.driver_am + segMap.regular + segMap.driver_pm).toFixed(2));
    const oldNet = tl.netWorkedHours != null ? parseFloat(tl.netWorkedHours) : null;

    console.log(`${tl.timeIn.toISOString().slice(0,10)}  id: ${tl.id}`);
    console.log(`  AM:           ${tl.driverAmSegmentHours ?? "null"} → ${segMap.driver_am}`);
    console.log(`  REG:          ${tl.regularSegmentHours  ?? "null"} → ${segMap.regular}`);
    console.log(`  PM:           ${tl.driverPmSegmentHours ?? "null"} → ${segMap.driver_pm}`);
    console.log(`  net:          ${oldNet ?? "null"} → ${newNet}`);
    console.log(`  rawOtMinutes: ${tl.rawOtMinutes ?? "null"} → 0`);

    if (!DRY_RUN) {
      await prisma.timeLog.update({
        where: { id: tl.id },
        data: {
          driverAmSegmentHours: segMap.driver_am,
          regularSegmentHours:  segMap.regular,
          driverPmSegmentHours: segMap.driver_pm,
          netWorkedHours:       newNet,
          rawOtMinutes:         0,
        },
      });
      console.log(`  ✅ updated`);
    }
    console.log();
    updated++;
  }

  console.log(`${DRY_RUN ? "Would update" : "Updated"} ${updated} record(s).`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
