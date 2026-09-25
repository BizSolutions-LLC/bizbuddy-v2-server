// scripts/delete-sunshine-payroll-run-2026-08-27-to-09-09.js
//
// Test helper: delete the locked Payroll → Reports run for Sunshine Learning
// 2026-08-27 – 2026-09-09 so Employee Sheet can Save that period again.
//
// Does NOT touch CutoffPeriod, PayrollExport, or PayrollExportBatch.
// PayrollEntry / PayrollLine rows cascade off PayrollRun.
//
// DRY_RUN=true  (default) → prints matching runs, deletes nothing
// DRY_RUN=false → deletes matching PayrollRun rows
//
// Optional env:
//   COMPANY_ID      skip name lookup
//   PERIOD_START    default 2026-08-27
//   PERIOD_END      default 2026-09-09
//
// Usage:
//   node scripts/delete-sunshine-payroll-run-2026-08-27-to-09-09.js
//   DRY_RUN=false node scripts/delete-sunshine-payroll-run-2026-08-27-to-09-09.js

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== "false";

const PERIOD_START = process.env.PERIOD_START || "2026-08-27";
const PERIOD_END = process.env.PERIOD_END || "2026-09-09";

function dateKey(d) {
  return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}

function isSunshineLearning(name) {
  return /sunshine\s+learning/i.test(String(name || ""));
}

async function resolveCompany() {
  if (process.env.COMPANY_ID) {
    const company = await prisma.company.findUnique({
      where: { id: process.env.COMPANY_ID },
      select: { id: true, name: true },
    });
    if (!company) {
      console.log(`Company ${process.env.COMPANY_ID} not found.`);
      return null;
    }
    if (!isSunshineLearning(company.name)) {
      console.log(
        `Refusing COMPANY_ID=${company.id} (${company.name}) — this script only deletes Sunshine Learning payroll runs.`
      );
      return null;
    }
    return company;
  }

  const matches = await prisma.company.findMany({
    where: { name: { contains: "Sunshine Learning", mode: "insensitive" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const sunshine = matches.filter((c) => isSunshineLearning(c.name));

  if (sunshine.length === 0) {
    console.log('No company named "Sunshine Learning". Aborting.');
    return null;
  }

  if (sunshine.length > 1) {
    console.log('Multiple companies named "Sunshine Learning". Re-run with COMPANY_ID=...');
    for (const c of sunshine) {
      console.log(`  ${c.id}  ${c.name}`);
    }
    return null;
  }

  return sunshine[0];
}

async function main() {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Delete payroll report — Sunshine Learning  [DRY_RUN=${DRY_RUN}]`);
  console.log(`${"=".repeat(70)}\n`);

  const company = await resolveCompany();
  if (!company) return;

  console.log(`Company: ${company.name} (${company.id})`);
  console.log(`Period date keys: ${PERIOD_START} → ${PERIOD_END}\n`);

  const runs = await prisma.payrollRun.findMany({
    where: { companyId: company.id },
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      payDate: true,
      status: true,
      locked: true,
      totalGross: true,
      totalNet: true,
      savedAt: true,
      payrollSnapshot: true,
      _count: { select: { entries: true } },
    },
    orderBy: { savedAt: "desc" },
  });

  const matches = runs.filter(
    (run) => dateKey(run.periodStart) === PERIOD_START && dateKey(run.periodEnd) === PERIOD_END
  );

  if (matches.length === 0) {
    console.log("No PayrollRun for this company and period. Nothing to delete.");
    console.log("You can Save from Employee Sheet if the period is unlocked.\n");
    return;
  }

  console.log(`Matching payroll run(s): ${matches.length}`);
  for (const run of matches) {
    const employeeCount = run.payrollSnapshot?.employees?.length || 0;
    console.log(
      `  ${run.id}  locked=${run.locked}  status=${run.status}  employees=${employeeCount}` +
        `  entries=${run._count.entries}` +
        `  gross=${run.totalGross}  net=${run.totalNet}` +
        `  savedAt=${run.savedAt ? run.savedAt.toISOString() : "n/a"}`
    );
  }

  if (DRY_RUN) {
    console.log("\nDry run — nothing deleted. Re-run with DRY_RUN=false to apply.\n");
    return;
  }

  const ids = matches.map((run) => run.id);
  const deleted = await prisma.payrollRun.deleteMany({
    where: { id: { in: ids }, companyId: company.id },
  });

  console.log(
    `\nDeleted ${deleted.count} PayrollRun row(s). Cutoff + hours export were left in place.`
  );
  console.log(
    "In the app: Payroll → Employee Sheet → select 8/27–9/9 → Load Hours → Compute → Save.\n"
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
