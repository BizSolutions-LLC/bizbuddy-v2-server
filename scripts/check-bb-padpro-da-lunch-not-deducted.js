// scripts/check-bb-padpro-da-lunch-not-deducted.js
//
// Mendoza, Jasbleidi — 2026-09-30 Driver/Aide punch shows "Lunch Break 0.47h",
// yet Total Clock Hours 7.23h = AM 0.93 + Regular 5.50 + PM 0.80. Question:
// is the 0.47h lunch actually NOT deducted from the 7.23h?
//
// Per computeTimeLogSummary() (src/services/timeLogComputeService.js), the
// DRIVER_AIDE path sets netWorkedHours = sum of segment hours and never
// subtracts lunchDeductionMinutes (only the REGULAR path does). This script
// confirms that against real data, then measures how widespread it is across
// the PadPro company.
//
// READ-ONLY — SELECTs only. No writes, no computeTimeLogSummary calls.
// Credentials are never printed (host + database name only).
//
// Prints:
//   0. DB target + PadPro (Piedmont Adult Day Program) company settings.
//   1. Full detail for Jasbleidi Mendoza's 2026-09-30 punch(es): stored fields,
//      lunch source, segment math checks, TimeLogApproval rows.
//   2. Scope summary: every completed PadPro Driver/Aide punch with a non-zero
//      lunchDeductionMinutes where netWorkedHours == segment sum (lunch not deducted).
//
// Usage: node scripts/check-bb-padpro-da-lunch-not-deducted.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

// "PadPro" = Piedmont Adult Day Program
const COMPANY_ID         = "cmnegwuxm0004rf7fzo6wjrw2";
const TARGET_FIRST_NAME  = "Jasbleidi";
const TARGET_LAST_NAME   = "Mendoza";
const TARGET_LOCAL_DATE  = "2026-09-30";
const DA_PUNCH_TYPES     = ["DRIVER_AIDE", "DRIVER_AIDE_AM", "DRIVER_AIDE_PM"];
const TOLERANCE_HOURS    = 0.01;
const LIST_LIMIT         = 50;

function describeDbTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) return "DATABASE_URL not set in this process";
  try {
    const u = new URL(url);
    return `host=${u.hostname} port=${u.port || "(default)"} database=${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "DATABASE_URL present but could not be parsed";
  }
}

const num = (v) => (v == null ? null : parseFloat(v.toString()));
const fmtUtc = (d) => (d ? new Date(d).toISOString() : "—");
const fmtLocal = (d, tz) => (d ? moment(d).tz(tz).format("YYYY-MM-DD hh:mm A z") : "—");
const passFail = (ok) => (ok ? "PASS" : "FAIL");

function segmentSum(log) {
  return [log.driverAmSegmentHours, log.regularSegmentHours, log.driverPmSegmentHours]
    .map(num)
    .filter((h) => h !== null)
    .reduce((s, h) => s + h, 0);
}

function lunchPunchMinutes(lunchBreak) {
  if (!lunchBreak?.start || !lunchBreak?.end) return 0;
  return Math.max(0, (new Date(lunchBreak.end) - new Date(lunchBreak.start)) / 60000);
}

// Mirrors the branch order in computeTimeLogSummary step 6b.
function lunchSource(log, minimumLunchMins) {
  if (log.autoLunchDeductionMinutes != null) return `auto (autoLunchDeductionMinutes=${log.autoLunchDeductionMinutes})`;
  if (log.autoLunchApplied) return "auto, non-deductible (0)";
  const punched = lunchPunchMinutes(log.lunchBreak);
  if (punched > 0) {
    return punched >= minimumLunchMins
      ? `punched lunch (${punched.toFixed(1)} min)`
      : `punched lunch ${punched.toFixed(1)} min, floored to minimum ${minimumLunchMins}`;
  }
  return `no lunch punch, minimum floor (${minimumLunchMins} min)`;
}

async function main() {
  console.log("=== PadPro Driver/Aide lunch-not-deducted check (read-only) ===");
  console.log(`DB target: ${describeDbTarget()}`);

  // ── 0. Company ──────────────────────────────────────────────────────────────
  const company = await prisma.company.findUnique({
    where: { id: COMPANY_ID },
    select: {
      id: true,
      name: true,
      timeZone: true,
      minimumLunchMinutes: true,
      gracePeriodMinutes: true,
      earlyClockInGraceMinutes: true,
      earlyClockOutGraceMinutes: true,
    },
  });

  if (!company) {
    console.log(`\nNo company found with id ${COMPANY_ID}. Aborting.`);
    return;
  }

  const tz = company.timeZone || "America/Los_Angeles";
  const minimumLunchMins = company.minimumLunchMinutes ?? 60;

  console.log("\n=== Company ===");
  console.log(`  ${company.name} (${company.id})`);
  console.log(`  timeZone: ${tz}`);
  console.log(`  minimumLunchMinutes: ${company.minimumLunchMinutes ?? "null (default 60)"}`);
  console.log(`  gracePeriodMinutes: ${company.gracePeriodMinutes ?? "null"}`);
  console.log(`  earlyClockInGraceMinutes: ${company.earlyClockInGraceMinutes ?? "null"}`);
  console.log(`  earlyClockOutGraceMinutes: ${company.earlyClockOutGraceMinutes ?? "null"}`);

  // ── 1. Specific record ──────────────────────────────────────────────────────
  console.log(`\n=== 1. ${TARGET_LAST_NAME}, ${TARGET_FIRST_NAME} — ${TARGET_LOCAL_DATE} ===`);

  const users = await prisma.user.findMany({
    where: {
      companyId: company.id,
      profile: {
        lastName: { equals: TARGET_LAST_NAME, mode: "insensitive" },
        firstName: { startsWith: TARGET_FIRST_NAME, mode: "insensitive" },
      },
    },
    select: { id: true, profile: { select: { firstName: true, lastName: true } } },
  });

  if (users.length === 0) {
    console.log("  No matching user found in this company.");
  } else {
    if (users.length > 1) console.log(`  NOTE: ${users.length} users matched — showing all.`);

    const dayStart = moment.tz(TARGET_LOCAL_DATE, tz).startOf("day").toDate();
    const dayEnd   = moment.tz(TARGET_LOCAL_DATE, tz).endOf("day").toDate();

    for (const u of users) {
      console.log(`\n  user: ${u.profile?.firstName} ${u.profile?.lastName} (${u.id})`);

      const logs = await prisma.timeLog.findMany({
        where: { userId: u.id, timeIn: { gte: dayStart, lte: dayEnd } },
        orderBy: { timeIn: "asc" },
        include: {
          approvals: {
            select: {
              segmentType: true,
              status: true,
              actualHours: true,
              editedHours: true,
              segmentStart: true,
              segmentEnd: true,
              approvedClockIn: true,
              approvedClockOut: true,
              cutoffPeriodId: true,
            },
          },
        },
      });

      if (logs.length === 0) {
        console.log("  No TimeLogs on that local date.");
        continue;
      }

      for (const log of logs) {
        const net      = num(log.netWorkedHours);
        const segSum   = +segmentSum(log).toFixed(2);
        const lunchMin = log.lunchDeductionMinutes ?? 0;
        const lunchHrs = +(lunchMin / 60).toFixed(2);

        console.log(`\n  --- TimeLog ${log.id} ---`);
        console.log(`    punchType: ${log.punchType}`);
        console.log(`    timeIn:  ${fmtUtc(log.timeIn)}  (${fmtLocal(log.timeIn, tz)})`);
        console.log(`    timeOut: ${fmtUtc(log.timeOut)}  (${fmtLocal(log.timeOut, tz)})`);
        console.log(`    originalTimeIn/Out: ${fmtUtc(log.originalTimeIn)} / ${fmtUtc(log.originalTimeOut)}`);
        console.log(`    grossHours: ${num(log.grossHours) ?? "null"}  netWorkedHours: ${net ?? "null"}`);
        console.log(`    segments: AM=${num(log.driverAmSegmentHours) ?? "-"}  REG=${num(log.regularSegmentHours) ?? "-"}  PM=${num(log.driverPmSegmentHours) ?? "-"}`);
        console.log(`    lunchBreak (json): ${JSON.stringify(log.lunchBreak)}`);
        console.log(`    coffeeBreaks (json): ${JSON.stringify(log.coffeeBreaks)}`);
        console.log(`    autoLunchDeductionMinutes: ${log.autoLunchDeductionMinutes ?? "null"}  autoLunchApplied: ${log.autoLunchApplied}`);
        console.log(`    lunchDeductionMinutes: ${log.lunchDeductionMinutes ?? "null"}  totalBreakMinutes (coffee): ${log.totalBreakMinutes ?? "null"}`);
        console.log(`    calculatedAt: ${fmtUtc(log.calculatedAt)}`);
        console.log(`    lunch source: ${lunchSource(log, minimumLunchMins)}`);

        console.log("\n    Math checks:");
        console.log(`      segment sum = ${segSum}h`);
        console.log(`      [${passFail(net != null && Math.abs(net - segSum) <= TOLERANCE_HOURS)}] netWorkedHours (${net}) == segment sum (${segSum})`);
        console.log(`      lunch = ${lunchMin} min = ${lunchHrs}h`);
        const deducted = net != null && Math.abs(net - (segSum - lunchHrs)) <= TOLERANCE_HOURS;
        console.log(`      netWorkedHours == segment sum − lunch (${+(segSum - lunchHrs).toFixed(2)})? ${deducted ? "YES — lunch WAS deducted" : "NO — lunch was NOT deducted"}`);

        console.log(`\n    TimeLogApproval rows: ${log.approvals.length}`);
        let approvedSum = 0;
        for (const a of log.approvals) {
          const ah = num(a.actualHours);
          if (a.status === "approved" && ah != null) approvedSum += ah;
          console.log(
            `      ${a.segmentType ?? "(regular punch)"}  status=${a.status}  actualHours=${ah ?? "null"}` +
            `  editedHours=${num(a.editedHours) ?? "null"}` +
            `  window=${fmtLocal(a.segmentStart, tz)} → ${fmtLocal(a.segmentEnd, tz)}` +
            `  cutoff=${a.cutoffPeriodId ?? "null"}`
          );
        }
        if (log.approvals.some((a) => a.status === "approved")) {
          console.log(`      approved actualHours sum = ${+approvedSum.toFixed(2)}h (vs segment sum ${segSum}h)`);
        } else {
          console.log("      No approved segments yet — cutoff will read stored segment hours (lunch not subtracted).");
        }
      }
    }
  }

  // ── 2. Scope summary ────────────────────────────────────────────────────────
  console.log("\n=== 2. Scope: PadPro Driver/Aide punches with lunch recorded ===");

  const daLogs = await prisma.timeLog.findMany({
    where: {
      user: { companyId: company.id },
      punchType: { in: DA_PUNCH_TYPES },
      timeOut: { not: null },
      lunchDeductionMinutes: { gt: 0 },
    },
    orderBy: { timeIn: "asc" },
    select: {
      id: true,
      timeIn: true,
      punchType: true,
      netWorkedHours: true,
      driverAmSegmentHours: true,
      regularSegmentHours: true,
      driverPmSegmentHours: true,
      lunchBreak: true,
      autoLunchDeductionMinutes: true,
      autoLunchApplied: true,
      lunchDeductionMinutes: true,
      user: { select: { profile: { select: { firstName: true, lastName: true } } } },
    },
  });

  const notDeducted = [];
  const other = [];
  for (const log of daLogs) {
    const net = num(log.netWorkedHours);
    const segSum = segmentSum(log);
    if (net != null && Math.abs(net - segSum) <= TOLERANCE_HOURS) notDeducted.push(log);
    else other.push(log);
  }

  const totalLunchHrs = notDeducted.reduce((s, l) => s + (l.lunchDeductionMinutes ?? 0) / 60, 0);

  console.log(`  rows scanned (DA, completed, lunchDeductionMinutes > 0): ${daLogs.length}`);
  console.log(`  lunch recorded but NOT deducted (net == segment sum): ${notDeducted.length}`);
  console.log(`  other (net != segment sum, or net null): ${other.length}`);
  console.log(`  total lunch hours not deducted: ${totalLunchHrs.toFixed(2)}h`);

  const byMonth = {};
  const bySource = {};
  for (const l of notDeducted) {
    const m = moment(l.timeIn).tz(tz).format("YYYY-MM");
    byMonth[m] = byMonth[m] || { count: 0, hours: 0 };
    byMonth[m].count += 1;
    byMonth[m].hours += (l.lunchDeductionMinutes ?? 0) / 60;
    const src = lunchSource(l, minimumLunchMins).replace(/\s*\(.*\)$/, "").replace(/ [\d.]+ min.*$/, "");
    bySource[src] = (bySource[src] || 0) + 1;
  }

  console.log("\n  --- By month (local) ---");
  for (const [m, v] of Object.entries(byMonth).sort()) {
    console.log(`    ${m}: ${v.count} punches, ${v.hours.toFixed(2)}h lunch not deducted`);
  }

  console.log("\n  --- By lunch source ---");
  for (const [s, c] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s}: ${c}`);
  }

  if (other.length > 0) {
    console.log(`\n  --- "Other" rows (first ${Math.min(LIST_LIMIT, other.length)}) — worth a look ---`);
    for (const l of other.slice(0, LIST_LIMIT)) {
      console.log(
        `    ${l.id}  ${moment(l.timeIn).tz(tz).format("YYYY-MM-DD")}` +
        `  ${l.user.profile?.lastName}, ${l.user.profile?.firstName}` +
        `  net=${num(l.netWorkedHours) ?? "null"}  segSum=${segmentSum(l).toFixed(2)}  lunch=${l.lunchDeductionMinutes}min`
      );
    }
  }

  console.log(`\n  --- Most recent ${Math.min(LIST_LIMIT, notDeducted.length)} not-deducted rows ---`);
  for (const l of notDeducted.slice(-LIST_LIMIT).reverse()) {
    console.log(
      `    ${moment(l.timeIn).tz(tz).format("YYYY-MM-DD")}` +
      `  ${l.user.profile?.lastName}, ${l.user.profile?.firstName}` +
      `  ${l.punchType}  net=${num(l.netWorkedHours)}h` +
      `  lunch=${((l.lunchDeductionMinutes ?? 0) / 60).toFixed(2)}h` +
      `  source=${lunchSource(l, minimumLunchMins)}  id=${l.id}`
    );
  }

  console.log("\nDone. No changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
