// scripts/delete-cutoff-no-department-jan2026.js
//
// Deletes the now-empty "No Department" CutoffPeriod for Jan 7-20, 2026,
// created by the BB-086 backtrack-import bug. All of its TimeLogApproval
// rows were already moved to the correct department periods by
// fix-cutoff-no-department-jan2026.js and fix-cutoff-no-department-jan2026-round2.js
// (confirmed empty in the admin UI: 0 approved / 0 pending / 0 excluded).
//
// Re-verifies immediately before deleting that:
//   - the period still has departmentId: null and the expected Jan 7-20 dates
//   - it has zero TimeLogApproval rows attached
//   - its status isn't "processed" (mirrors the guard in the existing
//     DELETE /api/cutoff-periods/:id endpoint)
// Aborts without deleting if any check fails.
//
// Usage:
//   node scripts/delete-cutoff-no-department-jan2026.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TARGET_PERIOD_START = "2026-01-07";
const TARGET_PERIOD_END = "2026-01-20";

async function main() {
  const periods = await prisma.cutoffPeriod.findMany({
    where: {
      departmentId: null,
      periodStart: new Date(`${TARGET_PERIOD_START}T00:00:00.000Z`),
      periodEnd: new Date(`${TARGET_PERIOD_END}T00:00:00.000Z`),
    },
  });

  if (periods.length === 0) {
    console.log("No matching 'No Department' CutoffPeriod found. Nothing to delete.");
    return;
  }

  for (const period of periods) {
    console.log(`\nChecking CutoffPeriod ${period.id} (status=${period.status})...`);

    if (period.status === "processed") {
      console.log(`SKIPPED — period is "processed", will not delete.`);
      continue;
    }

    const approvalCount = await prisma.timeLogApproval.count({
      where: { cutoffPeriodId: period.id },
    });

    if (approvalCount > 0) {
      console.log(`SKIPPED — period still has ${approvalCount} TimeLogApproval row(s) attached, will not delete.`);
      continue;
    }

    await prisma.cutoffPeriod.delete({ where: { id: period.id } });
    console.log(`DELETED — CutoffPeriod ${period.id} removed.`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
