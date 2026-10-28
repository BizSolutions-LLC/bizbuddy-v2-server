// scripts/fix-cutoff-backtrack-correct-gap-filler-dates.js
//
// Corrects the CutoffPeriod rows created by the mis-anchored "backtrack" run
// on 2026-09-11 that fill the Jan 7 - May 12, 2026 gap (no pre-existing
// correct period covers this range) for Driver/Aide, Staff Supervisor, and
// Staff. Confirmed via check-cutoff-backtrack-safe-delete.js that at least
// some of these rows have real TimeLog data attached, so they must be
// corrected in place, not deleted — deleting them would leave that
// attendance with no period to be approved against. The rows with zero data
// are corrected too, for a continuous, correctly-anchored period sequence.
//
// Each row's periodStart/periodEnd is updated from its current (wrong) value
// to the correct Jan-7-anchored bi-weekly boundary. paymentDate is
// recomputed as newEnd + that department's configured paymentOffsetDays
// (read from DepartmentCutoffSettings at run time, not assumed/hardcoded).
//
// Before updating, the script re-reads each row and skips it (without
// touching the rest) if the current periodStart/periodEnd no longer match
// what was captured during investigation — a safety guard in case the data
// changed since (this also makes the script safe to re-run).
//
// Does NOT touch the other 9 mismatched periods per department (May 7 - Sep
// 9) — those are duplicates of already-existing correct periods and are
// handled by fix-cutoff-backtrack-delete-duplicate-periods.js instead.
//
// Usage:
//   node scripts/fix-cutoff-backtrack-correct-gap-filler-dates.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CORRECTIONS = [
  // --- Driver/Aide ---
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_tpolnfcdq", expectedOldStart: "2026-01-01", expectedOldEnd: "2026-01-14", newStart: "2026-01-07", newEnd: "2026-01-20" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_d8ro7hfa6", expectedOldStart: "2026-01-15", expectedOldEnd: "2026-01-28", newStart: "2026-01-21", newEnd: "2026-02-03" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_qouic3jlz", expectedOldStart: "2026-01-29", expectedOldEnd: "2026-02-11", newStart: "2026-02-04", newEnd: "2026-02-17" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_hsrqcscb9", expectedOldStart: "2026-02-12", expectedOldEnd: "2026-02-25", newStart: "2026-02-18", newEnd: "2026-03-03" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_7iliqdpch", expectedOldStart: "2026-02-26", expectedOldEnd: "2026-03-11", newStart: "2026-03-04", newEnd: "2026-03-17" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_0g9sfwxb5", expectedOldStart: "2026-03-12", expectedOldEnd: "2026-03-25", newStart: "2026-03-18", newEnd: "2026-03-31" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_v4jlwyo2x", expectedOldStart: "2026-03-26", expectedOldEnd: "2026-04-08", newStart: "2026-04-01", newEnd: "2026-04-14" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_kqucxy2a5", expectedOldStart: "2026-04-09", expectedOldEnd: "2026-04-22", newStart: "2026-04-15", newEnd: "2026-04-28" },
  { id: "cutoff_cmnfnf2ol04pwnr4uay7tg96o_1789093107176_29eyhbv8h", expectedOldStart: "2026-04-23", expectedOldEnd: "2026-05-06", newStart: "2026-04-29", newEnd: "2026-05-12" },

  // --- Staff Supervisor ---
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_7wi6dfhvb", expectedOldStart: "2026-01-01", expectedOldEnd: "2026-01-14", newStart: "2026-01-07", newEnd: "2026-01-20" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_8whzclrvc", expectedOldStart: "2026-01-15", expectedOldEnd: "2026-01-28", newStart: "2026-01-21", newEnd: "2026-02-03" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_udetmtkbf", expectedOldStart: "2026-01-29", expectedOldEnd: "2026-02-11", newStart: "2026-02-04", newEnd: "2026-02-17" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_omh61ll8i", expectedOldStart: "2026-02-12", expectedOldEnd: "2026-02-25", newStart: "2026-02-18", newEnd: "2026-03-03" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_89uf7xjuv", expectedOldStart: "2026-02-26", expectedOldEnd: "2026-03-11", newStart: "2026-03-04", newEnd: "2026-03-17" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_uckhho5nj", expectedOldStart: "2026-03-12", expectedOldEnd: "2026-03-25", newStart: "2026-03-18", newEnd: "2026-03-31" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_dcfi76vh1", expectedOldStart: "2026-03-26", expectedOldEnd: "2026-04-08", newStart: "2026-04-01", newEnd: "2026-04-14" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_yff7zxanr", expectedOldStart: "2026-04-09", expectedOldEnd: "2026-04-22", newStart: "2026-04-15", newEnd: "2026-04-28" },
  { id: "cutoff_cmnfnklgt04sdnr4u153i8a0z_1789093124968_jycuvgwr4", expectedOldStart: "2026-04-23", expectedOldEnd: "2026-05-06", newStart: "2026-04-29", newEnd: "2026-05-12" },

  // --- Staff ---
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_3pio3qkol", expectedOldStart: "2026-01-01", expectedOldEnd: "2026-01-14", newStart: "2026-01-07", newEnd: "2026-01-20" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_cn87vklob", expectedOldStart: "2026-01-15", expectedOldEnd: "2026-01-28", newStart: "2026-01-21", newEnd: "2026-02-03" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_5ph68gysj", expectedOldStart: "2026-01-29", expectedOldEnd: "2026-02-11", newStart: "2026-02-04", newEnd: "2026-02-17" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_bbbl0pewt", expectedOldStart: "2026-02-12", expectedOldEnd: "2026-02-25", newStart: "2026-02-18", newEnd: "2026-03-03" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_i2hcf6v22", expectedOldStart: "2026-02-26", expectedOldEnd: "2026-03-11", newStart: "2026-03-04", newEnd: "2026-03-17" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_v6oyheibr", expectedOldStart: "2026-03-12", expectedOldEnd: "2026-03-25", newStart: "2026-03-18", newEnd: "2026-03-31" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_c7sa20gp0", expectedOldStart: "2026-03-26", expectedOldEnd: "2026-04-08", newStart: "2026-04-01", newEnd: "2026-04-14" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_5coekt31k", expectedOldStart: "2026-04-09", expectedOldEnd: "2026-04-22", newStart: "2026-04-15", newEnd: "2026-04-28" },
  { id: "cutoff_cmnfni0bm04r8nr4us57sjcsk_1789093134626_phvbtxh15", expectedOldStart: "2026-04-23", expectedOldEnd: "2026-05-06", newStart: "2026-04-29", newEnd: "2026-05-12" },
];

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  let updated = 0;
  let skipped = 0;
  const offsetCache = new Map(); // departmentId -> paymentOffsetDays

  for (const c of CORRECTIONS) {
    const row = await prisma.cutoffPeriod.findUnique({
      where: { id: c.id },
      select: { id: true, periodStart: true, periodEnd: true, departmentId: true, companyId: true },
    });

    if (!row) {
      console.log(`SKIP ${c.id}: row not found (already deleted or corrected?)`);
      skipped++;
      continue;
    }

    if (fmt(row.periodStart) !== c.expectedOldStart || fmt(row.periodEnd) !== c.expectedOldEnd) {
      console.log(
        `SKIP ${c.id}: current dates (${fmt(row.periodStart)} -> ${fmt(row.periodEnd)}) ` +
          `don't match expected (${c.expectedOldStart} -> ${c.expectedOldEnd}) — already corrected or data changed since investigation, not touching it.`
      );
      skipped++;
      continue;
    }

    if (!offsetCache.has(row.departmentId)) {
      const settings = await prisma.departmentCutoffSettings.findFirst({
        where: { companyId: row.companyId, departmentId: row.departmentId },
        select: { paymentOffsetDays: true },
      });
      offsetCache.set(row.departmentId, settings?.paymentOffsetDays ?? 3);
    }
    const offsetDays = offsetCache.get(row.departmentId);

    const newEndDate = new Date(`${c.newEnd}T00:00:00.000Z`);
    const newPaymentDate = new Date(newEndDate);
    newPaymentDate.setUTCDate(newPaymentDate.getUTCDate() + offsetDays);

    await prisma.cutoffPeriod.update({
      where: { id: c.id },
      data: {
        periodStart: new Date(`${c.newStart}T00:00:00.000Z`),
        periodEnd: newEndDate,
        paymentDate: newPaymentDate,
      },
    });

    console.log(
      `UPDATED ${c.id}: ${c.expectedOldStart} -> ${c.expectedOldEnd}  ==>  ${c.newStart} -> ${c.newEnd} ` +
        `(payment ${fmt(newPaymentDate)}, offset ${offsetDays}d)`
    );
    updated++;
  }

  console.log(`\n=== Done: ${updated} updated, ${skipped} skipped ===`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
