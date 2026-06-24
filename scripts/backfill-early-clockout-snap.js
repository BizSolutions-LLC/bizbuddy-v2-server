// Backfill: apply early clock-out snap to all affected logs (BB-024)
// Company : cmnegwuxm0004rf7fzo6wjrw2
// Period  : 2026-05-13 → 2026-06-09
// Grace   : 45 minutes
//
// STEP 1 — Run the estimate script first to confirm count.
// STEP 2 — Run this script. A rollback SQL file is written before any changes.
// STEP 3 — Verify results. If anything is wrong, run the rollback SQL.
//
// Run: node scripts/backfill-early-clockout-snap.js

require("module-alias/register");
require("dotenv").config();

const fs   = require("fs");
const path = require("path");

const { prisma }                = require("@config/connection");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");

const COMPANY_ID  = "cmnegwuxm0004rf7fzo6wjrw2";
const DATE_FROM   = new Date("2026-05-13T00:00:00.000Z");
const DATE_TO     = new Date("2026-06-09T23:59:59.999Z");
const GRACE_MIN   = 45;

async function main() {
  // ── 1. Resolve PM shift end ──────────────────────────────────────────────────
  const pmShift = await prisma.shift.findFirst({
    where:  { companyId: COMPANY_ID, shiftName: "Driver/Aide PM Shift" },
    select: { endTime: true },
  });
  if (!pmShift) { console.error("Driver/Aide PM Shift not found."); process.exit(1); }

  const company = await prisma.company.findUnique({
    where:  { id: COMPANY_ID },
    select: { timeZone: true },
  });
  const tz = company?.timeZone ?? "UTC";

  const pmEndHHmm = pmShift.endTime instanceof Date
    ? `${String(pmShift.endTime.getUTCHours()).padStart(2, "0")}:${String(pmShift.endTime.getUTCMinutes()).padStart(2, "0")}`
    : String(pmShift.endTime).slice(0, 5);

  console.log(`Timezone     : ${tz}`);
  console.log(`PM shift end : ${pmEndHHmm}`);
  console.log(`Grace        : ${GRACE_MIN} min\n`);

  // ── 2. Fetch all candidate logs ──────────────────────────────────────────────
  const moment   = require("moment-timezone");
  const graceMs  = GRACE_MIN * 60 * 1000;

  const logs = await prisma.timeLog.findMany({
    where: {
      user:      { companyId: COMPANY_ID },
      punchType: { in: ["DRIVER_AIDE", "DRIVER_AIDE_PM"] },
      timeIn:    { gte: DATE_FROM, lte: DATE_TO },
      timeOut:   { not: null },
    },
    select: {
      id:                   true,
      timeIn:               true,
      timeOut:              true,
      grossHours:           true,
      driverPmSegmentHours: true,
      undertimeHours:       true,
      netWorkedHours:       true,
      punchType:            true,
    },
    orderBy: { timeIn: "asc" },
  });

  // ── 3. Filter to snappable only ──────────────────────────────────────────────
  const targets = logs.filter((log) => {
    const localDate = moment(log.timeIn).tz(tz).format("YYYY-MM-DD");
    const pmEndUtc  = moment.tz(`${localDate} ${pmEndHHmm}`, "YYYY-MM-DD HH:mm", tz).toDate();
    const earlyMs   = pmEndUtc.getTime() - log.timeOut.getTime();
    return earlyMs > 0 && earlyMs <= graceMs;
  });

  console.log(`Logs to backfill : ${targets.length}\n`);

  if (targets.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  // ── 4. Write rollback SQL BEFORE touching anything ───────────────────────────
  const rollbackPath = path.join(__dirname, "rollback-early-clockout-snap.sql");

  const sqlLines = [
    "-- Rollback: restore original timeOut + computed fields before BB-024 snap backfill",
    `-- Generated : ${new Date().toISOString()}`,
    `-- Company   : ${COMPANY_ID}`,
    "-- Run this if the backfill produced incorrect results.",
    "-- After restoring, re-run computeTimeLogSummary on these IDs if needed.",
    "",
    "BEGIN;",
    "",
  ];

  for (const log of targets) {
    const to      = log.timeOut.toISOString();
    const gross   = log.grossHours     ?? "NULL";
    const pmSeg   = log.driverPmSegmentHours ?? "NULL";
    const under   = log.undertimeHours ?? "NULL";
    const net     = log.netWorkedHours ?? "NULL";

    sqlLines.push(
      `UPDATE "TimeLog" SET` +
      ` "timeOut" = '${to}',` +
      ` "grossHours" = ${gross},` +
      ` "driverPmSegmentHours" = ${pmSeg},` +
      ` "undertimeHours" = ${under},` +
      ` "netWorkedHours" = ${net}` +
      ` WHERE id = '${log.id}';`
    );
  }

  sqlLines.push("", "COMMIT;", "");
  fs.writeFileSync(rollbackPath, sqlLines.join("\n"), "utf8");
  console.log(`Rollback SQL saved → ${rollbackPath}\n`);

  // ── 5. Run recompute on each target ─────────────────────────────────────────
  let ok = 0;
  let failed = 0;

  for (const log of targets) {
    const localDate = moment(log.timeIn).tz(tz).format("YYYY-MM-DD");
    const pmEndUtc  = moment.tz(`${localDate} ${pmEndHHmm}`, "YYYY-MM-DD HH:mm", tz).toDate();
    const earlyMin  = Math.round((pmEndUtc.getTime() - log.timeOut.getTime()) / 60000);

    try {
      await computeTimeLogSummary(log.id);
      console.log(`✓  ${log.id}  [${log.punchType}  ${localDate}  early=${earlyMin}min]`);
      ok++;
    } catch (err) {
      console.error(`✗  ${log.id}  ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone — ${ok} succeeded, ${failed} failed.`);
  if (failed > 0) console.warn("Some logs failed. Check errors above before proceeding.");
  console.log(`\nTo revert everything: psql <conn> -f ${rollbackPath}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
