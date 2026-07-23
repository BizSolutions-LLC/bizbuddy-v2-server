// scripts/backfill-syncback-evelyn-jul8.js
// BB-057 sanity check — scoped to ONE record (Evelyn Garnace, Jul 8 2026) before running
// the full backfill-syncback-excluded-segments.js against all 377 flagged records.
//
// Same logic as backfill-syncback-excluded-segments.js (fixed sync-back: excluded
// segments write 0, approved segments write their actualHours), but filtered to a
// single user/date so the diff can be eyeballed before trusting the broader run.
//
// Usage:
//   node scripts/backfill-syncback-evelyn-jul8.js           → dry run (just prints the diff)
//   node scripts/backfill-syncback-evelyn-jul8.js --apply   → write to DB for this record only
//   node scripts/backfill-syncback-evelyn-jul8.js --revert  → restore from backup JSON

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const fs   = require("fs");
const path = require("path");

const prisma       = new PrismaClient();
const FIRST_NAME   = "Evelyn";
const LAST_NAME    = "Garnace";
const TIMELOG_ID   = "cmrc72g3o1dq2vh504czhhmkz"; // confirmed Jul 8 2026 07:49 AM Pacific punch
const BACKUP_FILE  = path.join(__dirname, "backup-syncback-evelyn-jul8.json");

const DRY_RUN = !process.argv.includes("--apply") && !process.argv.includes("--revert");
const REVERT  = process.argv.includes("--revert");

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`❌ Backup file not found: ${BACKUP_FILE}`);
    console.log("   Run without --apply first to generate the backup.");
    return;
  }
  const [r] = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  await prisma.timeLog.update({
    where: { id: r.id },
    data: {
      driverAmSegmentHours: r.driverAmSegmentHours,
      regularSegmentHours:  r.regularSegmentHours,
      driverPmSegmentHours: r.driverPmSegmentHours,
      netWorkedHours:       r.netWorkedHours,
      rawOtMinutes:         r.rawOtMinutes,
    },
  });
  console.log(`✅ Reverted ${r.id} (${r._date})`);
}

async function main() {
  if (REVERT) { await revert(); return; }

  console.log(DRY_RUN
    ? "🔍 DRY RUN — pass --apply to write changes\n"
    : "✏️  APPLYING changes\n"
  );

  const users = await prisma.user.findMany({
    where: {
      profile: {
        firstName: { equals: FIRST_NAME, mode: "insensitive" },
        lastName:  { equals: LAST_NAME,  mode: "insensitive" },
      },
    },
    select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
  });
  if (users.length === 0) {
    console.log(`❌ No user found named ${FIRST_NAME} ${LAST_NAME} — check spelling and re-run.`);
    return;
  }
  if (users.length > 1) {
    console.log(`⚠️  Found ${users.length} users named ${FIRST_NAME} ${LAST_NAME} — narrow by email manually:`);
    users.forEach((u) => console.log(`   ${u.id}  ${u.email}`));
    return;
  }
  const user = users[0];
  const name = `${user.profile?.firstName ?? ""} ${user.profile?.lastName ?? ""}`.trim();
  console.log(`Matched user: ${name}  <${user.email}>\n`);

  // Narrowed to the exact record after inspecting both matches in the Jul 7-9 window —
  // this is the 07:49 AM Pacific (14:49 UTC) Jul 8 punch from the screenshot; the other
  // match in that window was an unrelated Jul 7 punch.
  const timeLogs = await prisma.timeLog.findMany({
    where: { id: TIMELOG_ID },
    select: {
      id: true, timeIn: true, timeOut: true,
      driverAmSegmentHours: true, regularSegmentHours: true, driverPmSegmentHours: true,
      netWorkedHours: true, rawOtMinutes: true,
    },
    orderBy: { timeIn: "asc" },
  });

  if (timeLogs.length === 0) {
    console.log(`❌ No TimeLog found with id ${TIMELOG_ID} for ${name} — check the id and re-run.`);
    return;
  }

  const tl = timeLogs[0];
  const date = tl.timeIn.toISOString().slice(0, 10);
  console.log(`Found: ${name}  ${date}  id:${tl.id}\n`);

  const segs = await prisma.timeLogApproval.findMany({
    where:  { timeLogId: tl.id, segmentType: { not: null } },
    select: { cutoffPeriodId: true, segmentType: true, status: true, actualHours: true },
  });

  console.log("Segment approvals found:");
  segs.forEach((s) =>
    console.log(`  ${s.segmentType}: ${s.status}  actualHours:${s.actualHours ?? "null"}  cutoffPeriodId:${s.cutoffPeriodId}`)
  );
  console.log("");

  const hasAllTerminal = segs.length >= 3 &&
    segs.every((s) => s.status === "approved" || s.status === "excluded") &&
    segs.some((s) => s.segmentType === "driver_am") &&
    segs.some((s) => s.segmentType === "regular") &&
    segs.some((s) => s.segmentType === "driver_pm");

  if (!hasAllTerminal) {
    console.log("⚠️  Not all 3 segments are terminal (approved/excluded) — nothing to sync.");
    return;
  }

  const segMap = {};
  for (const s of segs) {
    segMap[s.segmentType] = s.status === "approved" && s.actualHours != null
      ? parseFloat(s.actualHours.toString())
      : 0;
  }

  const newAm  = segMap.driver_am;
  const newReg = segMap.regular;
  const newPm  = segMap.driver_pm;
  const newNet = parseFloat((newAm + newReg + newPm).toFixed(2));

  const oldAm  = tl.driverAmSegmentHours != null ? parseFloat(tl.driverAmSegmentHours) : null;
  const oldReg = tl.regularSegmentHours  != null ? parseFloat(tl.regularSegmentHours)  : null;
  const oldPm  = tl.driverPmSegmentHours != null ? parseFloat(tl.driverPmSegmentHours) : null;
  const oldNet = tl.netWorkedHours       != null ? parseFloat(tl.netWorkedHours)        : null;
  const oldOt  = tl.rawOtMinutes;

  console.log("Current TimeLog fields  →  What the fixed sync-back would write:");
  console.log(`  driverAmSegmentHours: ${oldAm}  → ${newAm}`);
  console.log(`  regularSegmentHours:  ${oldReg} → ${newReg}`);
  console.log(`  driverPmSegmentHours: ${oldPm}  → ${newPm}`);
  console.log(`  netWorkedHours:       ${oldNet} → ${newNet}`);
  console.log(`  rawOtMinutes:         ${oldOt}  → 0`);

  if (oldAm === newAm && oldReg === newReg && oldPm === newPm && oldNet === newNet && oldOt === 0) {
    console.log("\n✓ Already in sync — nothing to do.");
    return;
  }

  if (!DRY_RUN) {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify([{
      id: tl.id, _date: date,
      driverAmSegmentHours: tl.driverAmSegmentHours,
      regularSegmentHours:  tl.regularSegmentHours,
      driverPmSegmentHours: tl.driverPmSegmentHours,
      netWorkedHours:       tl.netWorkedHours,
      rawOtMinutes:         tl.rawOtMinutes,
    }], null, 2));

    await prisma.timeLog.update({
      where: { id: tl.id },
      data: {
        driverAmSegmentHours: newAm,
        regularSegmentHours:  newReg,
        driverPmSegmentHours: newPm,
        netWorkedHours:       newNet,
        rawOtMinutes:         0,
      },
    });
    console.log(`\n✅ Applied. Backup saved → ${BACKUP_FILE}`);
    console.log(`   To revert: node scripts/backfill-syncback-evelyn-jul8.js --revert`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
