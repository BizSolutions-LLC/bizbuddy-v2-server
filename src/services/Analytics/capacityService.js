// src/services/Analytics/capacityService.js
//
// BB-112: Capacity gauges for the system-admin Performance page — "do we need a
// bigger Render instance, a bigger database, or to fix specific APIs?"
//
// - startCapacitySampler(): every 5 minutes saves one ServerMetricSample (CPU,
//   memory, event-loop delay, peak in-flight requests, request rate/errors/latency,
//   DB latency and connections, connection-pool timeouts). Rows older than 30 days
//   are removed — only from this table. Runs on Render (RENDER=true) or when
//   CAPACITY_SAMPLING=true, so a laptop pointed at the same database doesn't add
//   its own samples.
// - getCapacity({ days }): three gauges (server, database, API hotspots), each with
//   a verdict (ok / watch / upgrade) and plain reasons. Read-only.

const { Prisma } = require("@prisma/client");
const { prisma } = require("@config/connection");
const monitor = require("@utils/serverMonitor");

const SAMPLE_EVERY_MS = 5 * 60 * 1000;
const KEEP_DAYS = 30;
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
      await prisma.serverMetricSample.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * DAY_MS) } } });
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

// ── Gauges ──────────────────────────────────────────────────────────────────

const VERDICT_RANK = { ok: 0, watch: 1, upgrade: 2 };
const worst = (...v) => v.reduce((a, b) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a), "ok");
const num = (v) => (v == null ? null : Number(v));
const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

async function serverGauge(since) {
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
    FROM "ServerMetricSample" WHERE "createdAt" >= ${since}`;

  const samples = Number(agg.samples);
  const cpuP95 = round1(agg.cpuP95);
  const memLimit = num(agg.memoryLimitMb);
  const rssP95 = round1(agg.rssP95);
  const memPct = memLimit && rssP95 != null ? Math.round((rssP95 / memLimit) * 100) : null;
  const cpuHotShare = samples ? Math.round((Number(agg.cpuHot) / samples) * 100) : 0;
  const loopHotShare = samples ? Math.round((Number(agg.loopHot) / samples) * 100) : 0;
  const restarts = Number(agg.restarts);

  const reasons = [];
  let verdict = "ok";
  if (cpuP95 != null && cpuP95 >= 80) {
    verdict = worst(verdict, cpuHotShare >= 10 ? "upgrade" : "watch");
    reasons.push(`CPU was at 80%+ in ${cpuHotShare}% of the time (95th percentile ${cpuP95}%).`);
  } else if (cpuP95 != null && cpuP95 >= 60) {
    verdict = worst(verdict, "watch");
    reasons.push(`CPU is getting busy (95th percentile ${cpuP95}%).`);
  }
  if (memPct != null && memPct >= 85) {
    verdict = worst(verdict, "upgrade");
    reasons.push(`Memory is at ${memPct}% of the ${memLimit} MB limit — risk of out-of-memory restarts.`);
  } else if (memPct != null && memPct >= 70) {
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
    reasons,
    samples,
    cpu: { p95Percent: cpuP95, avgPercent: round1(agg.cpuAvg), hotSharePercent: cpuHotShare },
    memory: { p95Mb: rssP95, maxMb: round1(agg.rssMax), limitMb: memLimit, p95PercentOfLimit: memPct },
    eventLoop: { p95Ms: round1(agg.loopP95), slowSharePercent: loopHotShare },
    inFlight: { max: num(agg.inFlightMax), p95: round1(agg.inFlightP95) },
    restarts,
    now: monitor.getProcessStats(),
  };
}

async function databaseGauge(since) {
  const [agg] = await prisma.$queryRaw`
    SELECT
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "dbLatencyMs")                AS "latencyP95",
      MAX("dbConnections")                                                       AS "connMax",
      MAX("dbMaxConnections")                                                    AS "maxConnections",
      COALESCE(SUM("poolTimeouts"), 0)                                           AS "poolTimeouts"
    FROM "ServerMetricSample" WHERE "createdAt" >= ${since}`;

  const [stats] = await prisma.$queryRaw`
    SELECT
      pg_database_size(current_database())                                       AS "sizeBytes",
      CASE WHEN blks_hit + blks_read = 0 THEN NULL
           ELSE ROUND(100.0 * blks_hit / (blks_hit + blks_read), 2) END          AS "cacheHitPercent"
    FROM pg_stat_database WHERE datname = current_database()`;

  const live = await dbProbe();
  const maxConnections = num(agg.maxConnections) ?? live.maxConnections;
  const connMax = Math.max(num(agg.connMax) || 0, live.connections || 0);
  const connPct = maxConnections ? Math.round((connMax / maxConnections) * 100) : null;
  const latencyP95 = round1(agg.latencyP95);
  const poolTimeouts = Number(agg.poolTimeouts);
  const sizeMb = Math.round(Number(stats.sizeBytes) / 1024 / 1024);
  const storageLimitMb = Number(process.env.DB_STORAGE_LIMIT_MB) || null;
  const storagePct = storageLimitMb ? Math.round((sizeMb / storageLimitMb) * 100) : null;
  const cacheHit = num(stats.cacheHitPercent);

  const reasons = [];
  let verdict = "ok";
  if (!live.ok) {
    verdict = "upgrade";
    reasons.push("The database isn't responding right now.");
  }
  if (poolTimeouts > 0) {
    verdict = worst(verdict, poolTimeouts >= 10 ? "upgrade" : "watch");
    reasons.push(`${poolTimeouts} request(s) timed out waiting for a database connection — requests are queueing for the database.`);
  }
  if (connPct != null && connPct >= 80) {
    verdict = worst(verdict, "upgrade");
    reasons.push(`Connections peaked at ${connMax} of ${maxConnections} (${connPct}%).`);
  } else if (connPct != null && connPct >= 60) {
    verdict = worst(verdict, "watch");
    reasons.push(`Connections peaked at ${connMax} of ${maxConnections} (${connPct}%).`);
  }
  if (latencyP95 != null && latencyP95 >= 50) {
    verdict = worst(verdict, latencyP95 >= 150 ? "upgrade" : "watch");
    reasons.push(`A trivial query takes ${latencyP95} ms at the 95th percentile — the database is busy or far away.`);
  }
  if (cacheHit != null && cacheHit < 95) {
    verdict = worst(verdict, cacheHit < 90 ? "upgrade" : "watch");
    reasons.push(`Only ${cacheHit}% of reads come from memory — the database plan may need more RAM.`);
  }
  if (storagePct != null && storagePct >= 70) {
    verdict = worst(verdict, storagePct >= 85 ? "upgrade" : "watch");
    reasons.push(`Storage is at ${storagePct}% of the ${storageLimitMb} MB plan (see the Database page for cleanup).`);
  }

  return {
    verdict,
    reasons,
    latency: { nowMs: live.latencyMs, p95Ms: latencyP95 },
    connections: { now: live.connections, peak: connMax || null, max: maxConnections, peakPercent: connPct },
    poolTimeouts,
    storage: { sizeMb, limitMb: storageLimitMb, percent: storagePct },
    cacheHitPercent: cacheHit,
  };
}

async function hotspotsGauge(since, previousSince) {
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
    WHERE "createdAt" >= ${since} AND endpoint IS NOT NULL
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
    SELECT COALESCE(SUM("responseTime"), 0) AS "total" FROM "RequestLog" WHERE "createdAt" >= ${since}`;
  const totalMs = Number(total) || 0;

  const endpoints = rows.map((r) => {
    const p95 = num(r.p95Ms);
    const before = prev.get(`${r.method} ${r.endpoint}`) ?? null;
    return {
      endpoint: r.endpoint,
      method: r.method,
      calls: num(r.calls),
      avgMs: num(r.avgMs),
      p95Ms: p95,
      previousP95Ms: before,
      p95ChangePercent: before ? Math.round(((p95 - before) / before) * 100) : null,
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
  for (const e of endpoints.filter((x) => x.p95Ms >= 3000 && x.calls >= 20).slice(0, 3)) {
    verdict = worst(verdict, "watch");
    reasons.push(`${e.method} ${e.endpoint} is slow: 95% finish under ${e.p95Ms} ms (${e.calls} calls).`);
  }
  for (const e of endpoints.filter((x) => x.p95ChangePercent >= 50 && x.calls >= 20).slice(0, 3)) {
    verdict = worst(verdict, "watch");
    reasons.push(`${e.method} ${e.endpoint} got ${e.p95ChangePercent}% slower than the previous period.`);
  }

  return { verdict, reasons, totalServerTimeMs: totalMs, endpoints };
}

/**
 * GET /api/system-admin/capacity?days=7 (1–30)
 */
async function getCapacity({ days } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), KEEP_DAYS);
  const since = new Date(Date.now() - d * DAY_MS);
  const previousSince = new Date(since.getTime() - d * DAY_MS);

  const [server, database, hotspots] = await Promise.all([
    serverGauge(since).catch(missingTable),
    databaseGauge(since).catch(missingTable),
    hotspotsGauge(since, previousSince),
  ]);

  const overall = worst(server.verdict, database.verdict, hotspots.verdict);
  return {
    days: d,
    overall,
    recommendation:
      overall === "ok"
        ? "No action needed."
        : database.verdict === "upgrade"
          ? "The database is the bottleneck — upgrade the database plan or reduce connections first."
          : server.verdict === "upgrade"
            ? "The API server is at its limit — upgrade the Render instance."
            : hotspots.verdict !== "ok"
              ? "Fix the slow or heavy endpoints listed under API hotspots before paying for more capacity."
              : "Keep an eye on the items marked Watch.",
    sampling: { active: started, everyMinutes: SAMPLE_EVERY_MS / 60000, keepDays: KEEP_DAYS },
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

module.exports = { startCapacitySampler, getCapacity, getHistory, takeSample };
