// src/services/Analytics/serverMonitorService.js
//
// BB-112: Live Server page — live log lines and a health snapshot. Watch-only:
// nothing here changes the server, its settings or any data.

const { prisma } = require("@config/connection");
const monitor = require("@utils/serverMonitor");

const LEVEL_FILTERS = ["error", "warn", "info"];

/**
 * Query: after (last seq the client has, default 0 = initial load),
 * level (error | warn | info), q (text search), limit (default 500, max 2000).
 */
function getLogs({ after, level, q, limit } = {}) {
  return monitor.getLines({
    after: Math.max(parseInt(after, 10) || 0, 0),
    level: LEVEL_FILTERS.includes(level) ? level : undefined,
    q: q ? String(q).slice(0, 200) : undefined,
    limit: Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000),
  });
}

async function pingDatabase() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: null, error: monitor.redact(String(error.message || error)).slice(0, 300) };
  }
}

async function getHealth() {
  const database = await pingDatabase();
  const proc = monitor.getProcessStats();
  const requests = monitor.requestStats(5);

  const warnings = [];
  if (!database.ok) warnings.push("Database is not responding.");
  if (requests.total >= 20 && requests.serverErrorRate >= 5) warnings.push(`${requests.serverErrorRate}% of requests failed with a server error in the last 5 minutes.`);
  if (requests.p95Ms !== null && requests.p95Ms > 2000) warnings.push(`Slow responses: 95% finish under ${requests.p95Ms} ms.`);
  if (proc.eventLoop.p99Ms !== null && proc.eventLoop.p99Ms > 200) warnings.push(`The server is busy (event-loop delay ${proc.eventLoop.p99Ms} ms).`);

  return {
    status: !database.ok ? "down" : warnings.length ? "degraded" : "ok",
    warnings,
    checkedAt: new Date(),
    // Render sets these automatically; none of them are secrets.
    instance: {
      service: process.env.RENDER_SERVICE_NAME || null,
      instanceId: process.env.RENDER_INSTANCE_ID || null,
      commit: process.env.RENDER_GIT_COMMIT ? process.env.RENDER_GIT_COMMIT.slice(0, 7) : null,
      branch: process.env.RENDER_GIT_BRANCH || null,
    },
    process: proc,
    database,
    requests,
    logs: (({ buffered, capacity, oldestAt, capturing }) => ({ buffered, capacity, oldestAt, capturing }))(monitor.getLines({ after: Number.MAX_SAFE_INTEGER })),
  };
}

module.exports = { getLogs, getHealth };
