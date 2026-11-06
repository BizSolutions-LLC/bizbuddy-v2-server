// scripts/check-bb106-evelyn-sick-leave.js
//
// BB-106 diagnostic: why does the Leave Report show Evelyn Garnace with 13.00
// Sick Leave hours under the Aug 7 pay date when the ledger row shows -5h?
// This is a READ-ONLY script: no writes.
//
// What it prints, per Sick Leave policy:
//   1. Cutoffs behind each pay date in the Jul/Aug window: the one the report
//      uses (no department filter) next to her own department's.
//   2. Every leave of this type, with its LeaveDay rows, flagging any leave
//      whose paid rows don't add up to actualPaidHours or its ledger deduction.
//   3. Paid hours per report column, listing the leave days behind each cell.
//   4. Every ledger row with hours, and the "Credits" total (explains the -19).
//   5. Balance from the report's formula next to the live LeaveBalance.
//
// cutoffsForYear() and the credit rules are copied from
// services/Reports/leaveTemplateReportService.js and leaveReportService.js.
//
// Usage: node scripts/check-bb106-evelyn-sick-leave.js

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

const FIRST_NAME = "Evelyn";
const LAST_NAME = "Garnace";
const YEAR = 2026;
const SHOW_FROM = `${YEAR}-06-15`; // cutoff listing window, by pay date
const SHOW_TO = `${YEAR}-09-15`;

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;

function cutoffsForYear(all, year) {
  const inYear = all.filter((c) => c.paymentDate.startsWith(`${year}-`));
  const companyWide = inYear.filter((c) => c.departmentId === null);
  const pick = companyWide.length ? companyWide : inYear;

  const byPayDate = new Map();
  for (const c of [...pick].sort((a, b) => a.periodStart.localeCompare(b.periodStart))) {
    if (!byPayDate.has(c.paymentDate)) byPayDate.set(c.paymentDate, c);
  }
  return [...byPayDate.values()].sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
}

function creditOf(t) {
  const h = num(t.hours);
  if (t.type === "accrual") return h;
  if (t.type === "expired") return h; // stored as negative hours, so this lowers Credits
  if (t.type === "adjustment" && !t.leaveId) return h;
  return null;
}

async function checkPolicy(user, policy, cutoffs, tz) {
  console.log(`\n${"=".repeat(78)}\nPOLICY: ${policy.leaveType} (${policy.id})`);
  console.log(`  archived: ${policy.isArchived}, negativeAllowed: ${policy.negativeAllowed}`);

  const columns = cutoffsForYear(cutoffs, YEAR);
  const prevColumns = cutoffsForYear(cutoffs, YEAR - 1);
  if (!columns.length) {
    console.log(`  No cutoffs paid in ${YEAR}; the report would use calendar months. Stopping here.`);
    return;
  }

  // 1. Cutoffs
  console.log("\n1. CUTOFFS BY PAY DATE");
  console.log("   pay date    report window              her department's window");
  const own = cutoffs.filter((c) => c.departmentId === user.departmentId);
  for (const c of columns.filter((x) => x.paymentDate >= SHOW_FROM && x.paymentDate <= SHOW_TO)) {
    const mine = own.find((o) => o.paymentDate === c.paymentDate);
    const mineText = mine ? `${mine.periodStart} to ${mine.periodEnd}` : "(none on this pay date)";
    const differs = !mine || mine.periodStart !== c.periodStart || mine.periodEnd !== c.periodEnd;
    console.log(`   ${c.paymentDate}  ${c.periodStart} to ${c.periodEnd}   ${mineText}${differs ? "   <-- DIFFERS" : ""}`);
  }

  // 2. Leaves
  const leaves = await prisma.leave.findMany({
    where:   { userId: user.id, OR: [{ policyId: policy.id }, { leaveType: policy.id }] },
    include: { days: { orderBy: [{ date: "asc" }, { isPaid: "desc" }] } },
    orderBy: { startDate: "asc" },
  });
  const txns = await prisma.leaveTransaction.findMany({
    where:   { userId: user.id, policyId: policy.id, hours: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n2. LEAVES (${leaves.length})`);
  const problems = [];
  for (const l of leaves) {
    const paid = r2(l.days.filter((d) => d.isPaid).reduce((s, d) => s + num(d.hours), 0));
    const unpaid = r2(l.days.filter((d) => !d.isPaid).reduce((s, d) => s + num(d.hours), 0));
    const deducted = r2(-txns.filter((t) => t.leaveId === l.id && t.type === "deduction").reduce((s, t) => s + num(t.hours), 0));

    console.log(`\n   ${l.id}  ${l.status}  ${ymd(l.startDate)} to ${ymd(l.endDate)}  requested paid: ${l.isPaid}`);
    console.log(`     actualPaidHours: ${l.actualPaidHours ?? "null"}, actualUnpaidHours: ${l.actualUnpaidHours ?? "null"}`);
    console.log(`     LeaveDay paid: ${paid}h, unpaid: ${unpaid}h, ledger deduction: ${deducted}h`);
    for (const d of l.days) console.log(`       ${ymd(d.date)}  ${num(d.hours)}h  ${d.isPaid ? "paid" : "unpaid"}`);

    if (l.status === "approved") {
      if (l.actualPaidHours !== null && paid !== r2(num(l.actualPaidHours))) {
        problems.push(`${l.id}: paid LeaveDay ${paid}h vs actualPaidHours ${num(l.actualPaidHours)}h`);
      }
      if (paid !== deducted) problems.push(`${l.id}: paid LeaveDay ${paid}h vs ledger deduction ${deducted}h`);
    }
  }

  // 3. Report cells
  console.log(`\n3. REPORT CELLS (approved, paid LeaveDay rows, same rule as the report)`);
  const cells = new Map();
  const outside = [];
  const start = columns[0].periodStart;
  const end = columns[columns.length - 1].periodEnd;
  let usedInYear = 0;
  for (const l of leaves.filter((x) => x.status === "approved")) {
    for (const d of l.days.filter((x) => x.isPaid)) {
      const day = ymd(d.date);
      if (day < start || day > end) continue;
      usedInYear += num(d.hours);
      const col = columns.find((c) => day >= c.periodStart && day <= c.periodEnd);
      if (!col) { outside.push(`${day} ${num(d.hours)}h (leave ${l.id})`); continue; }
      if (!cells.has(col.paymentDate)) cells.set(col.paymentDate, []);
      cells.get(col.paymentDate).push({ day, hours: num(d.hours), leaveId: l.id });
    }
  }
  for (const [pay, rows] of [...cells.entries()].sort()) {
    console.log(`   ${pay}: ${r2(rows.reduce((s, r) => s + r.hours, 0))}h`);
    for (const r of rows) console.log(`     ${r.day}  ${r.hours}h  (leave ${r.leaveId})`);
  }
  if (outside.length) {
    console.log("   Paid days inside the year but in NO column (deducted from Balance, missing from cells):");
    for (const o of outside) console.log(`     ${o}`);
  }

  // 4. Ledger
  console.log("\n4. LEDGER ROWS WITH HOURS");
  const localDay = (t) => moment(t.createdAt).tz(tz).format("YYYY-MM-DD");
  let credits = 0;
  for (const t of txns) {
    const day = localDay(t);
    const credit = creditOf(t);
    const inYear = day >= start && day <= end;
    if (credit !== null && inYear) credits += credit;
    const tag = credit !== null ? (inYear ? "  [in Credits]" : "  [credit, other year]") : "";
    console.log(`   ${day}  ${t.type.padEnd(11)} ${String(num(t.hours)).padStart(8)}h  ${t.balanceBefore ?? "—"} -> ${t.balanceAfter ?? "—"}  ${t.note ?? ""}${tag}`);
  }
  console.log(`   Credits for ${YEAR} from these rows: ${r2(credits)}h (the sheet showed -19.00)`);

  // 5. Balance
  const bal = await prisma.leaveBalance.findUnique({
    where: { userId_policyId: { userId: user.id, policyId: policy.id } },
  });
  console.log("\n5. BALANCE");
  console.log(`   Paid hours used in the ${YEAR} window: ${r2(usedInYear)}h`);
  console.log(`   Live LeaveBalance: ${bal ? num(bal.balanceHours) : "none"}h`);
  console.log(`   Window: ${start} to ${end} (previous year starts ${prevColumns[0]?.periodStart ?? "n/a"})`);

  console.log("\nRESULT");
  if (problems.length) {
    console.log("   Rows disagree, so look at the source data:");
    for (const p of problems) console.log(`     ${p}`);
  } else {
    console.log("   Every approved leave's paid LeaveDay rows match actualPaidHours and the ledger.");
    console.log("   If section 3 still shows 13h, the cell is a sum of more than one leave.");
  }
}

async function main() {
  const users = await prisma.user.findMany({
    where: {
      profile: {
        firstName: { equals: FIRST_NAME, mode: "insensitive" },
        lastName:  { equals: LAST_NAME, mode: "insensitive" },
      },
    },
    select: { id: true, companyId: true, departmentId: true, hireDate: true, department: { select: { name: true } } },
  });

  if (users.length !== 1) {
    console.log(`Expected 1 user named ${FIRST_NAME} ${LAST_NAME}, found ${users.length}. Stopping.`);
    for (const u of users) console.log(`  ${u.id} company ${u.companyId}`);
    return;
  }
  const user = users[0];
  console.log(`USER: ${FIRST_NAME} ${LAST_NAME} (${user.id})`);
  console.log(`  company: ${user.companyId}, department: ${user.department?.name ?? "none"} (${user.departmentId ?? "—"}), hired: ${ymd(user.hireDate)}`);

  const company = await prisma.company.findUnique({ where: { id: user.companyId }, select: { timeZone: true } });
  const tz = company?.timeZone || "America/Los_Angeles";

  const policies = await prisma.leavePolicy.findMany({
    where:  { companyId: user.companyId, leaveType: { contains: "sick", mode: "insensitive" } },
    select: { id: true, leaveType: true, isArchived: true, negativeAllowed: true },
  });
  if (!policies.length) {
    console.log("No Sick Leave policy found for this company. Stopping.");
    return;
  }

  const raw = await prisma.cutoffPeriod.findMany({
    where: {
      companyId:   user.companyId,
      paymentDate: { gte: new Date(`${YEAR - 1}-01-01T00:00:00.000Z`), lte: new Date(`${YEAR}-12-31T23:59:59.999Z`) },
    },
    select: { periodStart: true, periodEnd: true, paymentDate: true, departmentId: true },
  });
  const cutoffs = raw.map((c) => ({
    periodStart:  ymd(c.periodStart),
    periodEnd:    ymd(c.periodEnd),
    paymentDate:  ymd(c.paymentDate),
    departmentId: c.departmentId,
  }));

  for (const p of policies) await checkPolicy(user, p, cutoffs, tz);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
