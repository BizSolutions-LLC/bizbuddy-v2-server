// src/services/Analytics/capacityReportService.js
//
// BB-113: Performance reports for checking whether changes actually helped.
// Number 0 is the Baseline: the 30 days ending when production's DATABASE_URL
// moved to Render's Internal URL (the admin enters that moment once). Periods
// 1, 2, 3… are consecutive 30-day windows from the Baseline's end, so every
// report covers the same length and compares with the period before it and with
// the Baseline. Each window is frozen once into CapacityReport — gauges, verdicts,
// the Render plans in effect, thresholds and a daily series — because
// ServerMetricSample keeps only 35 days and the plans come from today's env.
//
// - startReportJob(): daily at 00:20 Los Angeles time (and once shortly after
//   boot) saves the last finished period if it's missing or partial. Runs where
//   the sampler runs (RENDER=true or CAPACITY_SAMPLING=true).
// - saveBaseline({ endsAt }, admin) / savePeriod(number, admin) /
//   saveCurrentPeriod(admin): build or rebuild a report.
// - listReports() / getReportPdf(number).

const moment = require("moment-timezone");
const cron = require("node-cron");
const { prisma } = require("@config/connection");
const capacity = require("@services/Analytics/capacityService");
const { generateCapacityReportPDF } = require("@utils/generateCapacityReportPDF");

const REPORT_TZ = "America/Los_Angeles"; // days in charts and dates in the PDF
const PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_MS = PERIOD_DAYS * DAY_MS;

let jobStarted = false;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const NOT_SET_UP =
  "Performance reports aren't set up on this server yet. Create the CapacityReport table (docs/changelog-v2.11.1.md, Schema), then run npx prisma generate and restart the server.";
// Before the SQL script and prisma generate, the model (TypeError) or the table (P2021) is missing.
const isNotSetUp = (error) => !prisma.capacityReport || error?.code === "P2021";

// Route entry points: a missing setup answers 503 with what to run, not a raw Prisma error.
const guarded =
  (fn) =>
  async (...args) => {
    if (!prisma.capacityReport) throw httpError(503, NOT_SET_UP);
    try {
      return await fn(...args);
    } catch (error) {
      if (isNotSetUp(error)) throw httpError(503, NOT_SET_UP);
      throw error;
    }
  };
const num = (v) => (v == null ? null : Number(v));
const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

const getBaseline = () => prisma.capacityReport.findUnique({ where: { number: 0 } });

function periodWindow(baselineEnd, number) {
  const start = new Date(new Date(baselineEnd).getTime() + (number - 1) * PERIOD_MS);
  return { start, end: new Date(start.getTime() + PERIOD_MS) };
}

// The period running right now (1 = the first 30 days after the Baseline).
const currentPeriodNumber = (baselineEnd, now = new Date()) =>
  Math.floor((now.getTime() - new Date(baselineEnd).getTime()) / PERIOD_MS) + 1;

// One row per Los Angeles day: server/DB figures from the 5-minute samples,
// traffic from RequestLog. Days with no data stay in the list with nulls.
async function dailySeries(since, until) {
  const [samples, requests] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        to_char(("createdAt" AT TIME ZONE ${REPORT_TZ})::date, 'YYYY-MM-DD')     AS "day",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "cpuPercent")               AS "cpuP95",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "rssMb")                    AS "rssP95",
        MAX("memoryLimitMb")                                                     AS "memoryLimitMb",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "dbLatencyMs")              AS "dbLatencyP95",
        MAX("dbConnections")                                                     AS "dbConnectionsMax"
      FROM "ServerMetricSample"
      WHERE "createdAt" >= ${since} AND "createdAt" < ${until}
      GROUP BY 1`.catch(() => []),
    prisma.$queryRaw`
      SELECT
        to_char(("createdAt" AT TIME ZONE ${REPORT_TZ})::date, 'YYYY-MM-DD')     AS "day",
        COUNT(*)                                                                 AS "requests",
        percentile_disc(0.95) WITHIN GROUP (ORDER BY "responseTime")             AS "p95Ms",
        COUNT(*) FILTER (WHERE "statusCode" >= 500)                              AS "serverErrors"
      FROM "RequestLog"
      WHERE "createdAt" >= ${since} AND "createdAt" < ${until}
      GROUP BY 1`,
  ]);

  const byDay = new Map();
  for (let d = moment.tz(since, REPORT_TZ).startOf("day"); d.isBefore(until); d.add(1, "day")) {
    byDay.set(d.format("YYYY-MM-DD"), { day: d.format("YYYY-MM-DD") });
  }
  for (const r of samples) {
    const limit = num(r.memoryLimitMb);
    Object.assign(byDay.get(r.day) || {}, {
      cpuP95: round1(r.cpuP95),
      memoryP95Percent: limit && r.rssP95 != null ? Math.round((Number(r.rssP95) / limit) * 100) : null,
      dbLatencyP95: round1(r.dbLatencyP95),
      dbConnectionsMax: num(r.dbConnectionsMax),
    });
  }
  for (const r of requests) {
    Object.assign(byDay.get(r.day) || {}, {
      requests: num(r.requests),
      p95Ms: num(r.p95Ms),
      serverErrors: num(r.serverErrors),
    });
  }
  return [...byDay.values()];
}

// A saved report may be rebuilt while it's still running, while all of its
// samples are still kept, or if it had none (nothing to lose). Otherwise a
// rebuild would freeze a worse copy over the original.
function assertRebuildable(existing, start) {
  if (!existing || existing.isPartial) return;
  const retainedFrom = Date.now() - capacity.RETAIN_DAYS * DAY_MS;
  const hadSamples = existing.data?.capacity?.coverage?.samples > 0;
  if (hadSamples && start.getTime() < retainedFrom) {
    throw httpError(409, `${labelOf(existing)} is already saved and its 5-minute samples have since been removed, so it can't be rebuilt.`);
  }
}

async function buildAndSave({ number, start, plannedEnd, admin }) {
  const now = new Date();
  const until = new Date(Math.min(plannedEnd.getTime(), now.getTime()));
  const [report, daily] = await Promise.all([
    capacity.computeCapacity({
      since: start,
      until,
      previousSince: new Date(start.getTime() - PERIOD_MS),
      report: true,
    }),
    dailySeries(start, until),
  ]);
  delete report.server?.now; // live process stats — meaningless in a snapshot

  const row = {
    kind: number === 0 ? "baseline" : "period",
    periodStart: start,
    periodEnd: until,
    plannedEnd,
    isPartial: until < plannedEnd,
    data: { capacity: report, daily, generatedAt: now.toISOString(), savedOnRender: process.env.RENDER === "true" },
    generatedById: admin?.id || null,
    generatedBy: admin?.name || null,
  };
  const saved = await prisma.capacityReport.upsert({
    where: { number },
    create: { number, ...row },
    update: row,
  });
  return summarize(saved);
}

/**
 * POST /api/system-admin/capacity/reports/baseline  Body: { endsAt } (ISO date-time)
 * endsAt = the production deploy that switched DATABASE_URL to the Internal URL.
 * Periods are counted from it, so it can't move once a period is saved.
 */
async function saveBaseline({ endsAt } = {}, admin = null) {
  const end = endsAt ? new Date(endsAt) : null;
  if (!end || Number.isNaN(end.getTime())) throw httpError(400, "endsAt must be a date and time, e.g. 2026-10-29T01:40:00Z.");
  if (end > new Date()) throw httpError(400, "The Baseline can't end in the future.");

  const [existing, periods] = await Promise.all([getBaseline(), prisma.capacityReport.count({ where: { number: { gt: 0 } } })]);
  if (existing && periods && existing.plannedEnd.getTime() !== end.getTime()) {
    throw httpError(409, "Periods are already counted from the current Baseline, so its end can't be moved.");
  }
  const start = new Date(end.getTime() - PERIOD_MS);
  assertRebuildable(existing, start);
  return buildAndSave({ number: 0, start, plannedEnd: end, admin });
}

/**
 * POST /api/system-admin/capacity/reports/periods/:number — build or rebuild one period.
 */
async function savePeriod(number, admin = null) {
  const n = parseInt(number, 10);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, "Period must be a number from 1.");
  const baseline = await getBaseline();
  if (!baseline) throw httpError(409, "Save the Baseline first — periods are counted from its end.");
  const { start, end } = periodWindow(baseline.plannedEnd, n);
  if (start > new Date()) throw httpError(400, `Period ${n} hasn't started yet.`);
  assertRebuildable(await prisma.capacityReport.findUnique({ where: { number: n } }), start);
  return buildAndSave({ number: n, start, plannedEnd: end, admin });
}

/**
 * POST /api/system-admin/capacity/reports/current — the running period, to date.
 */
async function saveCurrentPeriod(admin = null) {
  const baseline = await getBaseline();
  if (!baseline) throw httpError(409, "Save the Baseline first — periods are counted from its end.");
  return savePeriod(currentPeriodNumber(baseline.plannedEnd), admin);
}

const labelOf = (r) => (r.number === 0 ? "The Baseline" : `Period ${r.number}`);

function summarize(r) {
  return {
    number: r.number,
    kind: r.kind,
    label: r.number === 0 ? "Baseline" : `Period ${r.number}`,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    plannedEnd: r.plannedEnd,
    isPartial: r.isPartial,
    overall: r.data?.capacity?.overall || null,
    recommendation: r.data?.capacity?.recommendation || null,
    samples: r.data?.capacity?.coverage?.samples ?? null,
    generatedBy: r.generatedBy || (r.generatedById ? null : "Scheduled job"),
    updatedAt: r.updatedAt,
  };
}

/**
 * GET /api/system-admin/capacity/reports — the Baseline, saved periods (newest
 * first) and the period running now.
 */
async function listReports() {
  const rows = await prisma.capacityReport.findMany({ orderBy: { number: "desc" } });
  const baseline = rows.find((r) => r.number === 0);
  let current = null;
  if (baseline) {
    const number = currentPeriodNumber(baseline.plannedEnd);
    const { start, end } = periodWindow(baseline.plannedEnd, number);
    current = { number, label: `Period ${number}`, periodStart: start, plannedEnd: end };
  }
  return {
    timezone: REPORT_TZ,
    periodDays: PERIOD_DAYS,
    baseline: baseline ? summarize(baseline) : null,
    current,
    reports: rows.map(summarize),
  };
}

/**
 * GET /api/system-admin/capacity/reports/:number/pdf (0 = Baseline)
 */
async function getReportPdf(number) {
  const n = parseInt(number, 10);
  if (!Number.isInteger(n) || n < 0) throw httpError(400, "Report must be 0 (Baseline) or a period number.");
  const [report, previous, baseline] = await Promise.all([
    prisma.capacityReport.findUnique({ where: { number: n } }),
    n > 1 ? prisma.capacityReport.findUnique({ where: { number: n - 1 } }) : null,
    n > 0 ? getBaseline() : null,
  ]);
  if (!report) throw httpError(404, `${n === 0 ? "The Baseline" : `Period ${n}`} isn't saved yet.`);
  const buffer = await generateCapacityReportPDF({ report, previous, baseline, timezone: REPORT_TZ });
  const name = n === 0 ? "baseline" : `period-${n}`;
  return { buffer, filename: `bizbuddy-performance-${name}${report.isPartial ? "-to-date" : ""}.pdf` };
}

// The last finished period, if it's missing or was saved while still running.
async function ensureLastPeriod() {
  try {
    const baseline = await getBaseline();
    if (!baseline) return;
    const last = currentPeriodNumber(baseline.plannedEnd) - 1;
    if (last < 1) return;
    const existing = await prisma.capacityReport.findUnique({ where: { number: last }, select: { isPartial: true } });
    if (existing && !existing.isPartial) return;
    await savePeriod(last);
    console.log(`[BB-113] Saved the Period ${last} Performance report.`);
  } catch (error) {
    const reason = isNotSetUp(error) ? NOT_SET_UP : String(error.message).split("\n").pop();
    console.warn(`[BB-113] Performance report not saved: ${reason}`);
  }
}

function startReportJob() {
  if (jobStarted) return false;
  if (process.env.RENDER !== "true" && process.env.CAPACITY_SAMPLING !== "true") return false;
  jobStarted = true;
  cron.schedule("20 0 * * *", ensureLastPeriod, { timezone: REPORT_TZ });
  setTimeout(ensureLastPeriod, 2 * 60 * 1000).unref();
  return true;
}

module.exports = {
  startReportJob,
  saveBaseline: guarded(saveBaseline),
  savePeriod: guarded(savePeriod),
  saveCurrentPeriod: guarded(saveCurrentPeriod),
  listReports: guarded(listReports),
  getReportPdf: guarded(getReportPdf),
  REPORT_TZ,
  PERIOD_DAYS,
};
