// scripts/check-bb065-request-punch-lunch-deduction-scope.js
//
// BB-065 (follow-up) — Policy correction: a manually-approved Request Punch should
// NOT have a lunch break auto-deducted (the employee's claimed clock-in/clock-out
// span is taken at face value; there's no break data to assume from, unlike a real
// device clock-in/out). The approval code has been fixed going forward
// (autoLunchDeductionMinutes: 0 is now set when creating the TimeLog), but every
// request approved BEFORE that fix went through the old default behavior, which
// deducted company.minimumLunchMinutes even though nothing indicated a break.
//
// This is READ-ONLY — it makes no writes and calls no compute/mutation functions.
//
// What it reports, for every RequestedTimeLog that has a linked TimeLog
// (i.e. was approved and produced a real punch record):
//   - WRONGLY_DEDUCTED: punchType REGULAR, lunchDeductionMinutes > 0 was applied to
//     netWorkedHours — this is the actual scope of underpaid-by-a-lunch-break
//     approved records. Shows current (wrong) hours, corrected hours, and the delta.
//   - NEVER_COMPUTED: netWorkedHours is still null (pre-existing gap, see the
//     earlier BB-065 diagnostic script for this same finding).
//   - TRAINING: excluded from the deduction concern (flat-hours path, unaffected).
//   - OK: lunchDeductionMinutes is already 0 — approved after the fix, or a
//     REGULAR log that never had a deduction applied for some other reason.
//
// Scoped to requestedDate between FROM_DATE and today (inclusive) per request.
//
// Usage: node scripts/check-bb065-request-punch-lunch-deduction-scope.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const FROM_DATE = new Date("2026-07-01T00:00:00.000Z");
const TO_DATE   = new Date(); // today, at script run time

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtHours(n) {
  if (n === null || n === undefined) return "null";
  return `${Number(n)}h`;
}

async function main() {
  const requests = await prisma.requestedTimeLog.findMany({
    where: {
      createdTimeLogId: { not: null },
      requestedDate: { gte: FROM_DATE, lte: TO_DATE },
    },
    orderBy: { approvedAt: "asc" },
    select: {
      id: true,
      status: true,
      reason: true,
      requestedDate: true,
      requestedClockIn: true,
      requestedClockOut: true,
      approvedAt: true,
      createdTimeLogId: true,
      user: {
        select: {
          email: true,
          companyId: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  console.log(
    `=== Approved RequestedTimeLog rows with a linked TimeLog, ` +
      `requestedDate ${fmt(FROM_DATE)} to ${fmt(TO_DATE)}: ${requests.length} ===\n`
  );

  const wronglyDeducted = [];
  const neverComputed = [];
  const dangling = [];
  let okCount = 0;
  let trainingCount = 0;
  let totalDeltaHours = 0;

  for (const r of requests) {
    const name = r.user?.profile
      ? `${r.user.profile.firstName} ${r.user.profile.lastName}`
      : r.user?.email || r.userId;

    const timeLog = await prisma.timeLog.findUnique({
      where: { id: r.createdTimeLogId },
      select: {
        id: true,
        punchType: true,
        netWorkedHours: true,
        lunchDeductionMinutes: true,
        grossHours: true,
        autoLunchDeductionMinutes: true,
        calculatedAt: true,
      },
    });

    console.log(`--- RequestedTimeLog ${r.id} (TimeLog ${r.createdTimeLogId}) ---`);
    console.log(`  employee: ${name}`);
    console.log(`  requestedDate: ${fmt(r.requestedDate)}  approvedAt: ${fmt(r.approvedAt)}`);
    console.log(`  reason: "${r.reason || "—"}"`);

    if (!timeLog) {
      console.log(`  linked TimeLog NOT FOUND — dangling reference.`);
      dangling.push({ r, name });
      console.log("");
      continue;
    }

    console.log(`  punchType: ${timeLog.punchType}`);
    console.log(`  grossHours: ${fmtHours(timeLog.grossHours)}`);
    console.log(`  lunchDeductionMinutes: ${timeLog.lunchDeductionMinutes ?? "null"}`);
    console.log(`  netWorkedHours (stored): ${fmtHours(timeLog.netWorkedHours)}`);

    if (timeLog.punchType === "TRAINING") {
      console.log(`  verdict: TRAINING — flat-hours path, lunch deduction not applicable, skipped.`);
      trainingCount++;
    } else if (timeLog.netWorkedHours === null || timeLog.netWorkedHours === undefined) {
      console.log(`  verdict: NEVER_COMPUTED — netWorkedHours is null (separate pre-existing gap).`);
      neverComputed.push({ r, name, timeLog });
    } else if (timeLog.punchType === "REGULAR" && (timeLog.lunchDeductionMinutes || 0) > 0) {
      const deltaHours = +(timeLog.lunchDeductionMinutes / 60).toFixed(2);
      const correctedHours = +(Number(timeLog.netWorkedHours) + deltaHours).toFixed(2);
      console.log(
        `  verdict: WRONGLY_DEDUCTED — stored=${fmtHours(timeLog.netWorkedHours)} ` +
          `corrected=${fmtHours(correctedHours)} delta=+${deltaHours}h`
      );
      wronglyDeducted.push({ r, name, timeLog, correctedHours, deltaHours });
      totalDeltaHours += deltaHours;
    } else {
      console.log(`  verdict: OK — no deduction applied (already correct).`);
      okCount++;
    }

    console.log("");
  }

  console.log("=== Summary ===");
  console.log(`  Total approved requests with a linked TimeLog: ${requests.length}`);
  console.log(`  WRONGLY_DEDUCTED (needs +lunch-minutes correction): ${wronglyDeducted.length}`);
  console.log(`  NEVER_COMPUTED (netWorkedHours still null): ${neverComputed.length}`);
  console.log(`  TRAINING (unaffected, excluded): ${trainingCount}`);
  console.log(`  OK (already correct): ${okCount}`);
  console.log(`  Dangling references (TimeLog not found): ${dangling.length}`);
  console.log(`  Total understated hours across WRONGLY_DEDUCTED rows: ${totalDeltaHours.toFixed(2)}h`);

  if (wronglyDeducted.length > 0) {
    console.log(`\n  WRONGLY_DEDUCTED rows (oldest first — candidates for a backfill script):`);
    for (const { r, name, timeLog, correctedHours, deltaHours } of wronglyDeducted) {
      console.log(
        `    - request ${r.id} | timeLog ${timeLog.id} | ${name} | ${fmt(r.requestedDate)} | ` +
          `approvedAt=${fmt(r.approvedAt)} | stored=${fmtHours(timeLog.netWorkedHours)} ` +
          `corrected=${fmtHours(correctedHours)} delta=+${deltaHours}h`
      );
    }
  }

  if (neverComputed.length > 0) {
    console.log(`\n  NEVER_COMPUTED rows (same list as the earlier BB-065 diagnostic):`);
    for (const { r, name, timeLog } of neverComputed) {
      console.log(`    - request ${r.id} | timeLog ${timeLog.id} | ${name} | ${fmt(r.requestedDate)}`);
    }
  }

  console.log(
    "\nNo changes were made by this script. All values above were read directly from their DB " +
      "columns — 'corrected' figures are computed in-memory for reporting only and were never written back."
  );
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
