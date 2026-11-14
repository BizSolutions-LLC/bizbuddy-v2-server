// scripts/fix-bb125-ledger-note-wording.js
//
// BB-125 — wording fix only. Elizabeth Pabilona's 8-07 leave revert was applied
// with an older version of fix-bb125-elizabeth-aug07-revert-leave.js, whose
// ledger tag read "(BB-125 damage control)". An earlier run of this script may
// already have changed it to "(BB-125 audit report)". This rewrites either to
// "(BB-125 audit correction)" on the matching LeaveTransaction notes.
//
// Scope: every LeaveTransaction whose note contains "damage control" or
// "BB-125 audit report" (expected:
// the 2 rows on leave cmsjc2mkq0dmeti506qackmir, created 2026-11-14). Only the
// note text changes — hours, balances, types and dates are untouched.
//
// Usage:
//   node scripts/fix-bb125-ledger-note-wording.js            # dry run (lists the rows)
//   node scripts/fix-bb125-ledger-note-wording.js --apply

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const OLD_WORDINGS = ["damage control", "BB-125 audit report"];
const NEW = "audit correction";
const rewrite = (note) => note.replace(/damage control/gi, NEW).replace(/BB-125 audit report/gi, `BB-125 ${NEW}`);
const EXPECTED_LEAVE_ID = "cmsjc2mkq0dmeti506qackmir";
const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await prisma.leaveTransaction.findMany({
    where:   { OR: OLD_WORDINGS.map((w) => ({ note: { contains: w, mode: "insensitive" } })) },
    select:  { id: true, leaveId: true, type: true, hours: true, note: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Ledger notes containing ${OLD_WORDINGS.map((w) => `"${w}"`).join(" or ")}: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.id} leave=${r.leaveId} ${r.type} hours=${r.hours} ${r.createdAt.toISOString()}`);
    console.log(`    now:   ${r.note}`);
    console.log(`    after: ${rewrite(r.note)}`);
  }

  const unexpected = rows.filter((r) => r.leaveId !== EXPECTED_LEAVE_ID);
  if (unexpected.length) {
    console.log(`\n⛔ ${unexpected.length} row(s) on another leave — nothing written. Share this output.`);
    process.exitCode = 1;
    return;
  }
  if (!rows.length) {
    console.log("Nothing to change.");
    return;
  }
  if (!APPLY) {
    console.log("\nDry run — re-run with --apply to rewrite these notes.");
    return;
  }

  await prisma.$transaction(
    rows.map((r) => prisma.leaveTransaction.update({
      where: { id: r.id },
      data:  { note: rewrite(r.note) },
    }))
  );
  console.log(`\n✅ Rewrote ${rows.length} note(s). Nothing else changed.`);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
