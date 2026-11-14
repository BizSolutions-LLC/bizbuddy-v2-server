// scripts/fix-bb124-josie-nov9-delete-punch.js
//
// BB-124 follow-up — Josie Soriano (Piedmont Adult Day Program), Nov 9 2026.
// The BB-124 fix excluded her Nov 9 Driver/Aide punch (all 3 segments, 0h) and
// kept her 8h paid Sick Leave. Decision (user, 2026-11-14): DELETE that punch, so
// the day is a plain leave day everywhere — no 0h punch left in her data, Cutoff
// Review shows her Sick Leave row, the Payroll Grid needs no special rule.
//
// A TimeLog delete is a HARD delete (no audit trail), so this script backs up the
// punch and everything attached to it first, and --restore puts it all back.
//
// What --apply deletes (one transaction):
//   - TimeLog cmw9dpepz0p6gr9537tl71epq
//   - with it (cascade): its 3 TimeLogApprovals, any ContestTimeLog, Overtime,
//     LiveUser rows
//   - RequestedTimeLog.createdTimeLogId pointing at it is cleared first
// Not touched: the Leave, its ledger, her balance, the cutoff row.
//
// Safety checks before --apply:
//   - exactly 1 TimeLog for Josie on Nov 9 (company zone), the expected id
//   - all its approvals "excluded" with the BB-124 note (nothing paid from it)
//   - no approved Overtime on it
//   - her approved 8h Sick Leave for Nov 9 is still there
//   - the backup file doesn't exist yet
//
// Backup: scripts/backup-bb124-josie-nov9-delete-punch.json (every deleted row).
//
// Usage:
//   node scripts/fix-bb124-josie-nov9-delete-punch.js             # dry run
//   node scripts/fix-bb124-josie-nov9-delete-punch.js --apply
//   node scripts/fix-bb124-josie-nov9-delete-punch.js --restore   # recreate from the backup

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const EMPLOYEE_EMAIL = "josiesoriano1225@gmail.com";
const LOCAL_DATE = "2026-11-09";
const EXPECTED_TIMELOG_ID = "cmw9dpepz0p6gr9537tl71epq";
const BACKUP_FILE = path.join(__dirname, "backup-bb124-josie-nov9-delete-punch.json");
const TX_OPTIONS = { maxWait: 15000, timeout: 120000 };

const APPLY = process.argv.includes("--apply");
const RESTORE = process.argv.includes("--restore");

// Prisma rejects a plain null for optional Json fields on create — leave empty
// fields out instead (they come back as null / their default).
const noNulls = (row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));

const fmt = (d, tz) => (d ? moment.tz(d, tz).format("YYYY-MM-DD hh:mm A z") : "—");

async function loadState() {
  const company = await prisma.company.findUnique({ where: { id: COMPANY_ID }, select: { name: true, timeZone: true } });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found`);
  const tz = company.timeZone || "America/Los_Angeles";

  const users = await prisma.user.findMany({
    where:  { companyId: COMPANY_ID, email: { equals: EMPLOYEE_EMAIL, mode: "insensitive" } },
    select: { id: true, email: true },
  });
  if (users.length !== 1) throw new Error(`Expected 1 user with ${EMPLOYEE_EMAIL} in PadPro, found ${users.length}`);
  const user = users[0];

  const timeLogs = await prisma.timeLog.findMany({
    where: {
      userId: user.id,
      timeIn: { gte: moment.tz(LOCAL_DATE, tz).startOf("day").toDate(), lte: moment.tz(LOCAL_DATE, tz).endOf("day").toDate() },
    },
  });
  const ids = timeLogs.map((t) => t.id);
  const [approvals, contests, overtime, liveUsers, requests] = ids.length
    ? await Promise.all([
        prisma.timeLogApproval.findMany({ where: { timeLogId: { in: ids } } }),
        prisma.contestTimeLog.findMany({ where: { timeLogId: { in: ids } } }),
        prisma.overtime.findMany({ where: { timeLogId: { in: ids } } }),
        prisma.liveUser.findMany({ where: { timeLogId: { in: ids } } }),
        prisma.requestedTimeLog.findMany({ where: { createdTimeLogId: { in: ids } }, select: { id: true, createdTimeLogId: true } }),
      ])
    : [[], [], [], [], []];

  const leaves = (await prisma.leave.findMany({
    where: { userId: user.id, status: "approved" },
    select: { id: true, status: true, isPaid: true, actualPaidHours: true, startDate: true, endDate: true },
  })).filter((l) => l.startDate.toISOString().slice(0, 10) <= LOCAL_DATE && l.endDate.toISOString().slice(0, 10) >= LOCAL_DATE);

  return { company, tz, user, timeLogs, approvals, contests, overtime, liveUsers, requests, leaves };
}

function printState(s) {
  console.log(`Company: ${s.company.name}`);
  console.log(`User:    ${s.user.email} (${s.user.id})\n`);
  console.log(`TimeLogs on ${LOCAL_DATE}: ${s.timeLogs.length}`);
  for (const t of s.timeLogs) {
    console.log(`  ${t.id} ${t.punchType} ${fmt(t.timeIn, s.tz)} → ${fmt(t.timeOut, s.tz)}  net=${t.netWorkedHours}`);
  }
  console.log(`Approvals: ${s.approvals.length}`);
  for (const a of s.approvals) console.log(`  ${a.id} ${a.segmentType} ${a.status} actual=${a.actualHours} "${a.notes ?? ""}"`);
  console.log(`Contests: ${s.contests.length}  Overtime: ${s.overtime.length}  LiveUser: ${s.liveUsers.length}  RequestedTimeLog links: ${s.requests.length}`);
  console.log(`Approved leaves on ${LOCAL_DATE}: ${s.leaves.map((l) => `${l.id} paid=${l.actualPaidHours}`).join(", ") || "none"}\n`);
}

function checkSafety(s) {
  const problems = [];
  if (s.timeLogs.length !== 1) problems.push(`expected 1 TimeLog on ${LOCAL_DATE}, found ${s.timeLogs.length}`);
  else if (s.timeLogs[0].id !== EXPECTED_TIMELOG_ID) problems.push(`TimeLog is ${s.timeLogs[0].id}, expected ${EXPECTED_TIMELOG_ID}`);
  if (s.approvals.length !== 3) problems.push(`expected 3 approvals, found ${s.approvals.length}`);
  if (s.approvals.some((a) => a.status !== "excluded")) problems.push("an approval is not excluded — something is paid from this punch");
  if (s.approvals.some((a) => !/BB-124/.test(a.notes || ""))) problems.push("an approval lacks the BB-124 note — state changed since the BB-124 fix?");
  if (s.overtime.some((o) => o.status === "approved")) problems.push("approved overtime is attached to this punch");
  if (s.leaves.length !== 1) problems.push(`expected her approved Sick Leave on ${LOCAL_DATE}, found ${s.leaves.length}`);
  if (fs.existsSync(BACKUP_FILE)) problems.push(`backup already exists at ${BACKUP_FILE} — already applied?`);
  return problems;
}

async function apply(s) {
  const t = s.timeLogs[0];
  // Backup BEFORE the delete — the delete is the one thing that can't be redone otherwise.
  const backup = {
    ticket: "BB-124", deletedAt: new Date().toISOString(),
    timeLog: t, approvals: s.approvals, contests: s.contests, overtime: s.overtime,
    liveUsers: s.liveUsers, requests: s.requests,
  };
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${BACKUP_FILE}`);

  try {
    await prisma.$transaction(async (tx) => {
      if (s.requests.length) {
        await tx.requestedTimeLog.updateMany({ where: { createdTimeLogId: t.id }, data: { createdTimeLogId: null } });
      }
      await tx.timeLog.delete({ where: { id: t.id } }); // cascades approvals, contests, overtime, liveUser
    }, TX_OPTIONS);
  } catch (e) {
    // Nothing was deleted — move the backup aside so a re-run isn't blocked.
    fs.renameSync(BACKUP_FILE, BACKUP_FILE.replace(/\.json$/, `.failed-${Date.now()}.json`));
    throw e;
  }
  console.log(`✅ Deleted TimeLog ${t.id} (+ ${s.approvals.length} approvals, ${s.contests.length} contests, ${s.overtime.length} overtime, ${s.liveUsers.length} live). Leave untouched.`);
}

async function restore() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup at ${BACKUP_FILE} — nothing to restore.`);
    return;
  }
  const b = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  await prisma.$transaction(async (tx) => {
    await tx.timeLog.create({ data: noNulls(b.timeLog) });
    if (b.approvals.length) await tx.timeLogApproval.createMany({ data: b.approvals.map(noNulls) });
    if (b.contests.length)  await tx.contestTimeLog.createMany({ data: b.contests.map(noNulls) });
    if (b.overtime.length)  await tx.overtime.createMany({ data: b.overtime.map(noNulls) });
    if (b.liveUsers.length) await tx.liveUser.createMany({ data: b.liveUsers.map(noNulls) });
    for (const r of b.requests) {
      await tx.requestedTimeLog.update({ where: { id: r.id }, data: { createdTimeLogId: r.createdTimeLogId } });
    }
  }, TX_OPTIONS);
  fs.renameSync(BACKUP_FILE, BACKUP_FILE.replace(/\.json$/, `.restored-${Date.now()}.json`));
  console.log(`↩️  Restored TimeLog ${b.timeLog.id} and its ${b.approvals.length} approvals.`);
}

async function main() {
  if (RESTORE) return restore();
  const state = await loadState();
  printState(state);
  const problems = checkSafety(state);
  if (problems.length) {
    console.log("⛔ Safety checks failed — nothing deleted:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log("Plan:");
  console.log(`  DELETE TimeLog ${state.timeLogs[0].id} and its ${state.approvals.length} excluded approvals`);
  console.log("  Sick Leave (8h paid) unchanged → Nov 9 becomes a plain leave day\n");
  if (!APPLY) {
    console.log("Dry run — re-run with --apply to delete (a backup is written first).");
    return;
  }
  await apply(state);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
