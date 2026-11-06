// scripts/check-bb098-padpro-grant-mode.js
//
// BB-098 — PadPro's leave credit setup was applied with Grant Mode = Yearly
// lump sum (and Regularization = Full) instead of Monthly accrual. Before the
// fix, this shows what setup and the hourly leaveCreditWorker have written
// since leaveCreditsInitializedAt:
//   1. Automatic grants: "accrual" ledger rows (Annual grant / Monthly
//      accrual) and the LeaveBalance.lastGrantPeriod values
//   2. Regularization grants: "Regularization grant …" rows and balances with
//      regularizationGrantedAt set, plus who reaches regularization soon
//      (under "Full" the worker would give them 40h on that day)
//   3. "expired" rows written by Apply / the worker
//   4. LeaveCreditUsage rows and approved / cancelled leaves since setup
//   5. Admin adjustments since setup (they also moved lots)
//
// SELECTs only — no DB writes, no files written.
//
// Usage: node scripts/check-bb098-padpro-grant-mode.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const UPCOMING_DAYS = 90; // list regularizations due within this many days

const num = (v) => (v == null ? 0 : Number(v));
const r2 = (n) => +Number(n).toFixed(2);
const fullName = (u) =>
  `${u.profile?.firstName || ""} ${u.profile?.lastName || ""}`.trim() || u.email;

// Same rule as leaveCreditService.hireDateStr / regularizationDateStr.
function hireDateStr(tz, hireDate) {
  if (!hireDate) return null;
  const iso = new Date(hireDate).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : moment.tz(hireDate, tz).format("YYYY-MM-DD");
}

async function main() {
  const company = await prisma.company.findUnique({ where: { id: COMPANY_ID } });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found`);
  const tz = company.timeZone || "America/Los_Angeles";
  const local = (d) => (d ? moment.tz(d, tz).format("YYYY-MM-DD HH:mm") : "—");

  console.log(`Company: ${company.name} (${COMPANY_ID})`);
  console.log("\n--- Settings ---");
  for (const k of [
    "leaveCreditsInitializedAt", "leaveGrantEnabled", "leaveExpirationEnabled", "leaveGrantMode",
    "leaveGrantHours", "leaveYearStartMonth", "leaveYearStartDay", "leaveCreditLifetimeYears",
    "leaveExpiryReminderDays", "leaveRegularizationMonths", "leaveRegularizationGrant",
  ]) {
    const v = company[k];
    console.log(`  ${k}: ${v instanceof Date ? `${v.toISOString()} (${local(v)} PT)` : v}`);
  }
  if (!company.leaveCreditsInitializedAt) {
    console.log("\nSetup has NOT been applied (leaveCreditsInitializedAt is null). Nothing else to check.");
    return;
  }
  const since = company.leaveCreditsInitializedAt;

  const policies = await prisma.leavePolicy.findMany({
    where:  { companyId: COMPANY_ID },
    select: { id: true, leaveType: true },
  });
  const policyIds = policies.map((p) => p.id);
  const policyName = Object.fromEntries(policies.map((p) => [p.id, p.leaveType]));

  const [users, balances, txSince, usages, credits] = await Promise.all([
    prisma.user.findMany({
      where:  { companyId: COMPANY_ID },
      select: { id: true, email: true, status: true, hireDate: true, profile: { select: { firstName: true, lastName: true } } },
    }),
    prisma.leaveBalance.findMany({ where: { policyId: { in: policyIds } } }),
    prisma.leaveTransaction.findMany({
      where:   { policyId: { in: policyIds }, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.leaveCreditUsage.findMany({
      where:   { credit: { policyId: { in: policyIds } } },
      include: { credit: { select: { userId: true, policyId: true, fiscalYear: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.leaveCredit.findMany({ where: { policyId: { in: policyIds } } }),
  ]);
  const userById = Object.fromEntries(users.map((u) => [u.id, u]));
  const who = (userId, policyId) => `${fullName(userById[userId] || { email: userId })} — ${policyName[policyId]}`;
  const printTx = (t) =>
    console.log(`    ${local(t.createdAt)}  ${who(t.userId, t.policyId)}  ${t.hours ?? ""}h  [${t.id}]  ${t.note ?? ""}`);

  const byType = {};
  for (const t of txSince) (byType[t.type] ??= []).push(t);
  console.log(`\nLedger rows since setup (${local(since)} PT): ${txSince.length}`);
  for (const [k, v] of Object.entries(byType)) console.log(`  ${k}: ${v.length}`);

  // ── 1. Automatic grants ────────────────────────────────────────────────
  const accruals = byType.accrual ?? [];
  const regGrants = accruals.filter((t) => (t.note || "").startsWith("Regularization grant"));
  const autoGrants = accruals.filter((t) => !regGrants.includes(t));
  console.log(`\n[1] Automatic grants (Annual grant / Monthly accrual): ${autoGrants.length}`);
  autoGrants.forEach(printTx);
  const periodCounts = {};
  for (const b of balances) periodCounts[b.lastGrantPeriod ?? "null"] = (periodCounts[b.lastGrantPeriod ?? "null"] || 0) + 1;
  console.log("  LeaveBalance.lastGrantPeriod values:");
  for (const [k, v] of Object.entries(periodCounts)) console.log(`    ${k}: ${v} rows`);

  // ── 2. Regularization grants ───────────────────────────────────────────
  console.log(`\n[2] Regularization grant ledger rows: ${regGrants.length}`);
  regGrants.forEach(printTx);
  const regSet = balances.filter((b) => b.regularizationGrantedAt);
  console.log(`  Balances with regularizationGrantedAt set: ${regSet.length}`);
  for (const b of regSet) console.log(`    ${who(b.userId, b.policyId)}  at ${local(b.regularizationGrantedAt)}  [${b.id}]`);

  const sinceStr = moment.tz(since, tz).format("YYYY-MM-DD");
  const today = moment.tz(tz).format("YYYY-MM-DD");
  const horizon = moment.utc(today).add(UPCOMING_DAYS, "days").format("YYYY-MM-DD");
  const months = company.leaveRegularizationMonths || 0;
  const upcoming = [];
  const noHire = [];
  for (const u of users.filter((x) => x.status === "active")) {
    const hire = hireDateStr(tz, u.hireDate);
    if (!hire) { if (months > 0) noHire.push(fullName(u)); continue; }
    const reg = moment.utc(hire).add(months, "months").format("YYYY-MM-DD");
    if (reg >= sinceStr && reg <= horizon) upcoming.push({ name: fullName(u), hire, reg });
  }
  upcoming.sort((a, b) => a.reg.localeCompare(b.reg));
  console.log(`  Active employees regularized on/after setup, through ${horizon}: ${upcoming.length}`);
  for (const x of upcoming) console.log(`    ${x.reg}  ${x.name} (hired ${x.hire})${x.reg <= today ? "  <-- already due" : ""}`);
  if (noHire.length) console.log(`  Active employees with no hireDate (skipped by grants): ${noHire.length} — ${noHire.join(", ")}`);

  // ── 3. Expired entries ─────────────────────────────────────────────────
  const expired = byType.expired ?? [];
  console.log(`\n[3] Expired rows: ${expired.length}, total ${r2(expired.reduce((s, t) => s + num(t.hours), 0))}h`);
  expired.forEach(printTx);

  // ── 4. Leave usage since setup ─────────────────────────────────────────
  console.log(`\n[4] LeaveCreditUsage rows: ${usages.length}`);
  for (const u of usages)
    console.log(`    ${local(u.createdAt)}  ${who(u.credit.userId, u.credit.policyId)}  FY${u.credit.fiscalYear}  ${num(u.hours)}h  leave ${u.leaveId}`);
  for (const type of ["deduction", "approved", "cancelled"]) {
    const rows = byType[type] ?? [];
    console.log(`  "${type}" ledger rows since setup: ${rows.length}`);
    rows.forEach(printTx);
  }

  // ── 5. Admin adjustments / credit-backs since setup ────────────────────
  const adjustments = byType.adjustment ?? [];
  console.log(`\n[5] Adjustment rows since setup: ${adjustments.length} (leaveId set = cutoff credit-back)`);
  adjustments.forEach(printTx);

  // ── Lots overview ──────────────────────────────────────────────────────
  const lotsByFy = {};
  for (const l of credits) {
    const s = (lotsByFy[l.fiscalYear] ??= { lots: 0, granted: 0, remaining: 0, expired: 0 });
    s.lots += 1;
    s.granted = r2(s.granted + num(l.grantedHours));
    s.remaining = r2(s.remaining + num(l.remainingHours));
    s.expired = r2(s.expired + num(l.expiredHours));
  }
  console.log(`\nLeaveCredit lots: ${credits.length}`);
  for (const [fy, s] of Object.entries(lotsByFy))
    console.log(`  FY${fy}: ${s.lots} lots, granted ${s.granted}h, remaining ${s.remaining}h, expired ${s.expired}h`);
}

main()
  .catch((err) => {
    console.error("Check failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
