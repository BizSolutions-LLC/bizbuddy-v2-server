// src/services/Analytics/capacityService.js
//
// BB-112: Capacity gauges for the system-admin Performance page — "do we need a
// bigger Render instance, a bigger database, or to fix specific APIs?"
//
// - startCapacitySampler(): every 5 minutes saves one ServerMetricSample (CPU,
//   memory, event-loop delay, peak in-flight requests, request rate/errors/latency,
//   DB latency and connections, connection-pool timeouts). Rows older than 35 days
//   are removed — only from this table (35, not 30, so the BB-113 monthly report
//   still has all of a 31-day month on the 1st). Runs on Render (RENDER=true) or when
//   CAPACITY_SAMPLING=true, so a laptop pointed at the same database doesn't add
//   its own samples.
// - getCapacity({ days }): three gauges (server, database, API hotspots), each with
//   a verdict (ok / watch / upgrade) and plain reasons. Read-only.
//   Each metric also carries a band (excellent / good / watch / terrible) from
//   THRESHOLDS; Upgrade names the next Render plan (RENDER_WEB_PLAN / RENDER_DB_PLAN)
//   and stays provisional until MIN_COVERAGE_DAYS of samples exist.

const { Prisma } = require("@prisma/client");
const { prisma } = require("@config/connection");
const { WEB_PLANS, DB_PLANS, nextPlan, currentPlans } = require("@config/renderPlans");
const monitor = require("@utils/serverMonitor");

const SAMPLE_EVERY_MS = 5 * 60 * 1000;
const KEEP_DAYS = 30; // longest window the page offers
const RETAIN_DAYS = 35; // how long samples are kept
const DAY_MS = 24 * 60 * 60 * 1000;

let started = false;
let warnedMissingTable = false;
let lastCleanupDay = null;

// ── Database probes ─────────────────────────────────────────────────────────

async function dbProbe() {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const latencyMs = Date.now() - t0;
    const [conn] = await prisma.$queryRaw`
      SELECT
        (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()) AS "connections",
        current_setting('max_connections')::int                                   AS "maxConnections"`;
    return { ok: true, latencyMs, connections: Number(conn.connections), maxConnections: Number(conn.maxConnections) };
  } catch (error) {
    return { ok: false, latencyMs: null, connections: null, maxConnections: null, error: monitor.redact(String(error.message)).slice(0, 200) };
  }
}

// ── Sampler ─────────────────────────────────────────────────────────────────

async function takeSample() {
  const proc = monitor.getProcessStats();
  const req = monitor.requestStats(5);
  const db = await dbProbe();

  try {
    await prisma.serverMetricSample.create({
      data: {
        instanceId: process.env.RENDER_INSTANCE_ID || null,
        uptimeSeconds: proc.uptimeSeconds,
        cpuPercent: proc.cpuPercentOfLimit ?? proc.cpuPercent,
        rssMb: proc.memory.rssMb,
        heapUsedMb: proc.memory.heapUsedMb,
        memoryLimitMb: proc.limits.memoryLimitMb,
        eventLoopP99Ms: proc.eventLoop.p99Ms,
        eventLoopMaxMs: proc.eventLoop.maxMs,
        inFlightPeak: monitor.takeInFlightPeak(),
        requests: req.total,
        serverErrors: req.serverErrors,
        avgMs: req.avgMs,
        p95Ms: req.p95Ms,
        dbLatencyMs: db.latencyMs,
        dbConnections: db.connections,
        dbMaxConnections: db.maxConnections,
        poolTimeouts: monitor.takePoolTimeouts(),
      },
    });

    const today = new Date().toISOString().slice(0, 10);
    if (lastCleanupDay !== today) {
      lastCleanupDay = today;
      // Only this table, only rows past the retention window.
      await prisma.serverMetricSample.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - RETAIN_DAYS * DAY_MS) } } });
    }
  } catch (error) {
    // Before scripts/bb112-server-metric-samples.sql is applied the table doesn't exist.
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn(`[BB-112] Capacity sample not saved (${error.code || "error"}): ${String(error.message).split("\n").pop()}`);
    }
  }
}

function startCapacitySampler() {
  if (started) return false;
  if (process.env.RENDER !== "true" && process.env.CAPACITY_SAMPLING !== "true") return false;
  started = true;
  setInterval(() => {
    takeSample().catch(() => {});
  }, SAMPLE_EVERY_MS).unref();
  return true;
}

// ── Thresholds ──────────────────────────────────────────────────────────────
//
// Every metric gets a band: excellent / good / watch / terrible. `bounds` are the
// upper limits of the first three bands (lower is better), or their lower limits
// when `higherIsBetter`. Returned as `thresholds` so the client draws the legend
// from the same numbers the verdicts use.

const BAND_NAMES = ["excellent", "good", "watch", "terrible"];

const THRESHOLDS = {
  server: {
    cpuP95Percent: { unit: "%", bounds: [40, 60, 80] },
    memoryP95Percent: { unit: "%", bounds: [50, 70, 85] },
    eventLoopP95Ms: { unit: "ms", bounds: [20, 50, 200] },
  },
  database: {
    // Same Render region: a trivial query should take a few ms.
    latencyP95Ms: { unit: "ms", bounds: [5, 20, 50] },
    connectionsPeakPercent: { unit: "%", bounds: [50, 60, 80] },
    poolTimeouts: { unit: "count", bounds: [1, 1, 10] },
    cacheHitPercent: { unit: "%", bounds: [99, 95, 90], higherIsBetter: true },
    storagePercent: { unit: "%", bounds: [50, 70, 85] },
  },
  endpoints: {
    // p95 response time by kind of endpoint.
    light: { unit: "ms", bounds: [200, 1000, 3000] },
    heavy: { unit: "ms", bounds: [1000, 3000, 5000] },
    long: { unit: "ms", bounds: [2000, 10000, 20000] },
    // p95 change vs the previous period of the same length.
    changePercent: { unit: "%", bounds: [0, 20, 50] },
  },
};

// Unlisted endpoints count as "light" (profile, settings, simple lists).
const ENDPOINT_CLASSES = [
  { kind: "long", test: /\/sync$|import|\/bulk|\/generate-|pdf|export|report-email|\/trigger-|recompute/i },
  {
    kind: "heavy",
    test: /\/approvals|^\/api\/cutoff-periods(\/|$)|^\/api\/timelogs|^\/api\/leaves|^\/api\/employee$|report|payroll|^\/api\/system-admin\//i,
  },
];

function band(value, spec) {
  if (value == null || !spec) return null;
  const v = Number(value);
  const i = spec.bounds.findIndex((b) => (spec.higherIsBetter ? v > b : v < b));
  return BAND_NAMES[i === -1 ? 3 : i];
}

const isBad = (b) => b === "watch" || b === "terrible";
const endpointClass = (endpoint) => ENDPOINT_CLASSES.find((c) => c.test.test(endpoint))?.kind || "light";

// Upgrade verdicts wait for one full cutoff cycle of samples.
const MIN_COVERAGE_DAYS = 14;

// ── Gauges ──────────────────────────────────────────────────────────────────

const VERDICT_RANK = { ok: 0, watch: 1, upgrade: 2 };
const worst = (...v) => v.reduce((a, b) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a), "ok");
const num = (v) => (v == null ? null : Number(v));
const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

async function serverGauge(since, until) {
  const [agg] = await prisma.$queryRaw`
    SELECT
      COUNT(*)                                                                   AS "samples",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "cpuPercent")                 AS "cpuP95",
      AVG("cpuPercent")                                                          AS "cpuAvg",
      COUNT(*) FILTER (WHERE "cpuPercent" >= 80)                                 AS "cpuHot",
      MAX("rssMb")                                                               AS "rssMax",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "rssMb")                      AS "rssP95",
      MAX("memoryLimitMb")                                                       AS "memoryLimitMb",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "eventLoopP99Ms")             AS "loopP95",
      COUNT(*) FILTER (WHERE "eventLoopP99Ms" >= 200)                            AS "loopHot",
      MAX("inFlightPeak")                                                        AS "inFlightMax",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "inFlightPeak")               AS "inFlightP95",
      COUNT(*) FILTER (WHERE "uptimeSeconds" < 330)                              AS "restarts"
    FROM "ServerMetricSample" WHERE "createdAt" >= ${since} AND "createdAt" < ${until}`;

  const T = THRESHOLDS.server;
  const samples = Number(agg.samples);
  const cpuP95 = round1(agg.cpuP95);
  const memLimit = num(agg.memoryLimitMb);
  const rssP95 = round1(agg.rssP95);
  const memPct = memLimit && rssP95 != null ? Math.round((rssP95 / memLimit) * 100) : null;
  const loopP95 = round1(agg.loopP95);
  const cpuHotShare = samples ? Math.round((Number(agg.cpuHot) / samples) * 100) : 0;
  const loopHotShare = samples ? Math.round((Number(agg.loopHot) / samples) * 100) : 0;
  const restarts = samples ? Number(agg.restarts) : null;
  const cpuBand = band(cpuP95, T.cpuP95Percent);
  const memBand = band(memPct, T.memoryP95Percent);

  const reasons = [];
  let verdict = "ok";
  let upgradeFor = null; // which resource a bigger plan should add: "cpu" | "ramMb"
  if (cpuBand === "terrible") {
    const v = cpuHotShare >= 10 ? "upgrade" : "watch";
    verdict = worst(verdict, v);
    if (v === "upgrade") upgradeFor = "cpu";
    reasons.push(`CPU was at 80%+ in ${cpuHotShare}% of the time (95th percentile ${cpuP95}%).`);
  } else if (cpuBand === "watch") {
    verdict = worst(verdict, "watch");
    reasons.push(`CPU is getting busy (95th percentile ${cpuP95}%).`);
  }
  if (memBand === "terrible") {
    verdict = worst(verdict, "upgrade");
    upgradeFor = upgradeFor || "ramMb";
    reasons.push(`Memory is at ${memPct}% of the ${memLimit} MB limit — risk of out-of-memory restarts.`);
  } else if (memBand === "watch") {
    verdict = worst(verdict, "watch");
    reasons.push(`Memory is at ${memPct}% of the ${memLimit} MB limit.`);
  }
  if (loopHotShare >= 5) {
    verdict = worst(verdict, "watch");
    reasons.push(`The server was slow to respond (event-loop delay 200 ms+) ${loopHotShare}% of the time — usually one heavy endpoint; see API hotspots.`);
  }
  if (restarts > 1) {
    verdict = worst(verdict, "watch");
    reasons.push(`${restarts} restarts in this period (deploys count too).`);
  }
  if (!samples) reasons.push("No samples yet — history starts after the SQL script is applied and the server runs on Render.");

  return {
    verdict: samples ? verdict : "ok",
    upgradeFor: samples ? upgradeFor : null,
    reasons,
    samples,
    cpu: { p95Percent: cpuP95, avgPercent: round1(agg.cpuAvg), hotSharePercent: cpuHotShare, band: cpuBand },
    memory: { p95Mb: rssP95, maxMb: round1(agg.rssMax), limitMb: memLimit, p95PercentOfLimit: memPct, band: memBand },
    eventLoop: { p95Ms: loopP95, slowSharePercent: loopHotShare, band: band(loopP95, T.eventLoopP95Ms) },
    inFlight: { max: num(agg.inFlightMax), p95: round1(agg.inFlightP95) },
    restarts,
    now: monitor.getProcessStats(),
  };
}

async function databaseGauge(since, until, dbPlan, { live: includeLive = true } = {}) {
  const [agg] = await prisma.$queryRaw`
    SELECT
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "dbLatencyMs")                AS "latencyP95",
      MAX("dbConnections")                                                       AS "connMax",
      MAX("dbMaxConnections")                                                    AS "maxConnections",
      COALESCE(SUM("poolTimeouts"), 0)                                           AS "poolTimeouts"
    FROM "ServerMetricSample" WHERE "createdAt" >= ${since} AND "createdAt" < ${until}`;

  const [stats] = await prisma.$queryRaw`
    SELECT
      pg_database_size(current_database())                                       AS "sizeBytes",
      CASE WHEN blks_hit + blks_read = 0 THEN NULL
           ELSE ROUND(100.0 * blks_hit / (blks_hit + blks_read), 2) END          AS "cacheHitPercent"
    FROM pg_stat_database WHERE datname = current_database()`;

  const T = THRESHOLDS.database;
  // Reports leave out the live probe: its latency and connection count depend on
  // where and when the report is saved (a laptop over the External URL), not on the period.
  const live = includeLive ? await dbProbe() : { ok: true, latencyMs: null, connections: null, maxConnections: null };
  const maxConnections = num(agg.maxConnections) ?? live.maxConnections;
  const connMax = Math.max(num(agg.connMax) || 0, live.connections || 0);
  const connPct = maxConnections ? Math.round((connMax / maxConnections) * 100) : null;
  const latencyP95 = round1(agg.latencyP95);
  const poolTimeouts = Number(agg.poolTimeouts);
  const sizeMb = Math.round(Number(stats.sizeBytes) / 1024 / 1024);
  const storageLimitMb = Number(process.env.DB_STORAGE_LIMIT_MB) || null;
  const storagePct = storageLimitMb ? Math.round((sizeMb / storageLimitMb) * 100) : null;
  const cacheHit = num(stats.cacheHitPercent);

  const bands = {
    latency: band(latencyP95, T.latencyP95Ms),
    connections: band(connPct, T.connectionsPeakPercent),
    poolTimeouts: band(poolTimeouts, T.poolTimeouts),
    cacheHit: band(cacheHit, T.cacheHitPercent),
    storage: band(storagePct, T.storagePercent),
  };

  const reasons = [];
  let verdict = "ok";
  let upgradeFor = null; // "cpu" | "ramMb" | "disk"
  const needs = (v, resource) => {
    verdict = worst(verdict, v);
    if (v === "upgrade" && !upgradeFor) upgradeFor = resource;
  };
  if (!live.ok) {
    verdict = "upgrade";
    reasons.push("The database isn't responding right now.");
  }
  if (isBad(bands.poolTimeouts)) {
    needs(bands.poolTimeouts === "terrible" ? "upgrade" : "watch", "cpu");
    reasons.push(`${poolTimeouts} request(s) timed out waiting for a database connection — requests are queueing for the database.`);
  }
  if (isBad(bands.connections)) {
    // Render scales max_connections with the plan's memory.
    needs(bands.connections === "terrible" ? "upgrade" : "watch", "ramMb");
    reasons.push(`Connections peaked at ${connMax} of ${maxConnections} (${connPct}%).`);
  }
  if (isBad(bands.cacheHit)) {
    needs(bands.cacheHit === "terrible" ? "upgrade" : "watch", "ramMb");
    reasons.push(`Only ${cacheHit}% of reads come from memory — the database plan may need more RAM.`);
  }
  if (isBad(bands.storage)) {
    needs(bands.storage === "terrible" ? "upgrade" : "watch", "disk");
    reasons.push(`Storage is at ${storagePct}% of the ${storageLimitMb} MB disk (see the Database page for cleanup).`);
  }
  if (isBad(bands.latency)) {
    // Slow SELECT 1 alone is usually the network or the URL, which a bigger plan
    // won't fix — unless the plan's CPU is tiny or another signal is also bad.
    const tinyCpu = dbPlan != null && dbPlan.cpu <= 0.1;
    const strained = isBad(bands.connections) || isBad(bands.cacheHit) || isBad(bands.storage) || poolTimeouts > 0;
    needs(bands.latency === "terrible" && (tinyCpu || strained) ? "upgrade" : "watch", "cpu");
    const causes = [];
    if (tinyCpu) causes.push(`the ${dbPlan.code} plan has only ${dbPlan.cpu} CPU, so queries wait for processor time`);
    causes.push("in the same Render region it should take under 5 ms — check that DATABASE_URL is the Internal URL, not the External one");
    reasons.push(`A trivial query takes ${latencyP95} ms at the 95th percentile — ${causes.join("; ")}.`);
  }

  return {
    verdict,
    upgradeFor,
    reasons,
    latency: { nowMs: live.latencyMs, p95Ms: latencyP95, band: bands.latency },
    connections: { now: live.connections, peak: connMax || null, max: maxConnections, peakPercent: connPct, band: bands.connections },
    poolTimeouts,
    poolTimeoutsBand: bands.poolTimeouts,
    storage: { sizeMb, limitMb: storageLimitMb, percent: storagePct, band: bands.storage },
    cacheHitPercent: cacheHit,
    cacheHitBand: bands.cacheHit,
  };
}

async function hotspotsGauge(since, previousSince, until, { maxFindings = 3 } = {}) {
  const rows = await prisma.$queryRaw`
    SELECT
      endpoint, method,
      COUNT(*)                                                              AS "calls",
      ROUND(AVG("responseTime"))                                            AS "avgMs",
      percentile_disc(0.95) WITHIN GROUP (ORDER BY "responseTime")          AS "p95Ms",
      SUM("responseTime")                                                   AS "totalMs",
      COUNT(*) FILTER (WHERE "isSlowRequest")                               AS "slow",
      COUNT(*) FILTER (WHERE "statusCode" >= 500)                           AS "serverErrors"
    FROM "RequestLog"
    WHERE "createdAt" >= ${since} AND "createdAt" < ${until} AND endpoint IS NOT NULL
    GROUP BY endpoint, method
    ORDER BY SUM("responseTime") DESC
    LIMIT 25`;

  const prevRows = rows.length
    ? await prisma.$queryRaw`
        SELECT endpoint, method,
          percentile_disc(0.95) WITHIN GROUP (ORDER BY "responseTime") AS "p95Ms"
        FROM "RequestLog"
        WHERE "createdAt" >= ${previousSince} AND "createdAt" < ${since}
          AND (endpoint, method) IN (${Prisma.join(rows.map((r) => Prisma.sql`(${r.endpoint}, ${r.method})`))})
        GROUP BY endpoint, method`
    : [];
  const prev = new Map(prevRows.map((r) => [`${r.method} ${r.endpoint}`, num(r.p95Ms)]));

  const [{ total }] = await prisma.$queryRaw`
    SELECT COALESCE(SUM("responseTime"), 0) AS "total" FROM "RequestLog"
    WHERE "createdAt" >= ${since} AND "createdAt" < ${until}`;
  const totalMs = Number(total) || 0;

  const T = THRESHOLDS.endpoints;
  const endpoints = rows.map((r) => {
    const p95 = num(r.p95Ms);
    const before = prev.get(`${r.method} ${r.endpoint}`) ?? null;
    const change = before ? Math.round(((p95 - before) / before) * 100) : null;
    const kind = endpointClass(r.endpoint);
    return {
      endpoint: r.endpoint,
      method: r.method,
      class: kind,
      calls: num(r.calls),
      avgMs: num(r.avgMs),
      p95Ms: p95,
      band: band(p95, T[kind]),
      previousP95Ms: before,
      p95ChangePercent: change,
      changeBand: band(change, T.changePercent),
      shareOfServerTimePercent: totalMs ? round1((Number(r.totalMs) / totalMs) * 100) : 0,
      slowCalls: num(r.slow),
      serverErrors: num(r.serverErrors),
    };
  });

  const reasons = [];
  let verdict = "ok";
  const top = endpoints[0];
  if (top && top.shareOfServerTimePercent >= 30) {
    verdict = worst(verdict, "watch");
    reasons.push(`${top.method} ${top.endpoint} uses ${top.shareOfServerTimePercent}% of all server time — revisit it before upgrading.`);
  }
  const slow = endpoints
    .filter((x) => isBad(x.band) && x.calls >= 20)
    .sort((a, b) => (a.band === b.band ? b.p95Ms - a.p95Ms : a.band === "terrible" ? -1 : 1));
  for (const e of slow.slice(0, maxFindings)) {
    verdict = worst(verdict, "watch");
    reasons.push(
      `${e.method} ${e.endpoint} is slow for a ${e.class} endpoint: 95% finish under ${e.p95Ms} ms (${e.calls} calls; aim for under ${T[e.class].bounds[1]} ms).`
    );
  }
  for (const e of endpoints.filter((x) => x.changeBand === "terrible" && x.calls >= 20).slice(0, maxFindings)) {
    verdict = worst(verdict, "watch");
    reasons.push(`${e.method} ${e.endpoint} got ${e.p95ChangePercent}% slower than the previous period.`);
  }

  return { verdict, reasons, totalServerTimeMs: totalMs, endpoints };
}

// How much ServerMetricSample history backs the server and database gauges.
async function coverage(since, until) {
  const [row] = await prisma.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE "createdAt" >= ${since} AND "createdAt" < ${until}) AS "samples",
      MIN("createdAt") FILTER (WHERE "createdAt" >= ${since} AND "createdAt" < ${until}) AS "from",
      MAX("createdAt") FILTER (WHERE "createdAt" >= ${since} AND "createdAt" < ${until}) AS "to",
      MIN("createdAt")                                                           AS "firstEver"
    FROM "ServerMetricSample"`.catch(() => [{}]);
  const from = row.from ? new Date(row.from) : null;
  const to = row.to ? new Date(row.to) : null;
  const historyDays = row.firstEver ? round1((Date.now() - new Date(row.firstEver).getTime()) / DAY_MS) : 0;
  return {
    samples: Number(row.samples || 0),
    from,
    to,
    coveredDays: from && to ? round1((to - from) / DAY_MS) : 0,
    requestedDays: round1((until - since) / DAY_MS),
    historyDays,
    minimumDays: MIN_COVERAGE_DAYS,
    enough: historyDays >= MIN_COVERAGE_DAYS,
  };
}

// Plan line for one service: what it runs on now and, when an upgrade is due, the cheapest fix.
function planAdvice(plans, current, upgradeFor) {
  const next = upgradeFor && upgradeFor !== "disk" ? nextPlan(plans, current, upgradeFor) : null;
  return {
    current,
    upgradeFor: upgradeFor || null,
    next,
    monthlyDelta: current && next ? next.monthly - current.monthly : null,
  };
}

function upgradeText(label, advice, storageMb) {
  if (advice.upgradeFor === "disk") {
    return `Increase the ${label} disk${storageMb ? ` (now ${storageMb} MB)` : ""} or clean up old data — the plan itself is fine.`;
  }
  if (advice.current && advice.next) {
    const what = advice.upgradeFor === "cpu" ? "CPU" : "memory";
    return `Upgrade the ${label} ${advice.current.code} → ${advice.next.code} for more ${what} (+$${advice.monthlyDelta}/mo).`;
  }
  return null;
}

/**
 * GET /api/system-admin/capacity?days=7 (1–30)
 */
async function getCapacity({ days } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), KEEP_DAYS);
  const until = new Date();
  const since = new Date(until.getTime() - d * DAY_MS);
  return { days: d, ...(await computeCapacity({ since, until, previousSince: new Date(since.getTime() - d * DAY_MS) })) };
}

/**
 * Gauges, verdicts and advice for any window — the live page (last N days) and
 * the BB-113 reports (a baseline or a 30-day period vs the one before).
 * report: true leaves out live readings, judges coverage by the samples inside
 * the window rather than all history, and lists more findings.
 */
async function computeCapacity({ since, until, previousSince, report = false }) {
  const current = currentPlans();

  const [server, database, hotspots, cover] = await Promise.all([
    serverGauge(since, until).catch(missingTable),
    databaseGauge(since, until, current.db, { live: !report }).catch(missingTable),
    hotspotsGauge(since, previousSince, until, { maxFindings: report ? 5 : 3 }),
    coverage(since, until),
  ]);
  if (report) cover.enough = cover.coveredDays >= MIN_COVERAGE_DAYS;

  const plans = {
    web: planAdvice(WEB_PLANS, current.web, server.verdict === "upgrade" ? server.upgradeFor : null),
    db: {
      ...planAdvice(DB_PLANS, current.db, database.verdict === "upgrade" ? database.upgradeFor : null),
      storageMb: database.storage?.limitMb ?? null,
    },
  };

  let recommendation =
    server.verdict === "ok" && database.verdict === "ok" && hotspots.verdict === "ok"
      ? "No action needed."
      : database.verdict === "upgrade"
        ? upgradeText("database", plans.db, plans.db.storageMb) ||
          "The database is the bottleneck — upgrade the database plan or reduce connections first."
        : server.verdict === "upgrade"
          ? upgradeText("API server", plans.web) || "The API server is at its limit — upgrade the Render instance."
          : hotspots.verdict !== "ok"
            ? "Fix the slow or heavy endpoints listed under API hotspots before paying for more capacity."
            : "Keep an eye on the items marked Watch.";

  // Too little history: an Upgrade verdict is provisional and shown as Watch.
  if (!cover.enough) {
    for (const gauge of [server, database]) {
      if (gauge.verdict === "upgrade") {
        gauge.verdict = "watch";
        gauge.provisional = "upgrade";
      }
    }
    recommendation = report
      ? `${cover.samples ? `Only ${cover.coveredDays} days of 5-minute samples in this period` : "No 5-minute samples in this period"} — server and database verdicts are provisional. ${recommendation}`
      : `Only ${cover.historyDays} of ${MIN_COVERAGE_DAYS} days of history so far — treat this as provisional. ${recommendation}`;
  }

  return {
    overall: worst(server.verdict, database.verdict, hotspots.verdict),
    recommendation,
    sampling: { active: started, everyMinutes: SAMPLE_EVERY_MS / 60000, keepDays: RETAIN_DAYS },
    coverage: cover,
    thresholds: { bands: BAND_NAMES, ...THRESHOLDS },
    plans,
    server,
    database,
    hotspots,
  };
}

// The gauges that read ServerMetricSample still answer before the SQL script is applied.
function missingTable(error) {
  if (!/ServerMetricSample/.test(String(error.message))) throw error;
  return { verdict: "ok", reasons: ["No history yet — apply scripts/bb112-server-metric-samples.sql."], samples: 0 };
}

/**
 * GET /api/system-admin/capacity/history?days=7 — the samples for charts,
 * bucketed hourly for ranges over 2 days.
 */
async function getHistory({ days } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), KEEP_DAYS);
  const since = new Date(Date.now() - d * DAY_MS);
  const bucket = d > 2 ? Prisma.sql`date_trunc('hour', "createdAt")` : Prisma.sql`"createdAt"`;
  const rows = await prisma.$queryRaw`
    SELECT ${bucket} AS "at",
      ROUND(AVG("cpuPercent")::numeric, 1)      AS "cpuPercent",
      ROUND(MAX("rssMb")::numeric, 1)           AS "rssMb",
      MAX("memoryLimitMb")                      AS "memoryLimitMb",
      ROUND(MAX("eventLoopP99Ms")::numeric, 1)  AS "eventLoopP99Ms",
      MAX("inFlightPeak")                       AS "inFlightPeak",
      SUM("requests")                           AS "requests",
      SUM("serverErrors")                       AS "serverErrors",
      MAX("p95Ms")                              AS "p95Ms",
      MAX("dbLatencyMs")                        AS "dbLatencyMs",
      MAX("dbConnections")                      AS "dbConnections",
      MAX("dbMaxConnections")                   AS "dbMaxConnections",
      SUM("poolTimeouts")                       AS "poolTimeouts"
    FROM "ServerMetricSample"
    WHERE "createdAt" >= ${since}
    GROUP BY 1 ORDER BY 1`.catch(() => []);
  return {
    days: d,
    bucket: d > 2 ? "hour" : "5 minutes",
    points: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "at" ? v : num(v)]))),
  };
}

module.exports = { startCapacitySampler, getCapacity, computeCapacity, getHistory, takeSample, THRESHOLDS, BAND_NAMES, KEEP_DAYS, RETAIN_DAYS };
