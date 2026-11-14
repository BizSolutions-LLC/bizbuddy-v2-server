// scripts/fix-bb125-elizabeth-aug07-revert-leave.js
//
// BB-125 audit correction — Elizabeth Pabilona (Piedmont Adult Day Program), Aug 7 2026.
// She worked 8:54 → 1:30 on 8-07 (punch approved, paid 4.59h). The next day she
// filed a 5.5h paid Sick Leave for 8-07, which was approved: 5.5h left her balance.
// The old auto-revert ("punch takes precedence") approved the punch but its leave
// lookup missed the leave (BB-073). Found by scripts/check-bb125-punch-wins-history.js
// (section 3, AUTO_REVERT_FAILED).
//
// Decision (user, 2026-11-14): she worked and was already paid, so just revert the
// 5.5h leave day. Her punch and its hours are NOT touched.
//
// What --apply writes (one transaction), via revertLeaveDayOnConflict:
//   - LeaveDay 2026-08-07 of leave cmsjc2mkq0dmeti506qackmir: revertedAt = now,
//     revertedTimeLogId = her 8-07 punch
//   - Leave: approved → reverted if 8-07 is its only counted day (else stays
//     approved = "Partly reverted"), actualPaidHours reduced by 5.5
//   - LeaveBalance (Sick Leave): +5.5h, back into the same fiscal-year lots
//   - LeaveTransaction: "reverted" + "adjustment" +5.5h, tagged "(BB-125 audit correction)"
// Not touched: her punch, its approval, the cutoff.
//
// Safety checks before --apply: the expected leave, status approved, one un-reverted
// paid LeaveDay on 8-07 worth 5.5h, exactly 1 approved punch on 8-07, no record file.
//
// Record: scripts/backup-bb125-elizabeth-aug07.json (before-state, written after commit).
//
// Usage:
//   node scripts/fix-bb125-elizabeth-aug07-revert-leave.js            # dry run
//   node scripts/fix-bb125-elizabeth-aug07-revert-leave.js --apply

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
const LOCAL_DATE = "2026-08-07";
const EXPECTED_LEAVE_ID = "cmsjc2mkq0dmeti506qackmir";
const EXPECTED_TIMELOG_ID = "cmsj4l4220dbxti50humqri25";
const EXPECTED_HOURS = 5.5;
const NOTE_TAG = " (BB-125 audit correction)";
const RECORD_FILE = path.join(__dirname, "backup-bb125-elizabeth-aug07.json");

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

  // The user is taken from the expected leave (ids come from the audit output).
  const expected = await prisma.leave.findUnique({ where: { id: EXPECTED_LEAVE_ID }, select: { userId: true } });
  if (!expected) throw new Error(`Leave ${EXPECTED_LEAVE_ID} not found`);
  const user = await prisma.user.findUnique({
    where:  { id: expected.userId },
    select: { id: true, email: true, companyId: true, profile: { select: { firstName: true, lastName: true } } },
  });
  if (!user || user.companyId !== COMPANY_ID) throw new Error("Leave's employee is not in PadPro");

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
  if (!s.ledger.some((x) => x.type === "deduction")) problems.push("no deduction ledger row — nothing to refund");
  const approved = s.approvals.filter((a) => a.status === "approved");
  if (approved.length !== 1) problems.push(`expected 1 approved punch on ${LOCAL_DATE}, found ${approved.length}`);
  else if (approved[0].timeLogId !== EXPECTED_TIMELOG_ID) problems.push(`approved punch is ${approved[0].timeLogId}, expected ${EXPECTED_TIMELOG_ID}`);
  const name = [s.user.profile?.firstName, s.user.profile?.lastName].filter(Boolean).join(" ");
  if (!/elizabeth/i.test(name) || !/pabilona/i.test(name)) problems.push(`employee is "${name}", expected Elizabeth Pabilona`);
  const paidOpen = openDays.filter((d) => d.isPaid).reduce((t, d) => t + Number(d.hours), 0);
  if (openDays.length && paidOpen !== EXPECTED_HOURS) problems.push(`8-07 paid leave hours are ${paidOpen}, expected ${EXPECTED_HOURS}`);
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
  console.log(`  LeaveDay ${LOCAL_DATE}: reverted (linked to her 8-07 punch)`);
  console.log(`  Leave ${state.leave.id}: ${state.days.filter((d) => !d.revertedAt).length > 1 ? "stays approved (Partly reverted — other days remain)" : "approved ⇒ reverted (its only day)"}`);
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
