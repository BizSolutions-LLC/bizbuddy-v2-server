// One-off verification script for Phase 4 of the Leave Module redo
// (see docs/UPDATED_LEAVE_MODULE.md §14d). Exercises submit -> preview ->
// approve end-to-end against throwaway test data (a dedicated scratch
// company + 2 users), asserts the results, then deletes everything it
// created. Does NOT touch any real company/employee data.
//
// Usage: node scripts/verify-phase4-leave-approval.js

require("module-alias/register");
const { prisma } = require("@config/connection");
const { applyLeaveApproval, previewLeaveApproval } = require("@services/Leave/leaveApprovalService");

const TAG = `phase4verify-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function nextMonday() {
  const d = new Date();
  const day = d.getDay();
  const diff = ((8 - day) % 7) || 7; // always a future Monday, never today
  d.setDate(d.getDate() + diff);
  return d;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`=== Phase 4 Leave Approval Verification (${TAG}) ===\n`);
  console.log("Creating throwaway test data (company, 2 users, 1 policy, seeded balance)...");

  const company = await prisma.company.create({
    data: { name: TAG, timeZone: "America/Los_Angeles", defaultShiftHours: 8 },
  });

  const admin = await prisma.user.create({
    data: {
      username: `${TAG}-admin`,
      email: `${TAG}-admin@example.com`,
      password: "test",
      companyId: company.id,
      role: "admin",
      status: "active",
    },
  });

  const employee = await prisma.user.create({
    data: {
      username: `${TAG}-employee`,
      email: `${TAG}-employee@example.com`,
      password: "test",
      companyId: company.id,
      role: "employee",
      status: "active",
    },
  });

  const policy = await prisma.leavePolicy.create({
    data: {
      companyId: company.id,
      leaveType: "Verify Leave",
      annualAllocation: 0,
      accrualFrequency: "none",
      accrualUnit: "hours",
      isPaid: true,
      isNotPaid: true,
      assignedToAll: true,
      negativeAllowed: false,
    },
  });

  await prisma.leaveBalance.create({
    data: { userId: employee.id, policyId: policy.id, balanceHours: 12 },
  });
  console.log("Balance seeded: 12h available.\n");

  // ── Case 1: paid request, insufficient balance -> per-day proration ──────
  const monday  = nextMonday();
  const tuesday = addDays(monday, 1);

  const leave1 = await prisma.leave.create({
    data: {
      userId: employee.id, approverId: admin.id, policyId: policy.id, leaveType: policy.id,
      startDate: `${isoDate(monday)}T12:00:00.000Z`, endDate: `${isoDate(tuesday)}T12:00:00.000Z`,
      status: "pending", isPaid: true,
    },
  });

  console.log("--- Case 1: Paid request, 2 weekdays, only 12h available (needs 16h) ---");
  const preview1 = await previewLeaveApproval(leave1, policy);
  console.log("Preview:", JSON.stringify(preview1));

  const result1 = await applyLeaveApproval(leave1, policy, admin.id, "verify case 1");
  console.log("Apply result:", result1);

  const bal1  = await prisma.leaveBalance.findUnique({ where: { userId_policyId: { userId: employee.id, policyId: policy.id } } });
  const days1 = await prisma.leaveDay.findMany({ where: { leaveId: leave1.id }, orderBy: { date: "asc" } });
  const txns1 = await prisma.leaveTransaction.findMany({ where: { leaveId: leave1.id } });

  assert(Number(bal1.balanceHours) === 4, `Expected balance 4h after case 1, got ${bal1.balanceHours}`);
  assert(days1.length === 2, `Expected 2 LeaveDay rows, got ${days1.length}`);
  assert(days1[0].isPaid === true  && Number(days1[0].hours) === 8, "Day 1 should be paid 8h");
  assert(days1[1].isPaid === false && Number(days1[1].hours) === 8, "Day 2 should be unpaid 8h");
  assert(txns1.length === 1 && Number(txns1[0].hours) === -8, "Expected exactly one -8h deduction transaction");
  console.log("PASS: partial proration + balance + LeaveDay + ledger all consistent.\n");

  // ── Case 2: deliberate unpaid choice, balance untouched ──────────────────
  const wednesday = addDays(tuesday, 1);
  const leave2 = await prisma.leave.create({
    data: {
      userId: employee.id, approverId: admin.id, policyId: policy.id, leaveType: policy.id,
      startDate: `${isoDate(wednesday)}T12:00:00.000Z`, endDate: `${isoDate(wednesday)}T12:00:00.000Z`,
      status: "pending", isPaid: false,
    },
  });

  console.log("--- Case 2: Deliberate unpaid request (4h balance remains untouched) ---");
  const preview2 = await previewLeaveApproval(leave2, policy);
  console.log("Preview:", JSON.stringify(preview2));

  const result2 = await applyLeaveApproval(leave2, policy, admin.id, "verify case 2");
  console.log("Apply result:", result2);

  const bal2  = await prisma.leaveBalance.findUnique({ where: { userId_policyId: { userId: employee.id, policyId: policy.id } } });
  const days2 = await prisma.leaveDay.findMany({ where: { leaveId: leave2.id } });
  const txns2 = await prisma.leaveTransaction.findMany({ where: { leaveId: leave2.id } });

  assert(Number(bal2.balanceHours) === 4, `Expected balance still 4h, got ${bal2.balanceHours}`);
  assert(days2.length === 1 && days2[0].isPaid === false, "Expected exactly 1 unpaid LeaveDay row");
  assert(txns2.length === 0, "Expected zero ledger transactions for a deliberate-unpaid leave");
  console.log("PASS: deliberate unpaid choice left balance untouched, no ledger entry.\n");

  // ── Case 3: concurrency guard — two simultaneous claims, only one wins ───
  const thursday = addDays(wednesday, 1);
  const leave3 = await prisma.leave.create({
    data: {
      userId: employee.id, approverId: admin.id, policyId: policy.id, leaveType: policy.id,
      startDate: `${isoDate(thursday)}T12:00:00.000Z`, endDate: `${isoDate(thursday)}T12:00:00.000Z`,
      status: "pending", isPaid: false,
    },
  });

  console.log("--- Case 3: Concurrent-claim guard (simulated double-click) ---");
  const [claimA, claimB] = await Promise.all([
    prisma.leave.updateMany({ where: { id: leave3.id, status: "pending" }, data: { status: "approved" } }),
    prisma.leave.updateMany({ where: { id: leave3.id, status: "pending" }, data: { status: "approved" } }),
  ]);
  const totalClaims = claimA.count + claimB.count;
  assert(totalClaims === 1, `Expected exactly 1 of 2 simultaneous claims to succeed, got ${totalClaims}`);
  console.log("PASS: only one of two simultaneous claims succeeded.\n");

  console.log("=== All Phase 4 checks passed ===");
}

async function cleanup() {
  console.log("\nCleaning up throwaway test data...");
  await prisma.company.delete({ where: { name: TAG } }).catch((e) =>
    console.error("Cleanup warning (may need manual removal):", e.message)
  );
  console.log("Cleanup done.");
}

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error("\n❌ VERIFICATION FAILED:", err.message);
    await cleanup();
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
