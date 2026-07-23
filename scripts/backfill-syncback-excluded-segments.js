// scripts/backfill-syncback-excluded-segments.js
// BB-057 backfill — one-time correction for DRIVER_AIDE TimeLogs whose segments were
// already fully decided (approved and/or excluded) BEFORE the sync-back gate fix in
// daycareCutoffStrategy.js. Those TimeLogs never got their driverAmSegmentHours /
// regularSegmentHours / driverPmSegmentHours / netWorkedHours written back, because the
// old gate treated any "excluded" sibling as still-pending and refused to fire.
//
// Fixing the gate only helps FUTURE approvals — this script re-runs the (now-correct)
// sync-back logic against every already-decided TimeLog still stuck on stale,
// pre-review values, across ALL companies/cutoff periods (not scoped to one period).
//
// Unlike the earlier backfill-syncback-cutoff-jun10-23.js, this one:
//   - is not scoped to a single cutoff period
//   - INCLUDES sets with an excluded segment (the old script explicitly skipped those)
//   - writes 0 for an excluded segment's hours, not just approved segments' actualHours
//
// Usage:
//   node scripts/backfill-syncback-excluded-segments.js           → dry run
//   node scripts/backfill-syncback-excluded-segments.js --apply   → write to DB
//   node scripts/backfill-syncback-excluded-segments.js --revert  → restore from backup JSON

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const fs   = require("fs");
const path = require("path");

const prisma      = new PrismaClient();
const BACKUP_FILE = path.join(__dirname, "backup-syncback-excluded-segments.json");

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

  // All DRIVER_AIDE segment approvals, any company, any cutoff period.
  const approvals = await prisma.timeLogApproval.findMany({
    where: { segmentType: { not: null } },
    select: {
      timeLogId:      true,
      cutoffPeriodId: true,
      segmentType:    true,
      status:         true,
      actualHours:    true,
    },
  });

  // Group by (timeLogId, cutoffPeriodId) — matches the exact scope
  // syncApprovedSegmentsToTimeLog gates on.
  const byLog = {};
  for (const a of approvals) {
    const key = `${a.timeLogId}__${a.cutoffPeriodId}`;
    if (!byLog[key]) byLog[key] = [];
    byLog[key].push(a);
  }

  const timeLogIds = [...new Set(approvals.map((a) => a.timeLogId))];

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

  const backup    = [];
  let updated     = 0;
  let skipped     = 0;
  let alreadyOk   = 0;
  let hadExcluded = 0;

  for (const [key, segs] of Object.entries(byLog)) {
    const [logId] = key.split("__");
    const tl = logMap[logId];
    if (!tl) continue;

    const date = tl.timeIn?.toISOString().slice(0, 10) ?? "?";
    const name = `${tl.user?.profile?.firstName ?? ""} ${tl.user?.profile?.lastName ?? ""}`.trim();

    // Must have exactly 3 segment types, all terminal (approved or excluded) —
    // matches the fixed syncApprovedSegmentsToTimeLog gate exactly.
    const hasAllTerminal = segs.length >= 3 &&
      segs.every((s) => s.status === "approved" || s.status === "excluded") &&
      segs.some((s) => s.segmentType === "driver_am") &&
      segs.some((s) => s.segmentType === "regular") &&
      segs.some((s) => s.segmentType === "driver_pm");

    if (!hasAllTerminal) {
      const statuses = segs.map((s) => `${s.segmentType}:${s.status}`).join(", ");
      console.log(`⚠️  SKIP  ${name}  ${date}  — ${statuses}`);
      skipped++;
      continue;
    }

    const segMap = {};
    let excludedInSet = false;
    for (const s of segs) {
      if (s.status === "excluded") excludedInSet = true;
      segMap[s.segmentType] = s.status === "approved" && s.actualHours != null
        ? parseFloat(s.actualHours.toString())
        : 0;
    }
    if (excludedInSet) hadExcluded++;

    const newAm  = segMap.driver_am;
    const newReg = segMap.regular;
    const newPm  = segMap.driver_pm;
    const newNet = parseFloat((newAm + newReg + newPm).toFixed(2));

    const oldAm  = tl.driverAmSegmentHours != null ? parseFloat(tl.driverAmSegmentHours) : null;
    const oldReg = tl.regularSegmentHours  != null ? parseFloat(tl.regularSegmentHours)  : null;
    const oldPm  = tl.driverPmSegmentHours != null ? parseFloat(tl.driverPmSegmentHours) : null;
    const oldNet = tl.netWorkedHours       != null ? parseFloat(tl.netWorkedHours)        : null;
    const oldOt  = tl.rawOtMinutes;

    if (oldAm === newAm && oldReg === newReg && oldPm === newPm && oldNet === newNet && oldOt === 0) {
      console.log(`✓ OK    ${name}  ${date}  AM:${newAm} REG:${newReg} PM:${newPm} net:${newNet}`);
      alreadyOk++;
      continue;
    }

    console.log(`  UPDATE ${name}  ${date}  id:${logId}${excludedInSet ? "  (has excluded segment)" : ""}`);
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
  console.log(`  Already in sync      : ${alreadyOk}`);
  console.log(`  ${DRY_RUN ? "Would update" : "Updated"}         : ${updated}`);
  console.log(`    (of which, had an excluded segment: ${hadExcluded})`);
  console.log(`  Skipped (incomplete) : ${skipped}`);

  if (!DRY_RUN && backup.length > 0) {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
    console.log(`\n✅ Backup saved → ${BACKUP_FILE}  (${backup.length} record(s))`);
    console.log(`   To revert: node scripts/backfill-syncback-excluded-segments.js --revert`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
