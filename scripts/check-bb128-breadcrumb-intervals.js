// scripts/check-bb128-breadcrumb-intervals.js
//
// BB-128 part 2: are GPS breadcrumbs arriving at the company's interval?
//
// The server never schedules breadcrumbs. The mobile app reads
// Company.breadcrumbsEnabled / breadcrumbIntervalMinutes and uploads points to
// POST /api/timelogs/location-breadcrumbs while the employee is clocked in.
// The server only accepts or rejects each point (rejected points are not stored),
// so the only way to check the interval is to look at what was saved.
//
// For every punch in the range (companies with breadcrumbs on), it compares the
// points expected (punch length ÷ interval) with the points saved, and lists:
// gaps, points sent too often, late first point / early last point, foreground vs
// background, fake GPS (isMocked), accuracy, upload delay (receivedAt − recordedAt)
// and any point outside the punch window (should be none).
//
// Notes:
//   - The interval is today's setting; changes aren't kept in history.
//   - Punch length is clock-in → clock-out (breaks included). An open punch is
//     measured up to now (or the auto clock-out time if that is earlier).
//   - B. Buddy (system agent) accounts are skipped.
//   - batteryLevel is counted separately: the upload code doesn't save it today,
//     so the count is expected to be 0.
//
// READ-ONLY: no writes. Raw SQL, so it works with any generated Prisma client.
//
// Usage:
//   node scripts/check-bb128-breadcrumb-intervals.js
//   node scripts/check-bb128-breadcrumb-intervals.js --from 2026-11-17 --to 2026-11-24
//   node scripts/check-bb128-breadcrumb-intervals.js --company <companyId> --user <userId> --verbose
//
//   --from / --to  dates in each company's time zone, by clock-in (default: last 7 days)
//   --company      one company (default: every company with breadcrumbs on)
//   --user         one employee
//   --verbose      print every punch, not only the ones that aren't OK

const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const GAP_FACTOR = 3; // same as the Employee Map: no point for 3 × interval = a gap
const TOO_OFTEN_FACTOR = 0.5; // median gap under half the interval = sending too often
const MIN_COVERAGE = 0.8;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const VERBOSE = process.argv.includes("--verbose");

const minutes = (ms) => ms / 60000;
const fmtMin = (m) => (m == null || !Number.isFinite(m) ? "-" : `${m.toFixed(1)}m`);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function checkDate(value, label) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--${label} must be YYYY-MM-DD`);
  }
}

function analysePunch(log, points, intervalMin, now) {
  const timeIn = new Date(log.timeIn).getTime();
  let end;
  let endLabel;
  if (log.timeOut) {
    end = new Date(log.timeOut).getTime();
    endLabel = "clock-out";
  } else {
    end = now.getTime();
    endLabel = "now (still open)";
    if (log.closeAt && new Date(log.closeAt).getTime() < end) {
      end = new Date(log.closeAt).getTime();
      endLabel = "auto clock-out time (still open)";
    }
  }
  const durationMin = Math.max(0, minutes(end - timeIn));
  const expected = Math.floor(durationMin / intervalMin);

  const times = points.map((p) => new Date(p.recordedAt).getTime());
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(minutes(times[i] - times[i - 1]));

  const longGaps = gaps.filter((g) => g > GAP_FACTOR * intervalMin);
  const shortGaps = gaps.filter((g) => g < TOO_OFTEN_FACTOR * intervalMin);
  const firstAfterIn = times.length ? minutes(times[0] - timeIn) : null;
  const lastBeforeEnd = times.length ? minutes(end - times[times.length - 1]) : null;
  const outside = times.filter(
    (t) => t < timeIn || (log.timeOut && t > new Date(log.timeOut).getTime())
  ).length;

  const sources = { foreground: 0, background: 0, unknown: 0 };
  let mocked = 0;
  let battery = 0;
  const accuracies = [];
  const delays = [];
  for (const p of points) {
    if (p.source === "foreground") sources.foreground++;
    else if (p.source === "background") sources.background++;
    else sources.unknown++;
    if (p.isMocked) mocked++;
    if (p.batteryLevel != null) battery++;
    if (p.accuracy != null) accuracies.push(Number(p.accuracy));
    if (p.receivedAt) delays.push(minutes(new Date(p.receivedAt) - new Date(p.recordedAt)));
  }

  const coverage = expected > 0 ? points.length / expected : null;
  const medianGap = median(gaps);
  const issues = [];
  let verdict;
  if (!points.length) {
    verdict = durationMin < intervalMin ? "TOO SHORT" : "NONE";
  } else {
    if (medianGap != null && medianGap < TOO_OFTEN_FACTOR * intervalMin) issues.push("TOO FREQUENT");
    const lateStart = firstAfterIn > GAP_FACTOR * intervalMin;
    const earlyStop = lastBeforeEnd > GAP_FACTOR * intervalMin;
    if (longGaps.length || lateStart || earlyStop || (coverage != null && coverage < MIN_COVERAGE)) {
      issues.push("GAPS");
    }
    if (outside) issues.push("OUTSIDE PUNCH");
    verdict = issues.length ? issues.join(" + ") : "OK";
  }

  return {
    durationMin, endLabel, expected, actual: points.length, coverage, medianGap,
    maxGap: gaps.length ? Math.max(...gaps) : null,
    longGaps: longGaps.length, shortGaps: shortGaps.length,
    firstAfterIn, lastBeforeEnd, outside, sources, mocked, battery,
    avgAccuracy: accuracies.length ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null,
    medianDelay: median(delays), maxDelay: delays.length ? Math.max(...delays) : null,
    gaps, verdict,
  };
}

async function main() {
  const fromArg = arg("from");
  const toArg = arg("to");
  const companyArg = arg("company");
  const userArg = arg("user");
  checkDate(fromArg, "from");
  checkDate(toArg, "to");
  const now = new Date();

  const companies = companyArg
    ? await prisma.$queryRaw`
        SELECT "id", "name", "timeZone", "breadcrumbsEnabled", "breadcrumbIntervalMinutes"
        FROM "Company" WHERE "id" = ${companyArg}`
    : await prisma.$queryRaw`
        SELECT "id", "name", "timeZone", "breadcrumbsEnabled", "breadcrumbIntervalMinutes"
        FROM "Company" WHERE "breadcrumbsEnabled" = true ORDER BY "name"`;

  if (!companies.length) {
    console.log(companyArg ? `Company ${companyArg} not found.` : "No company has breadcrumbs switched on.");
    return;
  }

  const totals = { punches: 0, verdicts: {}, gaps: [], battery: 0, points: 0 };

  for (const c of companies) {
    const tz = c.timeZone || "America/Los_Angeles";
    const intervalMin = Number(c.breadcrumbIntervalMinutes) || 5;
    const to = toArg ? moment.tz(toArg, tz) : moment.tz(now, tz);
    const from = fromArg ? moment.tz(fromArg, tz) : to.clone().subtract(6, "days");
    const start = from.clone().startOf("day").toDate();
    const end = to.clone().endOf("day").toDate();

    console.log("\n" + "=".repeat(90));
    console.log(`${c.name} (${c.id})`);
    console.log(`  breadcrumbs: ${c.breadcrumbsEnabled ? "ON" : "OFF"}, interval: ${intervalMin} min, zone: ${tz}`);
    console.log(`  range (clock-in): ${from.format("YYYY-MM-DD")} → ${to.format("YYYY-MM-DD")}`);

    const logs = userArg
      ? await prisma.$queryRaw`
          SELECT t."id", t."userId", t."timeIn", t."timeOut", t."status", t."punchType", t."deviceInfo",
                 u."email", p."firstName", p."lastName", l."closeAt"
          FROM "TimeLog" t
          JOIN "User" u ON u."id" = t."userId"
          LEFT JOIN "UserProfile" p ON p."userId" = u."id"
          LEFT JOIN "LiveUser" l ON l."timeLogId" = t."id"
          WHERE u."companyId" = ${c.id} AND u."isSystemAgent" = false AND u."id" = ${userArg}
            AND t."timeIn" >= ${start} AND t."timeIn" <= ${end}
          ORDER BY t."timeIn"`
      : await prisma.$queryRaw`
          SELECT t."id", t."userId", t."timeIn", t."timeOut", t."status", t."punchType", t."deviceInfo",
                 u."email", p."firstName", p."lastName", l."closeAt"
          FROM "TimeLog" t
          JOIN "User" u ON u."id" = t."userId"
          LEFT JOIN "UserProfile" p ON p."userId" = u."id"
          LEFT JOIN "LiveUser" l ON l."timeLogId" = t."id"
          WHERE u."companyId" = ${c.id} AND u."isSystemAgent" = false
            AND t."timeIn" >= ${start} AND t."timeIn" <= ${end}
          ORDER BY u."email", t."timeIn"`;

    if (!logs.length) {
      console.log("  no punches in range.");
      continue;
    }

    const ids = logs.map((l) => l.id);
    const points = await prisma.$queryRaw`
      SELECT "timeLogId", "recordedAt", "receivedAt", "accuracy", "isMocked", "source", "batteryLevel"
      FROM "LocationBreadcrumb"
      WHERE "timeLogId" = ANY(${ids})
      ORDER BY "timeLogId", "recordedAt"`;
    const byLog = new Map();
    for (const p of points) {
      if (!byLog.has(p.timeLogId)) byLog.set(p.timeLogId, []);
      byLog.get(p.timeLogId).push(p);
    }

    const withPoints = logs.filter((l) => byLog.has(l.id)).length;
    console.log(`  punches: ${logs.length}, with at least one breadcrumb: ${withPoints}, points saved: ${points.length}`);

    const none = [];
    for (const log of logs) {
      const r = analysePunch(log, byLog.get(log.id) || [], intervalMin, now);
      totals.punches++;
      totals.points += r.actual;
      totals.battery += r.battery;
      totals.gaps.push(...r.gaps);
      totals.verdicts[r.verdict] = (totals.verdicts[r.verdict] || 0) + 1;

      const who = [log.firstName, log.lastName].filter(Boolean).join(" ") || log.email;
      const inTxt = moment.tz(log.timeIn, tz).format("YYYY-MM-DD HH:mm");
      const outTxt = log.timeOut ? moment.tz(log.timeOut, tz).format("HH:mm") : "open";

      if (r.verdict === "NONE") {
        const proof = log.deviceInfo?.start?.proof;
        none.push(`    ${who} | ${inTxt} → ${outTxt} (${fmtMin(r.durationMin)}) | ${log.punchType} | source: ${proof?.source ?? "unknown (no proof)"} | punch ${log.id}`);
        continue;
      }
      if (!VERBOSE && (r.verdict === "OK" || r.verdict === "TOO SHORT")) continue;

      console.log(`\n  [${r.verdict}] ${who} | ${inTxt} → ${outTxt} | punch ${log.id}`);
      console.log(`    length ${fmtMin(r.durationMin)} (to ${r.endLabel}) | expected ~${r.expected} | saved ${r.actual} | coverage ${r.coverage == null ? "-" : Math.round(r.coverage * 100) + "%"}`);
      console.log(`    gaps: median ${fmtMin(r.medianGap)}, max ${fmtMin(r.maxGap)}, over ${GAP_FACTOR}× interval: ${r.longGaps}, under ½ interval: ${r.shortGaps}`);
      console.log(`    first point ${fmtMin(r.firstAfterIn)} after clock-in | last point ${fmtMin(r.lastBeforeEnd)} before ${r.endLabel}`);
      console.log(`    foreground ${r.sources.foreground}, background ${r.sources.background}, unknown ${r.sources.unknown} | fake GPS (isMocked) ${r.mocked} | avg accuracy ${r.avgAccuracy == null ? "-" : r.avgAccuracy.toFixed(0) + " m"}`);
      console.log(`    upload delay: median ${fmtMin(r.medianDelay)}, max ${fmtMin(r.maxDelay)} | outside punch window: ${r.outside}`);
    }

    if (none.length) {
      console.log(`\n  Punches with NO breadcrumbs (${none.length}) — web punch, location permission off, or app not sending:`);
      none.forEach((line) => console.log(line));
    }
  }

  console.log("\n" + "=".repeat(90));
  console.log("TOTALS");
  console.log(`  punches: ${totals.punches}, points saved: ${totals.points}`);
  for (const [v, n] of Object.entries(totals.verdicts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}: ${n}`);
  }
  console.log(`  median gap across all punches: ${fmtMin(median(totals.gaps))} (compare with each company's interval above)`);
  console.log(`  points with batteryLevel filled: ${totals.battery} (expected 0: the upload code doesn't save it yet)`);
  if (!VERBOSE) console.log("  (OK and TOO SHORT punches hidden; add --verbose to list them)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
