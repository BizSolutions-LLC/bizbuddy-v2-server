// scripts/check-bb086-live-vs-backup-2026-04-29_2026-05-12.js
//
// BB-086 — Piedmont Adult Day Program, 2026-04-29..2026-05-12.
// READ-ONLY comparison of the live TimeLog table against the backup file
//   scripts/backup-bb086-april-live-timelogs-2026-04-29_2026-05-12.json
// SELECTs only. No writes, no backup file. Credentials are never printed.
//
// Punches are matched by userId + timeIn (exact ms) — live IDs differ after a
// re-upload, so the TimeLog id is not used as the key.
//
// Prints:
//   1. Which DB this script is connected to (host + database name only).
//   2. Per employee (all backed-up employees): backup / live / matched /
//      differing / backup-only / live-only counts. Re-uploaded names are flagged.
//   3. Field-level differences for matched punches.
//   4. Totals for the re-uploaded group vs everyone else.
//   5. Backed-up userIds that no longer exist in User, and live company users
//      that are not in the backup's employee list.
//
// Usage: node scripts/check-bb086-live-vs-backup-2026-04-29_2026-05-12.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BACKUP_FILE = path.join(
  __dirname,
  "backup-bb086-april-live-timelogs-2026-04-29_2026-05-12.json"
);

// Employees the user already re-uploaded from the CSV (matched on backup `name`).
const UPLOADED_NAMES = [
  "Eduardo Aviso",
  "Arnold Capati",
  "Shirley Capati",
  "Josefina Chavez",
  "Evelyn Garnace",
  "Imelda Levi",
].map((n) => n.toLowerCase());

const COMPARE_FIELDS = [
  "timeOut",
  "lunchBreak",
  "coffeeBreaks",
  "punchType",
  "status",
  "netWorkedHours",
];

const norm = (field, value) => {
  if (value === null || value === undefined) return "null";
  if (field === "timeOut") return new Date(value).toISOString();
  if (field === "netWorkedHours") return Number(value).toFixed(4);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const key = (userId, timeIn) => `${userId}|${new Date(timeIn).toISOString()}`;

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
  console.log("=== BB-086 live vs backup check, 2026-04-29..2026-05-12 (read-only) ===");
  console.log(`DB target: ${describeDbTarget()}`);

  const backup = require(BACKUP_FILE);
  const { startUtc, endUtc } = backup.range;
  console.log(`Backup: ${backup.company.name} | ${backup.timeLogs.length} timelogs | ${backup.employees.length} employees`);
  console.log(`Range (UTC): ${startUtc} .. ${endUtc}`);

  const employeeIds = backup.employees.map((e) => e.id);
  const nameById = new Map(backup.employees.map((e) => [e.id, e.name]));

  const live = await prisma.timeLog.findMany({
    where: {
      userId: { in: employeeIds },
      timeIn: { gte: new Date(startUtc), lte: new Date(endUtc) },
    },
  });

  const backupByKey = new Map(backup.timeLogs.map((t) => [key(t.userId, t.timeIn), t]));
  const liveByKey = new Map(live.map((t) => [key(t.userId, t.timeIn), t]));

  const perUser = new Map(
    employeeIds.map((id) => [
      id,
      { backup: 0, live: 0, matched: 0, differing: 0, backupOnly: 0, liveOnly: 0 },
    ])
  );
  const diffs = [];

  for (const [k, b] of backupByKey) {
    const row = perUser.get(b.userId);
    row.backup++;
    const l = liveByKey.get(k);
    if (!l) {
      row.backupOnly++;
      continue;
    }
    row.matched++;
    const changed = COMPARE_FIELDS.filter((f) => norm(f, b[f]) !== norm(f, l[f]));
    if (changed.length) {
      row.differing++;
      diffs.push({
        name: nameById.get(b.userId),
        timeIn: new Date(b.timeIn).toISOString(),
        changed: changed.map((f) => `${f}: backup=${norm(f, b[f])} live=${norm(f, l[f])}`),
      });
    }
  }
  for (const [k, l] of liveByKey) {
    const row = perUser.get(l.userId);
    row.live++;
    if (!backupByKey.has(k)) row.liveOnly++;
  }

  const isUploaded = (id) => UPLOADED_NAMES.includes(String(nameById.get(id)).toLowerCase());

  console.log("\n--- Per employee ---");
  console.log("backup live match diff bkpOnly liveOnly  name");
  const sorted = [...perUser.entries()].sort((a, b) =>
    String(nameById.get(a[0])).localeCompare(String(nameById.get(b[0])))
  );
  for (const [id, r] of sorted) {
    const cols = [r.backup, r.live, r.matched, r.differing, r.backupOnly, r.liveOnly]
      .map((v, i) => String(v).padStart(i === 4 ? 7 : i === 5 ? 8 : 5))
      .join(" ");
    console.log(`${cols}  ${nameById.get(id)}${isUploaded(id) ? "  [UPLOADED]" : ""}`);
  }

  console.log("\n--- Field differences on matched punches ---");
  if (diffs.length === 0) console.log("  (none)");
  for (const d of diffs) {
    console.log(`  ${d.name} @ ${d.timeIn}`);
    for (const c of d.changed) console.log(`      ${c}`);
  }

  const total = (pred) =>
    [...perUser.entries()]
      .filter(([id]) => pred(id))
      .reduce(
        (acc, [, r]) => {
          for (const k of Object.keys(acc)) acc[k] += r[k];
          return acc;
        },
        { backup: 0, live: 0, matched: 0, differing: 0, backupOnly: 0, liveOnly: 0 }
      );
  const uploadedCount = employeeIds.filter(isUploaded).length;
  console.log(`\n--- Totals: re-uploaded group (${uploadedCount} employees) ---`);
  console.log(" ", total(isUploaded));
  console.log(`--- Totals: everyone else (${employeeIds.length - uploadedCount} employees) ---`);
  console.log(" ", total((id) => !isUploaded(id)));

  // Users
  const existing = await prisma.user.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((u) => u.id));
  const missingUsers = employeeIds.filter((id) => !existingIds.has(id));
  console.log("\n--- Backed-up userIds missing from User table ---");
  if (missingUsers.length === 0) console.log("  (none)");
  for (const id of missingUsers) console.log(`  ${id}  ${nameById.get(id)}`);

  const companyUsers = await prisma.user.findMany({
    where: { companyId: backup.company.id },
    select: { id: true, employeeId: true },
  });
  const notInBackup = companyUsers.filter((u) => !nameById.has(u.id));
  const notInBackupWithLive = await prisma.timeLog.groupBy({
    by: ["userId"],
    where: {
      userId: { in: notInBackup.map((u) => u.id) },
      timeIn: { gte: new Date(startUtc), lte: new Date(endUtc) },
    },
    _count: { _all: true },
  });
  console.log("\n--- Live company users NOT in backup, with punches in this range ---");
  if (notInBackupWithLive.length === 0) console.log("  (none)");
  for (const r of notInBackupWithLive) console.log(`  ${r.userId}: ${r._count._all} punches`);

  console.log("\nNo database changes were made.");
}

main()
  .catch((err) => {
    console.error("Script failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
