// scripts/check-leave-balance-johna.js
// Diagnostic: inspect Galamiton, Johna Rey's sick leave balance, transactions, and leave requests.

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  // ── 1. Find the user ────────────────────────────────────────────────────────
  const user = await prisma.user.findFirst({
    where: {
      profile: {
        OR: [
          { firstName: { contains: "Johna", mode: "insensitive" } },
          { lastName:  { contains: "Galamiton", mode: "insensitive" } },
        ],
      },
    },
    include: {
      profile: true,
    },
  });

  if (!user) {
    console.log("❌ User not found.");
    return;
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log(`User    : ${user.profile?.firstName} ${user.profile?.lastName}`);
  console.log(`ID      : ${user.id}`);
  console.log(`Company : ${user.companyId}`);
  console.log(`Status  : ${user.status}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // ── 2. All leave balances ───────────────────────────────────────────────────
  const balances = await prisma.leaveBalance.findMany({
    where: { userId: user.id },
    include: { policy: true },
    orderBy: { policy: { leaveType: "asc" } },
  });

  console.log("── Leave Balances ──────────────────────────────────────");
  if (balances.length === 0) {
    console.log("  (none)");
  } else {
    for (const b of balances) {
      console.log(`  ${b.policy.leaveType.padEnd(20)} ${parseFloat(b.balanceHours).toFixed(2).padStart(8)} h`
        + `   (policy: ${b.policyId}, annual: ${b.policy.annualAllocation}h, accrual: ${b.policy.accrualFrequency})`);
    }
  }

  // ── 3. Leave transactions for sick leave ────────────────────────────────────
  const sickPolicy = balances.find(b =>
    b.policy.leaveType.toLowerCase().includes("sick")
  );

  if (sickPolicy) {
    console.log(`\n── Sick Leave Transactions (policy: ${sickPolicy.policyId}) ───`);
    const txns = await prisma.leaveTransaction.findMany({
      where:   { userId: user.id, policyId: sickPolicy.policyId },
      orderBy: { createdAt: "asc" },
    });

    if (txns.length === 0) {
      console.log("  (no transactions)");
    } else {
      for (const t of txns) {
        const sign = t.type === "deduction" ? "-" : "+";
        console.log(
          `  ${t.createdAt.toISOString().slice(0, 10)}  ${t.type.padEnd(12)}`
          + `  ${sign}${parseFloat(t.hours).toFixed(2).padStart(7)} h`
          + `  before: ${parseFloat(t.balanceBefore).toFixed(2).padStart(7)} h`
          + `  after: ${parseFloat(t.balanceAfter).toFixed(2).padStart(7)} h`
          + (t.note ? `  note: ${t.note}` : "")
          + (t.leaveId ? `  leaveId: ${t.leaveId}` : "")
        );
      }
    }
    console.log(`\n  Current balance: ${parseFloat(sickPolicy.balanceHours).toFixed(2)} h`);
    console.log(`  Expected from txns: ${txns.reduce((s, t) => {
      return t.type === "deduction" ? s - parseFloat(t.hours) : s + parseFloat(t.hours);
    }, 0).toFixed(2)} h`);
  }

  // ── 4. All leave requests for this user ────────────────────────────────────
  console.log("\n── Leave Requests (all) ────────────────────────────────");
  const leaves = await prisma.leave.findMany({
    where:   { userId: user.id },
    orderBy: { startDate: "desc" },
    take:    20,
  });

  if (leaves.length === 0) {
    console.log("  (none)");
  } else {
    for (const l of leaves) {
      const start = l.startDate.toISOString().slice(0, 10);
      const end   = l.endDate.toISOString().slice(0, 10);
      console.log(
        `  ${start} → ${end}  ${l.leaveType.padEnd(20)}  ${l.status.padEnd(10)}`
        + `  paid: ${l.isPaid}  id: ${l.id}`
      );
    }
  }

  // ── 5. Sick leave requests specifically ────────────────────────────────────
  console.log("\n── Sick Leave Requests only ────────────────────────────");
  const sickLeaves = leaves.filter(l =>
    l.leaveType.toLowerCase().includes("sick") ||
    (sickPolicy && l.leaveType === sickPolicy.policyId)
  );

  if (sickLeaves.length === 0) {
    console.log("  (none matching sick leave)");
  } else {
    for (const l of sickLeaves) {
      const start = l.startDate.toISOString().slice(0, 10);
      const end   = l.endDate.toISOString().slice(0, 10);
      const days  = Math.round((new Date(l.endDate) - new Date(l.startDate)) / 86400000) + 1;
      console.log(
        `  ${start} → ${end}  (${days} day${days !== 1 ? "s" : ""})  status: ${l.status}`
        + `  paid: ${l.isPaid}  id: ${l.id}`
      );
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
