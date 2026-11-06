// scripts/fix-cutoff-backtrack-reopen-gap-filler-periods.js
//
// The 9 gap-filler CutoffPeriod rows per department (Jan 7 - May 12, 2026)
// corrected by fix-cutoff-backtrack-correct-gap-filler-dates.js were created
// with status="processed" — generateAllDepartmentCutoffs auto-marks any
// period whose periodEnd is already in the past as "processed" at creation
// time, regardless of whether any actual payroll processing happened. That's
// fine on its own, but the backtrack punch-log import feature
// (findCoveringOpenCutoffPeriod / assertOpenCutoffPeriod in
// src/services/Features/backtrackImportService.js) hard-requires
// status="open" to import punches into a period — it ignores "processed"
// periods entirely, even when their dates match exactly. That's what
// produced the "No open Cutoff Period covers Feb 4, 2026 - Feb 17, 2026"
// modal when importing a CSV for that range.
//
// This flips status to "open" for all 27 corrected gap-filler periods
// (9 each for Driver/Aide, Staff Supervisor, Staff) so punch-log backtrack
// imports can target them without the UI creating a second, duplicate
// period for the same date range.
//
// Before updating, each row is re-checked: periodStart/periodEnd must still
// match the corrected dates, and current status must still be "processed"
// (skipped, not touched, if it's already "open" or anything else — e.g. if
// someone already manually reopened it, or it's since moved to "locked").
//
// Usage:
//   node scripts/fix-cutoff-backtrack-reopen-gap-filler-periods.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TO_REOPEN = [
  // --- Driver/Aide ---
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_tpolnfcdq", start: "2026-01-07", end: "2026-01-20" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_d8ro7hfa6", start: "2026-01-21", end: "2026-02-03" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_qouic3jlz", start: "2026-02-04", end: "2026-02-17" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_hsrqcscb9", start: "2026-02-18", end: "2026-03-03" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_7iliqdpch", start: "2026-03-04", end: "2026-03-17" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_0g9sfwxb5", start: "2026-03-18", end: "2026-03-31" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_v4jlwyo2x", start: "2026-04-01", end: "2026-04-14" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_kqucxy2a5", start: "2026-04-15", end: "2026-04-28" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_29eyhbv8h", start: "2026-04-29", end: "2026-05-12" },

  // --- Staff Supervisor ---
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_7wi6dfhvb", start: "2026-01-07", end: "2026-01-20" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_8whzclrvc", start: "2026-01-21", end: "2026-02-03" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_udetmtkbf", start: "2026-02-04", end: "2026-02-17" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_omh61ll8i", start: "2026-02-18", end: "2026-03-03" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_89uf7xjuv", start: "2026-03-04", end: "2026-03-17" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_uckhho5nj", start: "2026-03-18", end: "2026-03-31" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_dcfi76vh1", start: "2026-04-01", end: "2026-04-14" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_yff7zxanr", start: "2026-04-15", end: "2026-04-28" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_jycuvgwr4", start: "2026-04-29", end: "2026-05-12" },

  // --- Staff ---
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_3pio3qkol", start: "2026-01-07", end: "2026-01-20" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_cn87vklob", start: "2026-01-21", end: "2026-02-03" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_5ph68gysj", start: "2026-02-04", end: "2026-02-17" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_bbbl0pewt", start: "2026-02-18", end: "2026-03-03" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_i2hcf6v22", start: "2026-03-04", end: "2026-03-17" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_v6oyheibr", start: "2026-03-18", end: "2026-03-31" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_c7sa20gp0", start: "2026-04-01", end: "2026-04-14" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_5coekt31k", start: "2026-04-15", end: "2026-04-28" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_phvbtxh15", start: "2026-04-29", end: "2026-05-12" },
];

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  let reopened = 0;
  let skipped = 0;

  for (const r of TO_REOPEN) {
    const row = await prisma.cutoffPeriod.findUnique({
      where: { id: r.id },
      select: { id: true, periodStart: true, periodEnd: true, status: true },
    });

    if (!row) {
      console.log(`SKIP ${r.id}: row not found.`);
      skipped++;
      continue;
    }

    if (fmt(row.periodStart) !== r.start || fmt(row.periodEnd) !== r.end) {
      console.log(
        `SKIP ${r.id}: current dates (${fmt(row.periodStart)} -> ${fmt(row.periodEnd)}) ` +
          `don't match expected corrected dates (${r.start} -> ${r.end}) — not touching it.`
      );
      skipped++;
      continue;
    }

    if (row.status !== "processed") {
      console.log(`SKIP ${r.id}: status is already "${row.status}", not "processed" — not touching it.`);
      skipped++;
      continue;
    }

    await prisma.cutoffPeriod.update({
      where: { id: r.id },
      data: { status: "open" },
    });

    console.log(`REOPENED ${r.id}: ${r.start} -> ${r.end}  (processed -> open)`);
    reopened++;
  }

  console.log(`\n=== Done: ${reopened} reopened, ${skipped} skipped ===`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
