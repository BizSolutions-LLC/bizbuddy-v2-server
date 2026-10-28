// scripts/check-bb086-april-timelog-origin.js
//
// BB-086 follow-up — no PadPro RequestedTimeLog rows exist for 2026-04-01..14,
// yet ~40 TimeLogs/day do. This READ-ONLY diagnostic works out where those
// April TimeLogs came from. SELECTs only. No writes, no files.
//
// Prints (for TimeLogs with timeIn in 2026-04-01..2026-04-14, UTC ±1 day pad):
//   1. Total, and how many have a RequestedTimeLog pointing at them
//      (createdTimeLogId) — broken down by that request's description.
//   2. Orphans: TimeLogs with NO request row (live clock-in, or request deleted).
//   3. createdAt batches (by hour) — a burst of hundreds in one hour = an import.
//   4. Per punchType and per createdAt-vs-timeIn lag (created long after the punch
//      = backfill/import; created within a day = live clock-in).
//   5. Per-employee totals >= 100h and employee-days with repeated punchType / >2 logs.
//   6. The 3 PadPro requests with no createdTimeLogId (id, user, requestedDate).
//
// Usage: node scripts/check-bb086-april-timelog-origin.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RANGE_START = new Date("2026-04-01T00:00:00.000Z");
const RANGE_END = new Date("2026-04-14T23:59:59.999Z");
const PAD_MS = 86400000;
const HEAVY_HOURS = 100;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

const tally = (items, keyFn) => {
  const out = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
};

const printTally = (title, obj, sortByCount = false) => {
  console.log(`\n--- ${title} ---`);
  const entries = Object.entries(obj).sort((a, b) =>
    sortByCount ? b[1] - a[1] : String(a[0]).localeCompare(String(b[0]))
  );
  if (entries.length === 0) console.log("  (none)");
  for (const [k, v] of entries) console.log(`  ${k}: ${v}`);
};

const lagBucket = (t) => {
  const h = (new Date(t.createdAt) - new Date(t.timeIn)) / 3600000;
  if (h < 0) return "created BEFORE timeIn";
  if (h <= 24) return "within 24h of punch (live-like)";
  if (h <= 24 * 7) return "1–7 days after punch";
  return "> 7 days after punch (backfill/import-like)";
};

async function main() {
  console.log("=== BB-086 April TimeLog origin check (read-only) ===");

  const timeLogs = await prisma.timeLog.findMany({
    where: {
      timeIn: {
        gte: new Date(RANGE_START.getTime() - PAD_MS),
        lte: new Date(RANGE_END.getTime() + PAD_MS),
      },
    },
    select: {
      id: true,
      userId: true,
      timeIn: true,
      timeOut: true,
      punchType: true,
      createdAt: true,
      netWorkedHours: true,
      createdFromRequest: { select: { id: true, description: true, status: true } },
    },
  });
  console.log(`TimeLogs (timeIn 2026-03-31..2026-04-15 UTC): ${timeLogs.length}`);

  // 1 + 2. Request linkage
  const linked = timeLogs.filter((t) => t.createdFromRequest.length > 0);
  const orphans = timeLogs.filter((t) => t.createdFromRequest.length === 0);
  console.log(`With a linked RequestedTimeLog: ${linked.length}`);
  console.log(`With NO linked request (orphan / live): ${orphans.length}`);
  printTally(
    "Linked TimeLogs by request description",
    tally(linked, (t) => (t.createdFromRequest[0].description || "(empty)").slice(0, 60)),
    true
  );

  // 3. createdAt batches
  printTally(
    "TimeLog.createdAt by hour (top 15 — a big spike = bulk import)",
    Object.fromEntries(
      Object.entries(tally(timeLogs, (t) => new Date(t.createdAt).toISOString().slice(0, 13) + ":00Z"))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
    ),
    true
  );

  // 4. punchType + lag
  printTally("By punchType", tally(timeLogs, (t) => t.punchType));
  printTally("By createdAt-vs-timeIn lag", tally(timeLogs, lagBucket), true);
  printTally("Orphans by createdAt-vs-timeIn lag", tally(orphans, lagBucket), true);

  // 5. Heavy employees + duplicate days (in-range only, UTC day)
  const inRange = timeLogs.filter((t) => t.timeIn >= RANGE_START && t.timeIn <= RANGE_END);
  const hours = {};
  for (const t of inRange) {
    const h = t.timeOut ? (new Date(t.timeOut) - new Date(t.timeIn)) / 3600000 : 0;
    hours[t.userId] = (hours[t.userId] || 0) + h;
  }
  const heavy = Object.entries(hours).filter(([, h]) => h >= HEAVY_HOURS).sort((a, b) => b[1] - a[1]);
  console.log(`\n--- Employees with >= ${HEAVY_HOURS} gross hours in range: ${heavy.length} ---`);
  for (const [uid, h] of heavy.slice(0, 25)) console.log(`  ${uid}: ${h.toFixed(2)} h`);

  const byEmpDay = {};
  for (const t of inRange) (byEmpDay[`${t.userId}_${dayKey(t.timeIn)}`] ||= []).push(t);
  const dupDays = Object.entries(byEmpDay).filter(([, logs]) => {
    const tc = tally(logs, (t) => t.punchType);
    return logs.length > 2 || Object.values(tc).some((c) => c > 1);
  });
  console.log(`\n--- Employee-days with >2 logs or a repeated punchType: ${dupDays.length} ---`);
  for (const [key, logs] of dupDays.slice(0, 25)) {
    console.log(`  ${key}: ${logs.length} logs ${JSON.stringify(tally(logs, (t) => t.punchType))}`);
  }
  const dupOrphanShare = dupDays.reduce((n, [, l]) => n + l.filter((t) => t.createdFromRequest.length === 0).length, 0);
  const dupTotal = dupDays.reduce((n, [, l]) => n + l.length, 0);
  console.log(`  of those logs, orphans (no request): ${dupOrphanShare}/${dupTotal}`);

  // 6. Unlinked PadPro requests
  const unlinked = await prisma.requestedTimeLog.findMany({
    where: { description: "Backtrack import from PadPro", createdTimeLogId: null },
    select: { id: true, userId: true, requestedDate: true, status: true, createdAt: true },
    orderBy: { requestedDate: "asc" },
  });
  console.log(`\n--- PadPro requests with NO createdTimeLogId: ${unlinked.length} ---`);
  for (const r of unlinked) {
    console.log(`  ${r.id} | user=${r.userId} | date=${dayKey(r.requestedDate)} | ${r.status} | created ${iso(r.createdAt)}`);
  }

  console.log("\nNo database changes were made.");
}

main()
  .catch((err) => {
    console.error("Script failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
