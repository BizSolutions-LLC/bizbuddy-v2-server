// scripts/fix-payment-date-jun24-cutoff-period.js
// Fix: for company cmnegwuxm0004rf7fzo6wjrw2, the Jun 24 - Jul 7, 2026 cutoff
// period showed paymentDate = Jul 12 for Staff and Staff Supervisor instead of
// Jul 10. Root cause (confirmed via scripts/check-payment-date-jun24-cutoff.js):
//   - Staff Supervisor's DepartmentCutoffSettings.paymentOffsetDays was still 5
//     (Driver/Aide and Staff were already updated to 3, Staff Supervisor was not).
//   - Staff's CutoffPeriod row was generated before its setting was changed to 3
//     and never recalculated, so it was stuck at the old 5-day (Jul 12) value.
// This script:
//   1. Sets Staff Supervisor's paymentOffsetDays 5 -> 3.
//   2. Sets paymentDate = 2026-07-10 on the three Jun24-Jul7 CutoffPeriod rows
//      (Driver/Aide is already correct and is skipped as a no-op).
// Scope: ONLY these three departments' settings and these three CutoffPeriod
// rows. No other periods are touched.
//
// Usage:
//   node scripts/fix-payment-date-jun24-cutoff-period.js            (dry run)
//   node scripts/fix-payment-date-jun24-cutoff-period.js --apply    (commit)

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2";
const DRY_RUN = !process.argv.includes("--apply");

const SETTINGS_FIX = {
  departmentId: "cmnfnklgt04sdnr4u153i8a0z", // Staff Supervisor
  expectedCurrent: 5,
  newValue: 3,
};

const CUTOFF_PERIOD_FIXES = [
  { id: "cmp7p84rw05u1u44vp5xbuth3", label: "Driver/Aide" },
  { id: "cmp7p84jp05tru44vl93dobzm", label: "Staff" },
  { id: "cmp7p84o805twu44vbx9ubgxe", label: "Staff Supervisor" },
];
const NEW_PAYMENT_DATE = new Date("2026-07-10T00:00:00.000Z");

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(DRY_RUN ? "🔍 DRY RUN — pass --apply to commit changes" : "✏️  APPLYING changes");
  console.log("═══════════════════════════════════════════════════════\n");

  // 1. DepartmentCutoffSettings fix (Staff Supervisor: 5 -> 3)
  const settings = await prisma.departmentCutoffSettings.findUnique({
    where: { companyId_departmentId: { companyId: COMPANY_ID, departmentId: SETTINGS_FIX.departmentId } },
    include: { department: { select: { name: true } } },
  });

  if (!settings) {
    console.log("❌ Staff Supervisor DepartmentCutoffSettings row not found. Aborting.");
    return;
  }

  console.log(`Settings: ${settings.department?.name} paymentOffsetDays = ${settings.paymentOffsetDays}`);
  if (settings.paymentOffsetDays !== SETTINGS_FIX.expectedCurrent) {
    console.log(
      `⚠️  Expected current paymentOffsetDays to be ${SETTINGS_FIX.expectedCurrent}, got ${settings.paymentOffsetDays}. Skipping settings update (already changed or different than expected).`
    );
  } else {
    console.log(`  -> will update to ${SETTINGS_FIX.newValue}`);
    if (!DRY_RUN) {
      await prisma.departmentCutoffSettings.update({
        where: { id: settings.id },
        data: { paymentOffsetDays: SETTINGS_FIX.newValue },
      });
      console.log("  ✅ updated");
    }
  }

  // 2. CutoffPeriod.paymentDate fixes
  console.log("\nCutoffPeriod rows:");
  for (const fix of CUTOFF_PERIOD_FIXES) {
    const period = await prisma.cutoffPeriod.findUnique({ where: { id: fix.id } });
    if (!period) {
      console.log(`  ❌ ${fix.label} (${fix.id}) not found. Skipping.`);
      continue;
    }
    const current = period.paymentDate.toISOString().slice(0, 10);
    console.log(`  ${fix.label} (${fix.id}): paymentDate = ${current}`);

    if (current === "2026-07-10") {
      console.log("    -> already correct, no-op");
      continue;
    }

    console.log("    -> will update to 2026-07-10");
    if (!DRY_RUN) {
      await prisma.cutoffPeriod.update({
        where: { id: fix.id },
        data: { paymentDate: NEW_PAYMENT_DATE },
      });
      console.log("    ✅ updated");
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(DRY_RUN ? "Dry run complete — no changes written. Re-run with --apply to commit." : "✅ Done.");
  console.log("═══════════════════════════════════════════════════════");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
