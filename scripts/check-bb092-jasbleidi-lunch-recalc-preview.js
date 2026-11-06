// scripts/check-bb092-jasbleidi-lunch-recalc-preview.js
//
// BB-092 step 2 — READ-ONLY preview for Jasbleidi Mendoza (Piedmont Adult Day
// Program). Driver/Aide punches never subtracted the punched lunch; the BB-092
// code fix now subtracts it from whichever segment window it falls in. This
// script shows, for each of her Driver/Aide punches with a lunch punch, what
// the corrected numbers WOULD be — before any fix script touches the data.
//
// SELECTs only. No writes. Credentials are never printed (host + db name only).
//
// Per punch it prints:
//   - lunch start/end (local) and duration; flags lunches > SUSPICIOUS_LUNCH_MIN
//   - cutoff period id + status (open / locked / processed)
//   - per segment: approval status, current hours, lunch overlap, corrected hours
//       pending  → stored TimeLog segment hours − lunch inside segment window
//       approved → actualHours − lunch inside [approvedClockIn, approvedClockOut]
//       excluded → stays 0
//   - current vs corrected netWorkedHours
//
// Usage: node scripts/check-bb092-jasbleidi-lunch-recalc-preview.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

const COMPANY_ID           = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const USER_ID              = "cmnej60ca00emnr4uz0ycfkb7"; // Jasbleidi Mendoza
const DA_PUNCH_TYPES       = ["DRIVER_AIDE", "DRIVER_AIDE_AM", "DRIVER_AIDE_PM"];
const SUSPICIOUS_LUNCH_MIN = 120;
const SEGMENT_ORDER        = ["driver_am", "regular", "driver_pm"];
const SEGMENT_FIELD        = {
  driver_am: "driverAmSegmentHours",
  regular:   "regularSegmentHours",
  driver_pm: "driverPmSegmentHours",
};

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
const r2 = (n) => +n.toFixed(2);

// Same rule as lunchOverlapMs in src/services/timeLogComputeUtils.js
function lunchOverlapHours(lunchBreak, windowStart, windowEnd) {
  if (!lunchBreak?.start || !lunchBreak?.end || !windowStart || !windowEnd) return 0;
  if (lunchBreak.auto && lunchBreak.deductible === false) return 0;
  const start = Math.max(new Date(lunchBreak.start).getTime(), new Date(windowStart).getTime());
  const end   = Math.min(new Date(lunchBreak.end).getTime(),   new Date(windowEnd).getTime());
  return Math.max(0, end - start) / 3600000;
}

async function main() {
  console.log("=== BB-092 Jasbleidi lunch recalc PREVIEW (read-only) ===");
  console.log(`DB target: ${describeDbTarget()}`);

  const company = await prisma.company.findUnique({
    where: { id: COMPANY_ID },
    select: { name: true, timeZone: true },
  });
  const user = await prisma.user.findUnique({
    where: { id: USER_ID },
    select: { companyId: true, profile: { select: { firstName: true, lastName: true } } },
  });
  if (!company || !user || user.companyId !== COMPANY_ID) {
    console.log("Company/user not found or user not in company. Aborting.");
    return;
  }
  const tz = company.timeZone || "America/Los_Angeles";
  const fmt = (d) => (d ? moment(d).tz(tz).format("hh:mm A") : "—");

  console.log(`Company: ${company.name}`);
  console.log(`Employee: ${user.profile?.firstName} ${user.profile?.lastName} (${USER_ID})`);

  const logs = await prisma.timeLog.findMany({
    where: {
      userId: USER_ID,
      punchType: { in: DA_PUNCH_TYPES },
      timeOut: { not: null },
      // lunchBreak is Json — null-filtering it needs Prisma.DbNull; filtered in JS below instead
    },
    orderBy: { timeIn: "asc" },
    include: {
      approvals: {
        include: { cutoffPeriod: { select: { id: true, status: true, periodStart: true, periodEnd: true } } },
      },
    },
  });

  const withLunch = logs.filter((l) => l.lunchBreak?.start && l.lunchBreak?.end);
  console.log(`\nDriver/Aide punches with a completed lunch: ${withLunch.length}`);

  let totalCurrent = 0;
  let totalCorrected = 0;
  const flags = [];

  for (const log of withLunch) {
    const date = moment(log.timeIn).tz(tz).format("YYYY-MM-DD");
    const lunchMin = (new Date(log.lunchBreak.end) - new Date(log.lunchBreak.start)) / 60000;
    const cutoffs = [...new Map(log.approvals.filter((a) => a.cutoffPeriod).map((a) => [a.cutoffPeriod.id, a.cutoffPeriod])).values()];

    console.log(`\n--- ${date}  TimeLog ${log.id}  (${log.punchType}) ---`);
    console.log(`  punch: ${fmt(log.timeIn)} → ${fmt(log.timeOut)}`);
    console.log(
      `  lunch: ${fmt(log.lunchBreak.start)} → ${fmt(log.lunchBreak.end)} (${lunchMin.toFixed(1)} min)` +
      (log.lunchBreak.auto ? `  [auto, deductible=${log.lunchBreak.deductible}]` : "")
    );
    for (const c of cutoffs) {
      console.log(
        `  cutoff: ${c.id}  status=${c.status}` +
        `  (${moment(c.periodStart).tz(tz).format("YYYY-MM-DD")} → ${moment(c.periodEnd).tz(tz).format("YYYY-MM-DD")})`
      );
      if (c.status !== "open") flags.push(`${date}: cutoff is ${c.status.toUpperCase()}`);
    }
    if (cutoffs.length === 0) console.log("  cutoff: (no approval rows yet)");
    if (lunchMin > SUSPICIOUS_LUNCH_MIN) flags.push(`${date}: lunch ${lunchMin.toFixed(1)} min — likely a lunch never ended`);

    let netCurrent = 0;
    let netCorrected = 0;

    for (const seg of SEGMENT_ORDER) {
      const stored = num(log[SEGMENT_FIELD[seg]]);
      const approval = log.approvals.find((a) => a.segmentType === seg);
      if (stored == null && !approval) continue;

      let current;
      let overlap;
      let basis;

      if (approval?.status === "excluded") {
        current = 0;
        overlap = 0;
        basis = "excluded";
      } else if (approval?.status === "approved") {
        current = num(approval.actualHours) ?? 0;
        overlap = lunchOverlapHours(log.lunchBreak, approval.approvedClockIn, approval.approvedClockOut);
        basis = `approved window ${fmt(approval.approvedClockIn)}–${fmt(approval.approvedClockOut)}`;
      } else {
        current = stored ?? 0;
        const winStart = approval?.segmentStart
          ? Math.max(new Date(log.timeIn).getTime(), new Date(approval.segmentStart).getTime())
          : null;
        const winEnd = approval?.segmentEnd
          ? Math.min(new Date(log.timeOut).getTime(), new Date(approval.segmentEnd).getTime())
          : null;
        overlap = winStart && winEnd && winEnd > winStart ? lunchOverlapHours(log.lunchBreak, winStart, winEnd) : 0;
        basis = approval ? `pending, window ${fmt(approval.segmentStart)}–${fmt(approval.segmentEnd)}` : "no approval row";
      }

      const corrected = Math.max(0, current - overlap);
      netCurrent += current;
      netCorrected += corrected;

      console.log(
        `    ${seg.padEnd(9)}  ${String(r2(current)).padStart(5)}h  − lunch ${r2(overlap).toFixed(2)}h` +
        `  = ${String(r2(corrected)).padStart(5)}h   (${basis})`
      );
    }

    totalCurrent += netCurrent;
    totalCorrected += netCorrected;
    console.log(`  netWorkedHours: stored=${num(log.netWorkedHours)}h  current(seg sum)=${r2(netCurrent)}h  corrected=${r2(netCorrected)}h  diff=${r2(netCorrected - netCurrent)}h`);
  }

  console.log("\n=== Totals ===");
  console.log(`  current: ${r2(totalCurrent)}h   corrected: ${r2(totalCorrected)}h   diff: ${r2(totalCorrected - totalCurrent)}h`);

  console.log("\n=== Flags (decide before running a fix) ===");
  if (flags.length === 0) console.log("  (none)");
  for (const f of flags) console.log(`  ⚠️  ${f}`);

  console.log("\nDone. No changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
