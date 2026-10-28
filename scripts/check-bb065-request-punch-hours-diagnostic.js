// scripts/check-bb065-request-punch-hours-diagnostic.js
//
// BB-065 — Request Punch hours discrepancy (7.00h vs 8.00h for identical
// 09:00-17:00 spans). This is READ-ONLY — it makes no writes and calls no
// compute/mutation functions. It only reads existing DB columns.
//
// What it answers:
//   1. Is estimatedNetHours/estimatedDuration on RequestedTimeLog a value that
//      was STORED at submission time (embedded in the DB), or something
//      computed on the fly when the pending-queue UI is displayed?
//      -> It is a stored column (schema.prisma:1078-1079). This script proves
//         it by reading the raw DB value directly, with no derivation.
//   2. For every RequestedTimeLog (regardless of status), does the stored
//      estimatedNetHours match what the *new* server-side formula (gross
//      minus company.minimumLunchMinutes) would produce? Mismatches are
//      pre-fix records where the client sent its own (possibly wrong) value.
//   3. For APPROVED requests specifically, is the linked TimeLog.netWorkedHours
//      still NULL (never computed - a real, non-cosmetic gap since approval
//      previously did not call computeTimeLogSummary), or does it already
//      have a persisted value (either computed correctly by a later cutoff
//      sweep, or possibly still wrong)?
//
// This script does NOT call computeTimeLogSummary and does NOT write
// anything. It only reports candidates. Any actual backfill/recompute is a
// separate script, to be written only after reviewing this output.
//
// Usage: node scripts/check-bb065-request-punch-hours-diagnostic.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtHours(n) {
  return n === null || n === undefined ? "null" : `${n}h`;
}

async function main() {
  const requests = await prisma.requestedTimeLog.findMany({
    orderBy: { submittedAt: "desc" },
    select: {
      id: true,
      status: true,
      reason: true,
      requestedDate: true,
      requestedClockIn: true,
      requestedClockOut: true,
      estimatedDuration: true,
      estimatedNetHours: true,
      submittedAt: true,
      approvedAt: true,
      createdTimeLogId: true,
      user: {
        select: {
          id: true,
          email: true,
          companyId: true,
          profile: { select: { firstName: true, lastName: true } },
          company: { select: { minimumLunchMinutes: true } },
        },
      },
    },
  });

  console.log(`=== RequestedTimeLog rows found: ${requests.length} ===\n`);

  let staleCount = 0;
  let matchCount = 0;
  let nullEstimateCount = 0;

  const staleRows = [];
  const needsRecomputeRows = [];
  const okApprovedRows = [];

  for (const r of requests) {
    const minimumLunchMinutes = r.user?.company?.minimumLunchMinutes ?? 60;
    const grossMinutes = Math.round(
      (new Date(r.requestedClockOut).getTime() - new Date(r.requestedClockIn).getTime()) / 60000
    );
    const recomputedNetHours = +(Math.max(0, grossMinutes - minimumLunchMinutes) / 60).toFixed(2);

    const name = r.user?.profile
      ? `${r.user.profile.firstName} ${r.user.profile.lastName}`
      : r.user?.email || r.userId;

    let verdict;
    if (r.estimatedNetHours === null || r.estimatedNetHours === undefined) {
      verdict = "NULL_ESTIMATE";
      nullEstimateCount++;
    } else if (Math.abs(r.estimatedNetHours - recomputedNetHours) > 0.01) {
      verdict = "STALE (client-computed value differs from current server formula)";
      staleCount++;
    } else {
      verdict = "MATCH";
      matchCount++;
    }

    if (verdict.startsWith("STALE") || verdict === "NULL_ESTIMATE") {
      staleRows.push({ r, name, recomputedNetHours, verdict });
    }

    console.log(`--- RequestedTimeLog ${r.id} ---`);
    console.log(`  employee: ${name}`);
    console.log(`  status: ${r.status}  reason: "${r.reason || "—"}"`);
    console.log(`  requestedDate: ${fmt(r.requestedDate)}`);
    console.log(`  clockIn: ${fmt(r.requestedClockIn)}  clockOut: ${fmt(r.requestedClockOut)}`);
    console.log(`  submittedAt: ${fmt(r.submittedAt)}`);
    console.log(`  stored estimatedDuration: ${r.estimatedDuration ?? "null"} min`);
    console.log(`  stored estimatedNetHours: ${fmtHours(r.estimatedNetHours)}`);
    console.log(
      `  recomputed (current server formula, minimumLunchMinutes=${minimumLunchMinutes}): ${fmtHours(recomputedNetHours)}`
    );
    console.log(`  verdict: ${verdict}`);

    // For APPROVED requests, check the linked TimeLog's persisted netWorkedHours.
    if (r.status === "APPROVED" && r.createdTimeLogId) {
      const timeLog = await prisma.timeLog.findUnique({
        where: { id: r.createdTimeLogId },
        select: { id: true, timeIn: true, timeOut: true, punchType: true, netWorkedHours: true, calculatedAt: true },
      });
      if (!timeLog) {
        console.log(`  linked TimeLog ${r.createdTimeLogId}: NOT FOUND (dangling reference)`);
      } else if (timeLog.netWorkedHours === null || timeLog.netWorkedHours === undefined) {
        console.log(
          `  linked TimeLog ${timeLog.id}: netWorkedHours is NULL — never computed (needs recompute)`
        );
        needsRecomputeRows.push({ r, name, timeLog });
      } else {
        console.log(
          `  linked TimeLog ${timeLog.id}: netWorkedHours = ${fmtHours(timeLog.netWorkedHours)} ` +
            `(persisted, calculatedAt: ${fmt(timeLog.calculatedAt)})`
        );
        okApprovedRows.push({ r, name, timeLog });
      }
    } else if (r.status === "APPROVED" && !r.createdTimeLogId) {
      console.log(`  APPROVED but no createdTimeLogId set — dangling approval, worth a look.`);
    }

    console.log("");
  }

  console.log("=== Summary ===");
  console.log(`  Total RequestedTimeLog rows: ${requests.length}`);
  console.log(`  estimatedNetHours MATCHES current server formula: ${matchCount}`);
  console.log(`  estimatedNetHours STALE (client-computed, differs from formula): ${staleCount}`);
  console.log(`  estimatedNetHours NULL: ${nullEstimateCount}`);
  console.log(`  APPROVED requests whose linked TimeLog.netWorkedHours is NULL (real gap): ${needsRecomputeRows.length}`);
  console.log(`  APPROVED requests whose linked TimeLog.netWorkedHours is already persisted: ${okApprovedRows.length}`);

  if (staleRows.length > 0) {
    console.log(`\n  Stale/null-estimate rows (cosmetic only unless still PENDING and about to be approved):`);
    for (const { r, name, recomputedNetHours, verdict } of staleRows) {
      console.log(
        `    - ${r.id} | ${name} | ${r.status} | ${fmt(r.requestedDate)} | stored=${fmtHours(r.estimatedNetHours)} recomputed=${fmtHours(recomputedNetHours)} | ${verdict}`
      );
    }
  }

  if (needsRecomputeRows.length > 0) {
    console.log(`\n  APPROVED rows needing an actual recompute (non-cosmetic — real TimeLog gap):`);
    for (const { r, name, timeLog } of needsRecomputeRows) {
      console.log(
        `    - request ${r.id} | timeLog ${timeLog.id} | ${name} | ${fmt(r.requestedDate)} | approvedAt=${fmt(r.approvedAt)}`
      );
    }
  }

  console.log(
    "\nNo changes were made by this script. estimatedNetHours and netWorkedHours above were read " +
      "directly from their DB columns with no derivation — confirming both are persisted values, not " +
      "computed live on display."
  );
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
