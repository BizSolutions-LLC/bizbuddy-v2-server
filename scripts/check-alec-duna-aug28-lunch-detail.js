// scripts/check-alec-duna-aug28-lunch-detail.js
//
// Follow-up to check-alec-duna-aug28-detail.js. That script found TimeLog
// cmtd3l8jn02ztrj4zgyg5o7yf (Alec Duna, 2026-08-28) with grossHours=5.25h but
// netWorkedHours=0.02h — meaning ~314 minutes were deducted as break/lunch
// time out of a 5.25h shift.
//
// computeTimeLogSummary() (src/services/timeLogComputeService.js) derives that
// deduction from log.lunchBreak (+ coffeeBreaks, autoLunchDeductionMinutes,
// autoLunchApplied) plus the company's minimumLunchMinutes floor. None of
// those raw fields were printed by the first script. This one prints them
// directly to confirm (or rule out) an accidental/mistimed lunch punch as the
// cause.
//
// READ-ONLY — no writes, no computeTimeLogSummary calls.
//
// Usage: node scripts/check-alec-duna-aug28-lunch-detail.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TIME_LOG_ID = "cmtd3l8jn02ztrj4zgyg5o7yf";

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

async function main() {
  const log = await prisma.timeLog.findUnique({
    where: { id: TIME_LOG_ID },
    include: {
      user: {
        select: {
          companyId: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  if (!log) {
    console.log(`No TimeLog found with id ${TIME_LOG_ID}. Aborting.`);
    return;
  }

  console.log("=== TimeLog ===");
  console.log(`  id: ${log.id}`);
  console.log(`  user: ${log.user.profile?.firstName} ${log.user.profile?.lastName}`);
  console.log(`  timeIn: ${fmt(log.timeIn)}  timeOut: ${fmt(log.timeOut)}`);
  console.log(`  grossHours: ${log.grossHours ?? "null"}  netWorkedHours: ${log.netWorkedHours ?? "null"}`);

  console.log("\n=== Raw break / lunch fields ===");
  console.log(`  lunchBreak (json): ${JSON.stringify(log.lunchBreak)}`);
  console.log(`  coffeeBreaks (json): ${JSON.stringify(log.coffeeBreaks)}`);
  console.log(`  autoLunchDeductionMinutes: ${log.autoLunchDeductionMinutes ?? "null"}`);
  console.log(`  autoLunchApplied: ${log.autoLunchApplied}`);
  console.log(`  autoCoffeeApplied: ${log.autoCoffeeApplied}`);
  console.log(`  lunchDeductionMinutes (stored derived value): ${log.lunchDeductionMinutes ?? "null"}`);
  console.log(`  totalBreakMinutes (stored derived value): ${log.totalBreakMinutes ?? "null"}`);
  console.log(`  remarks: ${JSON.stringify(log.remarks)}`);

  const company = await prisma.company.findUnique({
    where: { id: log.user.companyId },
    select: {
      name: true,
      timeZone: true,
      minimumLunchMinutes: true,
      gracePeriodMinutes: true,
      earlyClockOutGraceMinutes: true,
    },
  });

  console.log("\n=== Company lunch/grace settings ===");
  console.log(`  company: ${company?.name || "—"}`);
  console.log(`  minimumLunchMinutes (floor applied when no/short lunch logged): ${company?.minimumLunchMinutes ?? "—"}`);
  console.log(`  gracePeriodMinutes: ${company?.gracePeriodMinutes ?? "—"}`);
  console.log(`  earlyClockOutGraceMinutes: ${company?.earlyClockOutGraceMinutes ?? "—"}`);

  // Cross-check: if lunchBreak has explicit in/out timestamps, compute the
  // duration directly so it can be compared against the deduction actually applied.
  if (log.lunchBreak && typeof log.lunchBreak === "object") {
    console.log("\n=== Lunch break duration check ===");
    const lb = Array.isArray(log.lunchBreak) ? log.lunchBreak : [log.lunchBreak];
    for (const entry of lb) {
      if (entry && entry.start && entry.end) {
        const mins = (new Date(entry.end).getTime() - new Date(entry.start).getTime()) / 60000;
        console.log(`  entry: start=${fmt(entry.start)} end=${fmt(entry.end)} => ${mins.toFixed(1)} min`);
      } else {
        console.log(`  entry (unrecognized shape): ${JSON.stringify(entry)}`);
      }
    }
  }

  console.log("\nDone. No changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
