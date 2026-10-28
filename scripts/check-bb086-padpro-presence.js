// scripts/check-bb086-padpro-presence.js
//
// BB-086 follow-up — the backup script found 0 PadPro RequestedTimeLog rows for
// 2026-04-01..2026-04-14. This READ-ONLY diagnostic tells us why.
// SELECTs only. No writes, no backup file. Credentials are never printed.
//
// Prints:
//   1. Which DB this script is connected to (host + database name only).
//   2. RequestedTimeLog counts by description (top 15) — is the PadPro label used at all?
//   3. Rows whose description mentions "PadPro"/"Backtrack", grouped by requestedDate month.
//   4. APPROVED requests with a createdTimeLogId in 2026-03-01..2026-05-31, by description.
//   5. TimeLog count per day for 2026-04-01..2026-04-14 (were punches ever there?).
//
// Usage: node scripts/check-bb086-padpro-presence.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

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

function describeDbTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) return "DATABASE_URL not set in this process";
  try {
    const u = new URL(url);
    return `host=${u.hostname} port=${u.port || "(default)"} database=${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "DATABASE_URL present but could not be parsed";
  }
}

async function main() {
  console.log("=== BB-086 PadPro presence check (read-only) ===");
  console.log(`DB target: ${describeDbTarget()}`);

  // 2. Descriptions overall
  const byDescription = await prisma.requestedTimeLog.groupBy({
    by: ["description"],
    _count: { _all: true },
  });
  const descTop = byDescription
    .sort((a, b) => b._count._all - a._count._all)
    .slice(0, 15)
    .reduce((acc, r) => ({ ...acc, [r.description ?? "(null)"]: r._count._all }), {});
  printTally("RequestedTimeLog by description (top 15)", descTop, true);

  // 3. PadPro / Backtrack-like rows by month
  const padproLike = await prisma.requestedTimeLog.findMany({
    where: {
      OR: [
        { description: { contains: "padpro", mode: "insensitive" } },
        { description: { contains: "backtrack", mode: "insensitive" } },
      ],
    },
    select: { description: true, requestedDate: true, createdTimeLogId: true, status: true },
  });
  console.log(`\nRows mentioning PadPro/Backtrack: ${padproLike.length}`);
  printTally(
    "PadPro/Backtrack-like rows by requestedDate month",
    tally(padproLike, (r) => new Date(r.requestedDate).toISOString().slice(0, 7))
  );
  printTally("PadPro/Backtrack-like rows by description", tally(padproLike, (r) => r.description));
  console.log(`  with createdTimeLogId: ${padproLike.filter((r) => r.createdTimeLogId).length}`);

  // 4. Approved + linked requests around April
  const aprilish = await prisma.requestedTimeLog.findMany({
    where: {
      status: "APPROVED",
      createdTimeLogId: { not: null },
      requestedDate: { gte: new Date("2026-03-01"), lte: new Date("2026-05-31T23:59:59.999Z") },
    },
    select: { description: true },
  });
  printTally(
    "APPROVED + linked requests, requestedDate 2026-03-01..2026-05-31, by description",
    tally(aprilish, (r) => r.description ?? "(null)"),
    true
  );

  // 5. TimeLogs per day, Apr 1–14
  const logs = await prisma.timeLog.findMany({
    where: {
      timeIn: { gte: new Date("2026-03-31T00:00:00.000Z"), lte: new Date("2026-04-15T23:59:59.999Z") },
    },
    select: { timeIn: true },
  });
  printTally("TimeLogs per day (UTC), 2026-03-31..2026-04-15", tally(logs, (t) => new Date(t.timeIn).toISOString().slice(0, 10)));

  console.log("\nNo database changes were made.");
}

main()
  .catch((err) => {
    console.error("Script failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
