// scripts/check-cutoff-backtrack-safe-delete.js
//
// Follow-up to check-cutoff-backtrack-anchor-mismatch.js. For each Driver/Aide
// CutoffPeriod row whose periodStart doesn't align with the configured
// bi-weekly anchor (DepartmentCutoffSettings.startDate) — i.e. the periods
// created by today's mis-anchored "backtrack" run — this checks whether any
// REAL data exists against that period before it's considered for deletion:
//
//   1. TimeLogApproval rows directly linked via cutoffPeriodId.
//   2. Raw TimeLog punches (by department employees) whose timeIn falls
//      inside the period's date range, even if never linked to an approval.
//
// A period is only flagged SAFE TO DELETE if both counts are zero. Anything
// else is flagged DO NOT DELETE - HAS DATA for manual review.
//
// READ-ONLY — no writes, no deletes.
//
// Usage:
//   node scripts/check-cutoff-backtrack-safe-delete.js [departmentId-or-name]

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DEFAULT_DEPARTMENT_NAME = "Driver/Aide";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const arg = process.argv[2] || null;

  const settings = await prisma.departmentCutoffSettings.findFirst({
    where: arg
      ? { OR: [{ departmentId: arg }, { department: { name: arg } }] }
      : { department: { name: DEFAULT_DEPARTMENT_NAME } },
    include: { department: true },
  });

  if (!settings) {
    console.log(
      arg
        ? `No DepartmentCutoffSettings found for departmentId or name="${arg}"`
        : `No DepartmentCutoffSettings found for department name="${DEFAULT_DEPARTMENT_NAME}"`
    );
    return;
  }

  const anchor = new Date(settings.startDate);
  anchor.setUTCHours(0, 0, 0, 0);

  const cadenceDays = settings.frequency === "bi-weekly" ? 14 : null;
  if (!cadenceDays) {
    console.log(`Frequency "${settings.frequency}" is not bi-weekly — this script only handles bi-weekly cadence.`);
    return;
  }

  console.log(`=== Department: ${settings.department?.name || "(unknown)"} (${settings.departmentId}) ===`);
  console.log(`Company: ${settings.companyId}`);
  console.log(`Configured anchor (startDate, UTC): ${fmt(anchor)}\n`);

  const periods = await prisma.cutoffPeriod.findMany({
    where: { companyId: settings.companyId, departmentId: settings.departmentId },
    orderBy: { periodStart: "asc" },
    select: { id: true, periodStart: true, periodEnd: true, status: true, createdAt: true },
  });

  const mismatched = periods.filter((p) => {
    const start = new Date(p.periodStart);
    start.setUTCHours(0, 0, 0, 0);
    const daysSinceAnchor = Math.round((start - anchor) / MS_PER_DAY);
    return !(daysSinceAnchor >= 0 && daysSinceAnchor % cadenceDays === 0);
  });

  console.log(`=== ${mismatched.length} mis-anchored period(s) found — checking for real data ===\n`);

  let safeCount = 0;
  let blockedCount = 0;

  for (const p of mismatched) {
    const approvalCount = await prisma.timeLogApproval.count({
      where: { cutoffPeriodId: p.id },
    });

    const rangeEnd = new Date(p.periodEnd);
    rangeEnd.setUTCHours(23, 59, 59, 999);

    const timeLogCount = await prisma.timeLog.count({
      where: {
        user: { departmentId: settings.departmentId, companyId: settings.companyId },
        timeIn: { gte: p.periodStart, lte: rangeEnd },
      },
    });

    const hasData = approvalCount > 0 || timeLogCount > 0;
    if (hasData) blockedCount++;
    else safeCount++;

    console.log(
      `${p.id} | ${fmt(p.periodStart)} -> ${fmt(p.periodEnd)} | status=${p.status} | ` +
        `createdAt=${p.createdAt.toISOString()} | TimeLogApproval=${approvalCount} | TimeLog(raw)=${timeLogCount} | ` +
        `${hasData ? "DO NOT DELETE - HAS DATA" : "SAFE TO DELETE (empty)"}`
    );
  }

  console.log(`\n=== Summary: ${safeCount} safe to delete, ${blockedCount} blocked (has data, needs manual review) ===`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
