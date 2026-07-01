// scripts/backup-revert-daynee-jun10.js
// Backup and revert helper for Daynee Cuaresma's June 10 timelog sync-back test.
//
// Usage:
//   node scripts/backup-revert-daynee-jun10.js           → print current DB values
//   node scripts/backup-revert-daynee-jun10.js --save    → save snapshot to backup-daynee-jun10.json
//   node scripts/backup-revert-daynee-jun10.js --revert  → restore from backup-daynee-jun10.json

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const fs   = require("fs");
const path = require("path");

const prisma     = new PrismaClient();
const BACKUP_FILE = path.join(__dirname, "backup-daynee-jun10.json");
const LOG_ID      = "cmq84glv501g5on4w6oaaekhn"; // Daynee Jun 10

const FIELDS = [
  "driverAmSegmentHours",
  "regularSegmentHours",
  "driverPmSegmentHours",
  "netWorkedHours",
  "rawOtMinutes",
];

async function printCurrent() {
  const tl = await prisma.timeLog.findUnique({
    where:  { id: LOG_ID },
    select: FIELDS.reduce((acc, f) => ({ ...acc, [f]: true }), { id: true, timeIn: true }),
  });
  if (!tl) { console.log("❌ TimeLog not found."); return; }
  console.log(`TimeLog ${tl.id}  (${tl.timeIn?.toISOString().slice(0, 10)})\n`);
  for (const f of FIELDS) console.log(`  ${f}: ${tl[f]}`);
  return tl;
}

async function save() {
  const tl = await printCurrent();
  if (!tl) return;
  const snapshot = FIELDS.reduce((acc, f) => ({ ...acc, [f]: tl[f] }), { id: tl.id });
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ Snapshot saved → ${BACKUP_FILE}`);
}

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`❌ Backup file not found: ${BACKUP_FILE}`);
    console.log("   Run with --save first to capture current values.");
    return;
  }
  const snapshot = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  console.log("Restoring from snapshot:\n");
  for (const f of FIELDS) console.log(`  ${f}: ${snapshot[f]}`);

  await prisma.timeLog.update({
    where: { id: LOG_ID },
    data: FIELDS.reduce((acc, f) => {
      if (snapshot[f] !== undefined) acc[f] = snapshot[f];
      return acc;
    }, {}),
  });
  console.log("\n✅ Reverted.");
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--save")   await save();
  else if (arg === "--revert") await revert();
  else                    await printCurrent();
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
