// scripts/fix-bb066-backfill-piedmont-jul8-jul21-export.js
//
// BB-066 — Backfill for Piedmont Adult Day Program's 2026-07-08..2026-07-21
// cutoff period, same pattern as
// fix-bb066-backfill-piedmont-jul22-aug4-export.js. All 3 departments
// (Driver/Aide, Staff Supervisor, Staff) were marked "processed" on
// 2026-08-07 with real approved TimeLogApproval/CutoffOtBlock/LeaveDay data,
// but ended up with 0 PayrollExport rows / no PayrollExportBatch. Driver/Aide
// was processed before commit b1da582 (2026-08-07 02:53:18Z) added the
// generation trigger, so that one's explained; Staff Supervisor and Staff
// were processed ~23min AFTER that commit and still got nothing — cause
// unconfirmed (deploy lag vs a swallowed runtime error), but since this same
// generatePayrollExportForCutoffPeriod() already ran successfully for all 3
// of these departments on the Jul 22-Aug 4 period, re-running it here is low
// risk regardless of which explanation is correct.
//
// SCOPE, by construction — cannot touch any other company or period:
//   - Only CutoffPeriod rows where companyId belongs to "Piedmont Adult Day
//     Program" AND periodStart=2026-07-08 AND periodEnd=2026-07-21 AND
//     status="processed" are looked up.
//   - generatePayrollExportForCutoffPeriod's own DELETE/INSERT queries are
//     scoped to that exact companyId+periodStart+periodEnd+departmentId —
//     it is structurally incapable of writing outside that combination.
//
// SAFETY: aborts without writing anything if the company name doesn't match
// exactly, or if the number of matching "processed" periods isn't exactly 3
// (the known/expected set).
//
// This is a WRITE. Re-running it is safe/idempotent per department (each
// department's PayrollExport rows are deleted and reinserted fresh).
//
// Usage: node scripts/fix-bb066-backfill-piedmont-jul8-jul21-export.js

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const { generatePayrollExportForCutoffPeriod } = require("@services/Payroll/payrollExportService");
const prisma = new PrismaClient();

const EXPECTED_COMPANY_NAME = "Piedmont Adult Day Program";
const PERIOD_START = "2026-07-08";
const PERIOD_END = "2026-07-21";

async function main() {
  const periods = await prisma.cutoffPeriod.findMany({
    where: {
      status: "processed",
      periodStart: new Date(`${PERIOD_START}T00:00:00.000Z`),
      periodEnd: new Date(`${PERIOD_END}T00:00:00.000Z`),
      company: { name: EXPECTED_COMPANY_NAME },
    },
    include: {
      company: { select: { name: true } },
      department: { select: { name: true } },
    },
  });

  if (periods.length !== 3) {
    console.log(
      `Expected exactly 3 "processed" CutoffPeriod rows for "${EXPECTED_COMPANY_NAME}" ${PERIOD_START}..${PERIOD_END} ` +
        `(Driver/Aide, Staff Supervisor, Staff), found ${periods.length}. Refusing to run — reality no longer matches ` +
        `what this script assumes; investigate before backfilling.`
    );
    for (const p of periods) {
      console.log(`  found: id=${p.id} department=${p.department?.name || "(company-wide)"} status=${p.status}`);
    }
    return;
  }

  console.log(`=== Backfilling payroll export for ${EXPECTED_COMPANY_NAME}, ${PERIOD_START}..${PERIOD_END} ===`);
  console.log(`Found ${periods.length} matching department periods:`);
  for (const p of periods) {
    console.log(`  id=${p.id} department=${p.department?.name || "(company-wide)"}`);
  }
  console.log("");

  for (const p of periods) {
    const label = p.department?.name || "(company-wide)";
    console.log(`--- Generating for "${label}" (cutoffPeriodId=${p.id}) ---`);
    try {
      const result = await generatePayrollExportForCutoffPeriod(p);
      console.log(`  OK — employeeCount=${result.employeeCount}`);
    } catch (err) {
      console.error(`  FAILED for "${label}":`, err.message);
    }
  }

  // Verify final state.
  const [batch] = await prisma.$queryRaw`
    SELECT "employeeCount", "generatedAt", "payload" FROM "PayrollExportBatch"
    WHERE "companyId" = ${periods[0].companyId}
      AND "periodStart" = ${PERIOD_START}::date
      AND "periodEnd" = ${PERIOD_END}::date
  `;

  console.log("\n=== Final PayrollExportBatch state ===");
  if (batch) {
    console.log(`  employeeCount=${batch.employeeCount}  generatedAt=${batch.generatedAt.toISOString()}`);
    console.log(`  payload.employees count=${batch.payload.employees?.length ?? "?"}`);
  } else {
    console.log("  MISSING — something went wrong, none of the department generations produced a batch row.");
  }

  console.log("\nDone.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
