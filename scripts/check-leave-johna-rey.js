// scripts/check-leave-johna-rey.js
// Diagnostic: verify Galamiton, Johna Rey's sick leave for Jun 10-11 (2026).
// Checks: leave requests, leave balances, leave transactions, cutoff punches.

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
    include: { profile: true },
  });

  if (!user) {
    console.log("❌ User not found.");
    return;
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log(`User    : ${user.profile?.firstName} ${user.profile?.lastName}`);
  console.log(`ID      : ${user.id}`);
  console.log(`Company : ${user.companyId}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // ── 2. All leave balances ───────────────────────────────────────────────────
  const balances = await prisma.leaveBalance.findMany({
    where:   { userId: user.id },
    include: { policy: true },
    orderBy: { policy: { leaveType: "asc" } },
  });

  console.log("── Leave Balances ──────────────────────────────────────");
  if (balances.length === 0) {
    console.log("  (none)");
  } else {
    for (const b of balances) {
      console.log(
        `  ${b.policy.leaveType.padEnd(25)} ${parseFloat(b.balanceHours).toFixed(2).padStart(8)} h`
        + `   annual: ${b.policy.annualAllocation}h | accrual: ${b.policy.accrualFrequency}`
      );
    }
  }

  // ── 3. All leave requests ───────────────────────────────────────────────────
  console.log("\n── Leave Requests (all) ────────────────────────────────");
  const leaves = await prisma.leave.findMany({
    where:   { userId: user.id },
    orderBy: { startDate: "desc" },
  });

  if (leaves.length === 0) {
    console.log("  (none)");
  } else {
    for (const l of leaves) {
      const start = new Date(l.startDate).toISOString().slice(0, 10);
      const end   = new Date(l.endDate).toISOString().slice(0, 10);
      console.log(
        `  ${start} → ${end}  ${l.leaveType.padEnd(25)}  ${l.status.padEnd(10)}`
        + `  paid: ${l.isPaid}  id: ${l.id}`
      );
    }
  }

  // ── 4. Leave transactions (all policies) ────────────────────────────────────
  console.log("\n── Leave Transactions (all) ────────────────────────────");
  const txns = await prisma.leaveTransaction.findMany({
    where:   { userId: user.id },
    include: { policy: true },
    orderBy: { createdAt: "asc" },
  });

  if (txns.length === 0) {
    console.log("  (none)");
  } else {
    for (const t of txns) {
      const sign = t.type === "deduction" ? "-" : "+";
      console.log(
        `  ${new Date(t.createdAt).toISOString().slice(0, 10)}  ${t.policy.leaveType.padEnd(20)}`
        + `  ${t.type.padEnd(12)}`
        + `  ${sign}${parseFloat(t.hours).toFixed(2).padStart(7)} h`
        + `  before: ${parseFloat(t.balanceBefore).toFixed(2).padStart(7)} h`
        + `  after:  ${parseFloat(t.balanceAfter).toFixed(2).padStart(7)} h`
        + (t.note    ? `  note: ${t.note}` : "")
        + (t.leaveId ? `  leaveId: ${t.leaveId}` : "")
      );
    }
  }

  // ── 5. TimeLogs & approvals for Jun 10-11 2026 ─────────────────────────────
  console.log("\n── TimeLogs for Jun 10–11 2026 (absent days) ──────────");
  const jun10Start = new Date("2026-06-10T00:00:00.000Z");
  const jun11End   = new Date("2026-06-12T00:00:00.000Z");

  const timeLogs = await prisma.timeLog.findMany({
    where: {
      userId: user.id,
      timeIn: { gte: jun10Start, lt: jun11End },
    },
    include: {
      approvals: {
        select: { status: true, actualHours: true, segmentType: true, cutoffPeriodId: true },
      },
    },
  });

  if (timeLogs.length === 0) {
    console.log("  No time logs on Jun 10–11 — employee was absent those days.");
  } else {
    for (const tl of timeLogs) {
      console.log(`  TimeLog ${tl.id} | timeIn: ${tl.timeIn?.toISOString()} | punchType: ${tl.punchType}`);
      for (const a of tl.approvals) {
        console.log(`    approval: status=${a.status} actualHours=${a.actualHours} segment=${a.segmentType}`);
      }
    }
  }

  // ── 6. Summary ─────────────────────────────────────────────────────────────
  console.log("\n── Summary ─────────────────────────────────────────────");
  const sickBalance = balances.find(b => b.policy.leaveType.toLowerCase().includes("sick"));
  const approvedLeaves = leaves.filter(l => l.status === "approved");
  const sickLeaves = leaves.filter(l =>
    l.leaveType.toLowerCase().includes("sick") && l.status === "approved"
  );

  console.log(`  Total leave requests : ${leaves.length}`);
  console.log(`  Approved leaves      : ${approvedLeaves.length}`);
  console.log(`  Approved sick leaves : ${sickLeaves.length}`);
  if (sickBalance) {
    console.log(`  Current sick balance : ${parseFloat(sickBalance.balanceHours).toFixed(2)} h`);
    console.log(`  Expected from sheet  : 16.00 h deducted (2 absent days × 8h)`);
  } else {
    console.log(`  ⚠️  No sick leave policy/balance found for this user.`);
  }

  console.log("\n═══════════════════════════════════════════════════════");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
