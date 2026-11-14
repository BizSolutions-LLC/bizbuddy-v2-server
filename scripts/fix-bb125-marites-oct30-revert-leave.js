// scripts/fix-bb125-marites-oct30-revert-leave.js
//
// BB-125 — Marites Fernandez (Piedmont Adult Day Program), Oct 30 2026.
// She worked her full shift on 10-30 (8:04 → 1:30, approved 5.5h). PadPro's
// "Automatically Resolve Punch-vs-Leave Conflicts" honored the punch on
// 2026-11-11, but the old leave lookup (timestamp vs. noon-stored leave dates)
// found nothing, so her 5.5h Sick Leave was never reverted. PadPro confirmed she
// worked. Confirmed in data by scripts/check-bb125-marites-oct30.js.
//
// This finishes what the automatic resolve should have done, with the same
// BB-125 code it now calls: revertLeaveDayOnConflict
// (src/services/Cutoff/leaveConflictCredit.js).
//
// RUN AFTER: scripts/bb125-leave-revert.sql + npx prisma generate + the BB-125
// server deploy (the status "reverted" and LeaveDay.revertedAt must exist).
//
// What --apply writes (one transaction):
//   - LeaveDay 2026-10-30 of leave cmv18ijaz0mdhtd4uszkknfpa: revertedAt = now,
//     revertedTimeLogId = her 10-30 punch
//   - Leave: status approved → reverted (its only day), actualPaidHours 5.5 → 0
//   - LeaveBalance (Sick Leave): +5.5h, back into the same fiscal-year lots
//   - LeaveTransaction: a "reverted" row + an "adjustment" +5.5h row, notes
//     tagged "(BB-125 manual fix)"
// Not touched: her punch, its approval, the locked cutoff.
//
// Safety checks before --apply:
//   - exactly 1 leave covering 10-30, the expected id, status approved
//   - one un-reverted LeaveDay on 10-30; latest deduction is −5.5h
//   - exactly 1 approved punch approval on 10-30
//   - the record file doesn't exist yet
//
// Record: scripts/backup-bb125-marites-oct30.json (leave, day, balance, ledger
// before the change) — for reference; no --revert (the ledger is append-only).
//
// Usage:
//   node scripts/fix-bb125-marites-oct30-revert-leave.js            # dry run
//   node scripts/fix-bb125-marites-oct30-revert-leave.js --apply

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
require("module-alias/register");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const { revertLeaveDayOnConflict } = require("@services/Cutoff/leaveConflictCredit");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const EMPLOYEE_EMAIL = "navzferz_1368@yahoo.com";
const LOCAL_DATE = "2026-10-30";
const EXPECTED_LEAVE_ID = "cmv18ijaz0mdhtd4uszkknfpa";
const EXPECTED_HOURS = 5.5;
const NOTE_TAG = " (BB-125 manual fix)";
const RECORD_FILE = path.join(__dirname, "backup-bb125-marites-oct30.json");

const APPLY = process.argv.includes("--apply");
// The default 5 s interactive-transaction timeout is too short from a laptop to the
// Render database (~15 round trips) — the first run timed out and rolled back.
const TX_OPTIONS = { maxWait: 15000, timeout: 120000 };

async function loadState() {
  const company = await prisma.company.findUnique({
    where:  { id: COMPANY_ID },
    select: { id: true, name: true, timeZone: true },
  });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found`);
  const tz = company.timeZone || "America/Los_Angeles";

  const users = await prisma.user.findMany({
    where:  { companyId: COMPANY_ID, email: { equals: EMPLOYEE_EMAIL, mode: "insensitive" } },
    select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
  });
  if (users.length !== 1) throw new Error(`Expected 1 user with ${EMPLOYEE_EMAIL} in PadPro, found ${users.length}`);
  const user = users[0];

  const candidates = await prisma.leave.findMany({
    where: {
      userId:    user.id,
      startDate: { lte: moment.tz(LOCAL_DATE, tz).add(1, "day").endOf("day").toDate() },
      endDate:   { gte: moment.tz(LOCAL_DATE, tz).subtract(1, "day").startOf("day").toDate() },
    },
  });
  const leaves = candidates.filter((l) => {
    const s = l.startDate.toISOString().slice(0, 10);
    const e = l.endDate.toISOString().slice(0, 10);
    return LOCAL_DATE >= s && LOCAL_DATE <= e && !["rejected", "cancelled"].includes(l.status);
  });
  const leave = leaves.length === 1 ? leaves[0] : null;
  const policyId = leave ? (leave.policyId || leave.leaveType) : null;

  // Throws here if the BB-125 SQL / prisma generate hasn't been done (unknown field).
  const days = leave
    ? await prisma.leaveDay.findMany({
        where:  { leaveId: leave.id },
        select: { id: true, date: true, isPaid: true, hours: true, revertedAt: true, revertedTimeLogId: true },
      })
    : [];
  const ledger = leave
    ? await prisma.leaveTransaction.findMany({ where: { leaveId: leave.id }, orderBy: { createdAt: "asc" } })
    : [];
  const balance = policyId
    ? await prisma.leaveBalance.findUnique({ where: { userId_policyId: { userId: user.id, policyId } } })
    : null;

  const dayStart = moment.tz(LOCAL_DATE, tz).startOf("day").toDate();
  const dayEnd   = moment.tz(LOCAL_DATE, tz).endOf("day").toDate();
  const approvals = await prisma.timeLogApproval.findMany({
    where:  { timeLog: { userId: user.id, timeIn: { gte: dayStart, lte: dayEnd } } },
    select: { id: true, status: true, notes: true, approvedBy: true, timeLogId: true },
  });

  return { company, tz, user, leaves, leave, policyId, days, ledger, balance, approvals };
}

function printState(s) {
  const name = [s.user.profile?.firstName, s.user.profile?.lastName].filter(Boolean).join(" ");
  console.log(`Company: ${s.company.name} (${s.company.id})`);
  console.log(`User:    ${name} <${s.user.email}> (${s.user.id})\n`);
  console.log(`Approvals on ${LOCAL_DATE}: ${s.approvals.map((a) => `${a.id} ${a.status} approvedBy=${a.approvedBy ?? "null"} "${a.notes ?? ""}"`).join("; ") || "none"}`);
  console.log(`Leaves covering ${LOCAL_DATE}: ${s.leaves.length}`);
  if (s.leave) {
    const l = s.leave;
    console.log(`  ${l.id} status=${l.status} isPaid=${l.isPaid} paid=${l.actualPaidHours} ${l.startDate.toISOString()} → ${l.endDate.toISOString()}`);
    for (const d of s.days) {
      console.log(`    LeaveDay ${d.date.toISOString().slice(0, 10)} ${d.hours}h ${d.isPaid ? "paid" : "unpaid"} reverted=${d.revertedAt ? d.revertedAt.toISOString() : "no"}`);
    }
    for (const x of s.ledger) {
      console.log(`    ledger ${x.createdAt.toISOString()} ${x.type} hours=${x.hours} ${x.balanceBefore}→${x.balanceAfter} ${x.note ?? ""}`);
    }
  }
  console.log(`Current balance: ${s.balance ? s.balance.balanceHours : "no balance row"}\n`);
}

function checkSafety(s) {
  const problems = [];
  if (s.leaves.length !== 1) problems.push(`expected 1 leave covering ${LOCAL_DATE}, found ${s.leaves.length}`);
  if (s.leave && s.leave.id !== EXPECTED_LEAVE_ID) problems.push(`leave is ${s.leave.id}, expected ${EXPECTED_LEAVE_ID}`);
  if (s.leave && s.leave.status !== "approved") problems.push(`leave status is ${s.leave.status}, not approved — already reverted?`);
  const openDays = s.days.filter((d) => d.date.toISOString().slice(0, 10) === LOCAL_DATE && !d.revertedAt);
  if (!openDays.length) problems.push(`no un-reverted LeaveDay on ${LOCAL_DATE}`);
  const deductions = s.ledger.filter((x) => x.type === "deduction");
  const last = deductions[deductions.length - 1];
  if (!last) problems.push("no deduction ledger row — nothing to refund");
  else if (Math.abs(Number(last.hours)) !== EXPECTED_HOURS) problems.push(`deduction is ${last.hours}h, expected −${EXPECTED_HOURS}h`);
  const approved = s.approvals.filter((a) => a.status === "approved");
  if (approved.length !== 1) problems.push(`expected 1 approved punch on ${LOCAL_DATE}, found ${approved.length}`);
  if (!s.balance) problems.push("no LeaveBalance row for this policy");
  if (fs.existsSync(RECORD_FILE)) problems.push(`record file already exists at ${RECORD_FILE} — already applied?`);
  return problems;
}

async function apply(s) {
  const timeLogId = s.approvals.find((a) => a.status === "approved").timeLogId;
  const startedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const r = await revertLeaveDayOnConflict(tx, { leave: s.leave, dateStr: LOCAL_DATE, userId: null, timeLogId });
    if (!r.reverted) throw new Error("Nothing was reverted (state changed since the check?) — rolled back");
    const rows = await tx.leaveTransaction.findMany({
      where: { leaveId: s.leave.id, type: { in: ["reverted", "adjustment"] }, createdAt: { gte: startedAt } },
    });
    for (const row of rows) {
      await tx.leaveTransaction.update({ where: { id: row.id }, data: { note: `${row.note ?? ""}${NOTE_TAG}` } });
    }
    return r;
  }, TX_OPTIONS);

  // Written only after the commit, so a failed run leaves nothing behind.
  fs.writeFileSync(RECORD_FILE, JSON.stringify({
    ticket: "BB-125", appliedAt: new Date().toISOString(),
    leave: s.leave, days: s.days, balance: s.balance, ledger: s.ledger,
  }, null, 2));
  console.log(`Record written: ${RECORD_FILE}`);

  const after = await prisma.leaveBalance.findUnique({
    where: { userId_policyId: { userId: s.user.id, policyId: s.policyId } },
  });
  console.log(`✅ Applied: ${result.hours}h returned; leave status ${result.leaveStatus}; balance ${s.balance.balanceHours} → ${after?.balanceHours}. Punch untouched.`);
}

async function main() {
  const state = await loadState();
  printState(state);

  const problems = checkSafety(state);
  if (problems.length) {
    console.log("⛔ Safety checks failed — nothing written:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const before = Number(state.balance.balanceHours);
  console.log("Plan:");
  console.log(`  LeaveDay ${LOCAL_DATE}: reverted (linked to her 10-30 punch)`);
  console.log(`  Leave ${state.leave.id}: approved ⇒ reverted (its only day)`);
  console.log(`  Sick Leave balance: ${before} ⇒ ${+(before + EXPECTED_HOURS).toFixed(2)} (+${EXPECTED_HOURS}h, back into the same FY lots)`);
  console.log(`  Ledger: + "reverted" and + "adjustment ${EXPECTED_HOURS}h", tagged${NOTE_TAG}`);
  console.log("  Punch / approval / cutoff: unchanged\n");

  if (!APPLY) {
    console.log("Dry run — re-run with --apply to write.");
    return;
  }
  await apply(state);
}

main()
  .catch((e) => {
    console.error("❌", e.message?.includes("revertedAt") ? `${e.message}\n   → Run scripts/bb125-leave-revert.sql and npx prisma generate first.` : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // leaveConflictCredit loads the app's shared Prisma client — exit explicitly
    // so that second connection doesn't keep the process open.
    process.exit(process.exitCode || 0);
  });
