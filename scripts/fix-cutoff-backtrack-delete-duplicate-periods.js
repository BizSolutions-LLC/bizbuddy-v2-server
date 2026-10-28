// scripts/fix-cutoff-backtrack-delete-duplicate-periods.js
//
// Deletes the CutoffPeriod rows created by the mis-anchored "backtrack" run
// on 2026-09-11 that duplicate date ranges already covered by a
// correctly-anchored period generated earlier (May 2026 - Sep 2026), for
// Driver/Aide, Staff Supervisor, and Staff. Each of these has
// TimeLogApproval=0 (confirmed via check-cutoff-backtrack-safe-delete.js) —
// no approval record points to them — and any raw TimeLog punches in their
// date range are already covered by the pre-existing correct period they
// overlap, so deleting them does not orphan any data.
//
// Before deleting, each row is re-checked: its periodStart/periodEnd must
// still match what was captured during investigation, and it must still
// have zero linked TimeLogApproval rows. Any row that fails either check is
// skipped (not deleted) and reported, without affecting the rest.
//
// Does NOT touch the other 9 mismatched periods per department (Jan 7 - May
// 12) — those have real data and are corrected in place, not deleted, by
// fix-cutoff-backtrack-correct-gap-filler-dates.js instead.
//
// Usage:
//   node scripts/fix-cutoff-backtrack-delete-duplicate-periods.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TO_DELETE = [
  // --- Driver/Aide ---
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_37wwr2beb", expectedStart: "2026-05-07", expectedEnd: "2026-05-20", duplicateOf: "2026-05-13 -> 2026-05-26" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107177_jrdhqtetl", expectedStart: "2026-05-21", expectedEnd: "2026-06-03", duplicateOf: "2026-05-27 -> 2026-06-09" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107177_kf3v4wgee", expectedStart: "2026-06-04", expectedEnd: "2026-06-17", duplicateOf: "2026-06-10 -> 2026-06-23" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107177_5ffe3w9dd", expectedStart: "2026-06-18", expectedEnd: "2026-07-01", duplicateOf: "2026-06-24 -> 2026-07-07" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107177_6smh2wcdo", expectedStart: "2026-07-02", expectedEnd: "2026-07-15", duplicateOf: "2026-07-08 -> 2026-07-21" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107177_ibhfaw5i5", expectedStart: "2026-07-16", expectedEnd: "2026-07-29", duplicateOf: "2026-07-22 -> 2026-08-04" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107177_r3qhjt4nv", expectedStart: "2026-07-30", expectedEnd: "2026-08-12", duplicateOf: "2026-08-05 -> 2026-08-18" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107177_xplxi3271", expectedStart: "2026-08-13", expectedEnd: "2026-08-26", duplicateOf: "2026-08-19 -> 2026-09-01" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107177_bngmu5z8t", expectedStart: "2026-08-27", expectedEnd: "2026-09-09", duplicateOf: "2026-09-02 -> 2026-09-15" },

  // --- Staff Supervisor ---
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_9zozmgers", expectedStart: "2026-05-07", expectedEnd: "2026-05-20", duplicateOf: "2026-05-13 -> 2026-05-26" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_bkqq304ua", expectedStart: "2026-05-21", expectedEnd: "2026-06-03", duplicateOf: "2026-05-27 -> 2026-06-09" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_lbbab0qq4", expectedStart: "2026-06-04", expectedEnd: "2026-06-17", duplicateOf: "2026-06-10 -> 2026-06-23" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_5yx9y4z5g", expectedStart: "2026-06-18", expectedEnd: "2026-07-01", duplicateOf: "2026-06-24 -> 2026-07-07" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_9tu0swjpn", expectedStart: "2026-07-02", expectedEnd: "2026-07-15", duplicateOf: "2026-07-08 -> 2026-07-21" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_3r0jnam8a", expectedStart: "2026-07-16", expectedEnd: "2026-07-29", duplicateOf: "2026-07-22 -> 2026-08-04" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_xlsyy0fqb", expectedStart: "2026-07-30", expectedEnd: "2026-08-12", duplicateOf: "2026-08-05 -> 2026-08-18" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_qjv3gwz5j", expectedStart: "2026-08-13", expectedEnd: "2026-08-26", duplicateOf: "2026-08-19 -> 2026-09-01" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_1m2td479t", expectedStart: "2026-08-27", expectedEnd: "2026-09-09", duplicateOf: "2026-09-02 -> 2026-09-15" },

  // --- Staff ---
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_rl1j86168", expectedStart: "2026-05-07", expectedEnd: "2026-05-20", duplicateOf: "2026-05-13 -> 2026-05-26" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_oshcim26w", expectedStart: "2026-05-21", expectedEnd: "2026-06-03", duplicateOf: "2026-05-27 -> 2026-06-09" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_r1p4tmo8w", expectedStart: "2026-06-04", expectedEnd: "2026-06-17", duplicateOf: "2026-06-10 -> 2026-06-23" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_eewpirbiz", expectedStart: "2026-06-18", expectedEnd: "2026-07-01", duplicateOf: "2026-06-24 -> 2026-07-07" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_s87wbmlfk", expectedStart: "2026-07-02", expectedEnd: "2026-07-15", duplicateOf: "2026-07-08 -> 2026-07-21" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_q3vtvggjd", expectedStart: "2026-07-16", expectedEnd: "2026-07-29", duplicateOf: "2026-07-22 -> 2026-08-04" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_cto2gt8c7", expectedStart: "2026-07-30", expectedEnd: "2026-08-12", duplicateOf: "2026-08-05 -> 2026-08-18" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_lu9w0jp01", expectedStart: "2026-08-13", expectedEnd: "2026-08-26", duplicateOf: "2026-08-19 -> 2026-09-01" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_e8yj4we3d", expectedStart: "2026-08-27", expectedEnd: "2026-09-09", duplicateOf: "2026-09-02 -> 2026-09-15" },
];

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  let deleted = 0;
  let skipped = 0;

  for (const d of TO_DELETE) {
    const row = await prisma.cutoffPeriod.findUnique({
      where: { id: d.id },
      select: { id: true, periodStart: true, periodEnd: true },
    });

    if (!row) {
      console.log(`SKIP ${d.id}: row not found (already deleted?)`);
      skipped++;
      continue;
    }

    if (fmt(row.periodStart) !== d.expectedStart || fmt(row.periodEnd) !== d.expectedEnd) {
      console.log(
        `SKIP ${d.id}: current dates (${fmt(row.periodStart)} -> ${fmt(row.periodEnd)}) ` +
          `don't match expected (${d.expectedStart} -> ${d.expectedEnd}) — data changed since investigation, not touching it.`
      );
      skipped++;
      continue;
    }

    const approvalCount = await prisma.timeLogApproval.count({ where: { cutoffPeriodId: d.id } });
    if (approvalCount > 0) {
      console.log(`SKIP ${d.id}: now has ${approvalCount} TimeLogApproval row(s) linked — not deleting, needs manual review.`);
      skipped++;
      continue;
    }

    await prisma.cutoffPeriod.delete({ where: { id: d.id } });
    console.log(`DELETED ${d.id}: ${d.expectedStart} -> ${d.expectedEnd} (duplicate of ${d.duplicateOf})`);
    deleted++;
  }

  console.log(`\n=== Done: ${deleted} deleted, ${skipped} skipped ===`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
