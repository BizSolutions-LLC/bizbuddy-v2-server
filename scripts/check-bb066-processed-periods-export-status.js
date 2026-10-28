// scripts/check-bb066-processed-periods-export-status.js
//
// BB-066 — For every CutoffPeriod already marked "processed", checks whether
// a PayrollExportBatch row exists for its (companyId, periodStart, periodEnd)
// and whether this department's own PayrollExport rows exist. Generation
// only ever fires as a side effect of the status transition TO "processed"
// (see cutoffPeriodController.js updateCutoffStatus) — a period that was
// already "processed" before BB-066 shipped, or whose export silently failed
// (the trigger swallows errors), would show up here as MISSING.
//
// READ-ONLY — no writes.
//
// Usage: node scripts/check-bb066-processed-periods-export-status.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const processedPeriods = await prisma.cutoffPeriod.findMany({
    where: { status: "processed" },
    select: {
      id: true,
      companyId: true,
      departmentId: true,
      periodStart: true,
      periodEnd: true,
      updatedAt: true,
      company: { select: { name: true } },
      department: { select: { name: true } },
    },
    orderBy: [{ companyId: "asc" }, { periodStart: "asc" }],
  });

  console.log(`=== ${processedPeriods.length} CutoffPeriod row(s) with status="processed" ===\n`);

  let missingCount = 0;

  for (const p of processedPeriods) {
    const start = p.periodStart.toISOString().slice(0, 10);
    const end = p.periodEnd.toISOString().slice(0, 10);

    const [batch] = await prisma.$queryRaw`
      SELECT "employeeCount", "generatedAt" FROM "PayrollExportBatch"
      WHERE "companyId" = ${p.companyId} AND "periodStart" = ${start}::date AND "periodEnd" = ${end}::date
    `;
    const [deptRows] = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM "PayrollExport"
      WHERE "companyId" = ${p.companyId} AND "periodStart" = ${start}::date AND "periodEnd" = ${end}::date
        AND "departmentId" IS NOT DISTINCT FROM ${p.departmentId}
    `;

    const label = `${p.company?.name || p.companyId} / ${p.department?.name || "(company-wide)"} — ${start}..${end}`;
    console.log(`--- ${p.id} — ${label} ---`);
    console.log(`  processed at (CutoffPeriod.updatedAt): ${p.updatedAt.toISOString()}`);
    if (batch) {
      console.log(`  PayrollExportBatch: EXISTS — employeeCount=${batch.employeeCount}, generatedAt=${batch.generatedAt.toISOString()}`);
    } else {
      console.log(`  PayrollExportBatch: MISSING`);
      missingCount++;
    }
    console.log(`  PayrollExport rows for this department/period: ${deptRows.n}`);
    console.log("");
  }

  console.log(`Summary: ${processedPeriods.length - missingCount}/${processedPeriods.length} processed periods have a PayrollExportBatch row; ${missingCount} missing.`);
  console.log("No changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
