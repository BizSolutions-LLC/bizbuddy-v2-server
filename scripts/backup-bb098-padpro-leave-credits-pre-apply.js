// scripts/backup-bb098-padpro-leave-credits-pre-apply.js
//
// BB-098 — Snapshot of PadPro's leave data BEFORE running leave credit
// setup / Apply (turning on expiration and grants), so the change can be
// reverted if needed.
//
// What Apply (and the hourly leaveCreditWorker after it) writes:
//   - Company: leave credit settings, both toggles, leaveCreditsInitializedAt
//   - LeaveCredit: one lot per employee × leave type × fiscal year
//   - LeaveBalance: balanceHours (expired lots, later grants),
//     lastGrantPeriod, regularizationGrantedAt; new 0h rows for eligible
//     employees who had none
//   - LeaveTransaction: "expired" and "accrual" rows
//   - LeaveCreditUsage: which lots each later-approved leave consumed
//   - NotificationLog: LEAVE_CREDITS_EXPIRING reminders
// All of those are captured here, in full, plus the leave policies and an
// employee list for readability.
//
// It performs NO DB writes (SELECTs only). Its only side effect is writing the
// backup JSON next to this file. It refuses to overwrite an existing backup.
//
// Output file: scripts/backup-bb098-padpro-leave-credits-pre-apply-YYYY-MM-DD.json
//
// Usage: node scripts/backup-bb098-padpro-leave-credits-pre-apply.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const TODAY = new Date().toISOString().slice(0, 10);
const BACKUP_FILE = path.join(__dirname, `backup-bb098-padpro-leave-credits-pre-apply-${TODAY}.json`);

const num = (v) => (v == null ? 0 : Number(v));
const r2 = (n) => +Number(n).toFixed(2);
const fullName = (u) =>
  `${u.profile?.firstName || ""} ${u.profile?.lastName || ""}`.trim() || u.email;

async function main() {
  if (fs.existsSync(BACKUP_FILE)) {
    console.log(`Backup already exists: ${BACKUP_FILE}`);
    console.log("Refusing to overwrite it. Move/rename it first if you really want a fresh backup.");
    return;
  }

  const takenAt = new Date().toISOString();

  // ── Company (all columns, so every leave setting is captured) ───────────
  const company = await prisma.company.findUnique({ where: { id: COMPANY_ID } });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found`);
  const companyLeaveFields = Object.fromEntries(
    Object.entries(company).filter(([k]) => k.toLowerCase().includes("leave") || k.toLowerCase().includes("accrual"))
  );

  const policies = await prisma.leavePolicy.findMany({
    where:   { companyId: COMPANY_ID },
    include: { assignments: true },
    orderBy: { leaveType: "asc" },
  });
  const policyIds = policies.map((p) => p.id);
  const policyName = Object.fromEntries(policies.map((p) => [p.id, p.leaveType]));

  const [users, balances, transactions, credits, usages, reminders] = await Promise.all([
    prisma.user.findMany({
      where:  { companyId: COMPANY_ID },
      select: {
        id: true, email: true, status: true, hireDate: true,
        profile: { select: { firstName: true, lastName: true } },
      },
      orderBy: { email: "asc" },
    }),
    prisma.leaveBalance.findMany({
      where:   { policyId: { in: policyIds } },
      orderBy: [{ userId: "asc" }, { policyId: "asc" }],
    }),
    prisma.leaveTransaction.findMany({
      where:   { policyId: { in: policyIds } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.leaveCredit.findMany({
      where:   { policyId: { in: policyIds } },
      orderBy: [{ userId: "asc" }, { policyId: "asc" }, { fiscalYear: "asc" }],
    }),
    prisma.leaveCreditUsage.findMany({
      where:   { credit: { policyId: { in: policyIds } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.notificationLog.findMany({
      where:   { companyId: COMPANY_ID, notificationCode: "LEAVE_CREDITS_EXPIRING" },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const userName = Object.fromEntries(users.map((u) => [u.id, fullName(u)]));

  // ── Summary ──────────────────────────────────────────────────────────────
  const perLeaveType = {};
  for (const p of policies) perLeaveType[p.leaveType] = { balances: 0, nonZero: 0, totalHours: 0 };
  for (const b of balances) {
    const s = perLeaveType[policyName[b.policyId]];
    s.balances += 1;
    if (num(b.balanceHours) !== 0) s.nonZero += 1;
    s.totalHours = r2(s.totalHours + num(b.balanceHours));
  }
  const txByType = {};
  for (const t of transactions) txByType[t.type] = (txByType[t.type] || 0) + 1;
  const lastTx = transactions[transactions.length - 1];

  const summary = {
    takenAt,
    companyId:                 COMPANY_ID,
    companyName:               company.name,
    leaveCreditsInitializedAt: company.leaveCreditsInitializedAt ?? null,
    leaveGrantEnabled:         company.leaveGrantEnabled ?? null,
    leaveExpirationEnabled:    company.leaveExpirationEnabled ?? null,
    counts: {
      users:             users.length,
      policies:          policies.length,
      leaveBalances:     balances.length,
      leaveTransactions: transactions.length,
      leaveCredits:      credits.length,
      leaveCreditUsages: usages.length,
      expiryReminders:   reminders.length,
    },
    perLeaveType,
    transactionsByType: txByType,
    // Anything created after this point came from Apply or later activity.
    lastTransaction: lastTx ? { id: lastTx.id, createdAt: lastTx.createdAt } : null,
  };

  const backup = {
    summary,
    company,
    companyLeaveFields,
    policies,
    users: users.map((u) => ({ ...u, name: fullName(u) })),
    leaveBalances: balances.map((b) => ({
      ...b,
      _employee:  userName[b.userId] ?? null,
      _leaveType: policyName[b.policyId] ?? null,
    })),
    leaveTransactions: transactions,
    leaveCredits:      credits,
    leaveCreditUsages: usages,
    expiryReminders:   reminders,
  };

  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));

  // ── Console report ───────────────────────────────────────────────────────
  console.log(`Company: ${company.name} (${COMPANY_ID})`);
  console.log(`leaveCreditsInitializedAt: ${summary.leaveCreditsInitializedAt ?? "null (setup not applied yet)"}`);
  console.log(`leaveGrantEnabled: ${summary.leaveGrantEnabled}   leaveExpirationEnabled: ${summary.leaveExpirationEnabled}`);
  console.log("\n--- Counts ---");
  for (const [k, v] of Object.entries(summary.counts)) console.log(`  ${k}: ${v}`);
  console.log("\n--- Balances per leave type (all employees) ---");
  for (const [k, v] of Object.entries(perLeaveType))
    console.log(`  ${k}: ${v.nonZero} non-zero of ${v.balances} rows, total ${v.totalHours}h`);
  console.log("\n--- Ledger rows by type ---");
  for (const [k, v] of Object.entries(txByType)) console.log(`  ${k}: ${v}`);
  if (lastTx) console.log(`\nLast ledger row: ${lastTx.id} at ${new Date(lastTx.createdAt).toISOString()}`);
  if (credits.length)
    console.log(`\nNOTE: ${credits.length} LeaveCredit lots already exist — setup may have run already.`);
  console.log(`\nBackup written: ${BACKUP_FILE}`);
}

main()
  .catch((err) => {
    console.error("Backup failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
