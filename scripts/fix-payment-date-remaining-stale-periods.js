// scripts/fix-payment-date-remaining-stale-periods.js
// Fix: 8 remaining stale CutoffPeriod.paymentDate rows for company
// cmnegwuxm0004rf7fzo6wjrw2 (Staff + Staff Supervisor), found via
// scripts/check-all-payment-date-mismatches.js. Same root cause as
// scripts/fix-payment-date-jun24-cutoff-period.js: paymentDate was captured
// under the old 5-day offset before both departments' settings were updated
// to 3 days, and never recalculated. All rows are status=open (unprocessed).
// Settings are already correct (paymentOffsetDays=3) — this script only
// touches CutoffPeriod.paymentDate, no settings changes.
//
// Usage:
//   node scripts/fix-payment-date-remaining-stale-periods.js            (dry run)
//   node scripts/fix-payment-date-remaining-stale-periods.js --apply    (commit)

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DRY_RUN = !process.argv.includes("--apply");

const FIXES = [
  { id: "cmp7p84jp05tou44v7j5vmkg6", label: "Staff 2026-05-13..2026-05-26", expectedCurrent: "2026-05-31", newDate: "2026-05-29" },
  { id: "cmp7p84jp05tpu44v46nyz5bh", label: "Staff 2026-05-27..2026-06-09", expectedCurrent: "2026-06-14", newDate: "2026-06-12" },
  { id: "cmp7p84jp05tqu44ve1rv5323", label: "Staff 2026-06-10..2026-06-23", expectedCurrent: "2026-06-28", newDate: "2026-06-26" },
  { id: "cmp7p84jp05tsu44v1cvltfyt", label: "Staff 2026-07-08..2026-07-21", expectedCurrent: "2026-07-26", newDate: "2026-07-24" },
  { id: "cmp7p84o805ttu44vjb2x4oc2", label: "Staff Supervisor 2026-05-13..2026-05-26", expectedCurrent: "2026-05-31", newDate: "2026-05-29" },
  { id: "cmp7p84o805tuu44vyo0ubulr", label: "Staff Supervisor 2026-05-27..2026-06-09", expectedCurrent: "2026-06-14", newDate: "2026-06-12" },
  { id: "cmp7p84o805tvu44vnx9behbl", label: "Staff Supervisor 2026-06-10..2026-06-23", expectedCurrent: "2026-06-28", newDate: "2026-06-26" },
  { id: "cmp7p84o805txu44vy904ls4m", label: "Staff Supervisor 2026-07-08..2026-07-21", expectedCurrent: "2026-07-26", newDate: "2026-07-24" },
];

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(DRY_RUN ? "🔍 DRY RUN — pass --apply to commit changes" : "✏️  APPLYING changes");
  console.log("═══════════════════════════════════════════════════════\n");

  for (const fix of FIXES) {
    const period = await prisma.cutoffPeriod.findUnique({ where: { id: fix.id } });
    if (!period) {
      console.log(`❌ ${fix.label} (${fix.id}) not found. Skipping.`);
      continue;
    }

    const current = period.paymentDate.toISOString().slice(0, 10);
    console.log(`${fix.label} (${fix.id}): status=${period.status} paymentDate=${current}`);

    if (current !== fix.expectedCurrent) {
      console.log(`  ⚠️  Expected current to be ${fix.expectedCurrent}, got ${current}. Skipping to avoid overwriting unexpected data.`);
      continue;
    }

    console.log(`  -> will update to ${fix.newDate}`);
    if (!DRY_RUN) {
      await prisma.cutoffPeriod.update({
        where: { id: fix.id },
        data: { paymentDate: new Date(`${fix.newDate}T00:00:00.000Z`) },
      });
      console.log("  ✅ updated");
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(DRY_RUN ? "Dry run complete — no changes written. Re-run with --apply to commit." : "✅ Done.");
  console.log("═══════════════════════════════════════════════════════");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
