// scripts/backfill-syncback-cutoff-jun10-23.js
// Backfill sync-back for all DRIVER_AIDE timelogs in the Jun 10-23 cutoff period
// where all 3 segments are approved but TimeLog fields are stale (approved before v2.10.19).
//
// Cutoff: cmp7p84rw05u0u44vj4b4obfg (Piedmont Adult Day Program, Jun 10–23 2026)
//
// Skips any timelog where a segment is excluded or pending (only fully-approved sets).
// Also zeroes rawOtMinutes — post-window time is absorbed into PM segment's actualHours
// for raw-mode approvals and should not render as an OT row in the UI.
//
// Usage:
//   node scripts/backfill-syncback-cutoff-jun10-23.js           → dry run
//   node scripts/backfill-syncback-cutoff-jun10-23.js --apply   → write to DB
//   node scripts/backfill-syncback-cutoff-jun10-23.js --revert  → restore from backup JSON

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const fs   = require("fs");
const path = require("path");

const prisma       = new PrismaClient();
const CUTOFF_ID    = "cmp7p84rw05u0u44vj4b4obfg";
const BACKUP_FILE  = path.join(__dirname, "backup-syncback-cutoff-jun10-23.json");

const DRY_RUN = !process.argv.includes("--apply") && !process.argv.includes("--revert");
const REVERT  = process.argv.includes("--revert");

// ── Revert ────────────────────────────────────────────────────────────────────

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`❌ Backup file not found: ${BACKUP_FILE}`);
    console.log("   Run without --apply first to generate the backup.");
    return;
  }
  const records = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  console.log(`Reverting ${records.length} record(s) from ${BACKUP_FILE}...\n`);

  let count = 0;
  for (const r of records) {
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
    count++;
    console.log(`  ✅ reverted ${r.id} (${r._date})`);
  }
  console.log(`\nReverted ${count} record(s).`);
}

// ── Main backfill ─────────────────────────────────────────────────────────────

async function main() {
  if (REVERT) { await revert(); return; }

  console.log(DRY_RUN
    ? "🔍 DRY RUN — pass --apply to write changes\n"
    : "✏️  APPLYING changes\n"
  );

  // Fetch all approved DRIVER_AIDE segments for this cutoff
  const approvals = await prisma.timeLogApproval.findMany({
    where: {
      cutoffPeriodId: CUTOFF_ID,
      segmentType:    { not: null },
    },
    select: {
      timeLogId:   true,
      segmentType: true,
      status:      true,
      actualHours: true,
    },
  });

  // Group by timeLogId
  const byLog = {};
  for (const a of approvals) {
    if (!byLog[a.timeLogId]) byLog[a.timeLogId] = [];
    byLog[a.timeLogId].push(a);
  }

  const timeLogIds = Object.keys(byLog);

  // Fetch current TimeLog field values
  const timeLogs = await prisma.timeLog.findMany({
    where: { id: { in: timeLogIds } },
    select: {
      id:                   true,
      timeIn:               true,
      driverAmSegmentHours: true,
      regularSegmentHours:  true,
      driverPmSegmentHours: true,
      netWorkedHours:       true,
      rawOtMinutes:         true,
      user: { select: { profile: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { timeIn: "asc" },
  });
  const logMap = Object.fromEntries(timeLogs.map((t) => [t.id, t]));

  const backup  = [];
  let updated   = 0;
  let skipped   = 0;
  let alreadyOk = 0;

  for (const [logId, segs] of Object.entries(byLog)) {
    const tl = logMap[logId];
    if (!tl) continue;

    const date = tl.timeIn?.toISOString().slice(0, 10) ?? "?";
    const name = `${tl.user?.profile?.firstName ?? ""} ${tl.user?.profile?.lastName ?? ""}`.trim();

    // Must have exactly 3 segment types, all approved
    const hasAll = segs.length >= 3 &&
      segs.every((s) => s.status === "approved") &&
      segs.some((s) => s.segmentType === "driver_am") &&
      segs.some((s) => s.segmentType === "regular") &&
      segs.some((s) => s.segmentType === "driver_pm");

    if (!hasAll) {
      const statuses = segs.map((s) => `${s.segmentType}:${s.status}`).join(", ");
      console.log(`⚠️  SKIP  ${name}  ${date}  — ${statuses}`);
      skipped++;
      continue;
    }

    const segMap = {};
    for (const s of segs) {
      if (s.actualHours != null) segMap[s.segmentType] = parseFloat(s.actualHours.toString());
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

    // Skip if already in sync and rawOtMinutes already 0
    if (oldAm === newAm && oldReg === newReg && oldPm === newPm && oldNet === newNet && oldOt === 0) {
      console.log(`✓ OK    ${name}  ${date}  AM:${newAm} REG:${newReg} PM:${newPm} net:${newNet}`);
      alreadyOk++;
      continue;
    }

    console.log(`  UPDATE ${name}  ${date}  id:${logId}`);
    if (oldAm  !== newAm)  console.log(`    AM:           ${oldAm}  → ${newAm}`);
    if (oldReg !== newReg) console.log(`    REG:          ${oldReg} → ${newReg}`);
    if (oldPm  !== newPm)  console.log(`    PM:           ${oldPm}  → ${newPm}`);
    if (oldNet !== newNet) console.log(`    net:          ${oldNet} → ${newNet}`);
    if (oldOt  !== 0)      console.log(`    rawOtMinutes: ${oldOt}  → 0`);

    backup.push({
      id:                   logId,
      _date:                date,
      _name:                name,
      driverAmSegmentHours: tl.driverAmSegmentHours,
      regularSegmentHours:  tl.regularSegmentHours,
      driverPmSegmentHours: tl.driverPmSegmentHours,
      netWorkedHours:       tl.netWorkedHours,
      rawOtMinutes:         tl.rawOtMinutes,
    });

    if (!DRY_RUN) {
      await prisma.timeLog.update({
        where: { id: logId },
        data: {
          driverAmSegmentHours: newAm,
          regularSegmentHours:  newReg,
          driverPmSegmentHours: newPm,
          netWorkedHours:       newNet,
          rawOtMinutes:         0,
        },
      });
      console.log(`    ✅ done`);
    }
    updated++;
  }

  console.log(`\n── Summary ────────────────────────────────`);
  console.log(`  Already in sync : ${alreadyOk}`);
  console.log(`  ${DRY_RUN ? "Would update" : "Updated"}    : ${updated}`);
  console.log(`  Skipped (partial): ${skipped}`);

  if (!DRY_RUN && backup.length > 0) {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
    console.log(`\n✅ Backup saved → ${BACKUP_FILE}  (${backup.length} record(s))`);
    console.log(`   To revert: node scripts/backfill-syncback-cutoff-jun10-23.js --revert`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
