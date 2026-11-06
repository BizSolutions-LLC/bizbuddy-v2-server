// src/utils/serverMonitor.js
//
// BB-112: Live Server page for the system-admin dashboard. Watch-only.
//
// - Log capture: copies every line this process prints (console.* and the
//   winston Console transport both end up in process.stdout/stderr.write)
//   into a fixed-size in-memory buffer. Lines are redacted before they're
//   stored. Nothing is written to disk or the database, and the buffer is
//   gone on restart. The original write always runs, so Render's own logs
//   are untouched; if capture throws, the line is just skipped.
// - Request stats: per-minute counters fed by requestLogger, for the health card.
// - CPU and event-loop delay samples.
//
// Each server instance has its own buffer — with more than one instance you
// only see the one that answered.

const fs = require("fs");
const { monitorEventLoopDelay } = require("perf_hooks");

const CAPACITY = 2000;
const MAX_LINE_LENGTH = 2000;
const STATS_MINUTES = 15;
const MAX_SAMPLES_PER_MINUTE = 1000;

// Lower = more severe. http/debug only appear when NODE_ENV=development.
const LEVELS = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };

const startedAt = new Date();
const lines = [];
let seq = 0;
let installed = false;

// ── Redaction ───────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
const REDACTIONS = [
  // key: value / key=value for anything that looks like a credential
  [
    /(\b[\w-]*(?:password|passwd|secret|token|apikey|api_key|authorization|pin|otp|recoverycode|verificationcode|resetcode)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
    "$1[REDACTED]",
  ],
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, "[REDACTED_HASH]"],
  [/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/)[^@\s/]+@/gi, "$1[REDACTED]@"],
];

function redact(text) {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// ── Log capture ─────────────────────────────────────────────────────────────

const POOL_TIMEOUT = /P2024|Timed out fetching a new connection from the connection pool/;
let poolTimeouts = 0;

function detectLevel(text, stream) {
  const winston = text.slice(0, 48).match(/\b(error|warn|info|http|debug):\s/);
  if (winston) return winston[1];
  if (/❌|\b(error|exception|failed)\b/i.test(text)) return "error";
  if (/⚠|\bwarn(ing)?\b/i.test(text)) return "warn";
  // console.warn and console.error both write to stderr
  return stream === "stderr" ? "warn" : "info";
}

function capture(chunk, stream) {
  const raw = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  const text = raw.replace(ANSI, "");
  const parts = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (parts.length === 0) return;

  // BB-112: Prisma connection-pool exhaustion (requests queued waiting for a DB connection).
  if (POOL_TIMEOUT.test(text)) poolTimeouts += 1;

  // A multi-line write (e.g. a stack trace) keeps the level of its first line.
  const level = detectLevel(parts[0], stream);
  const time = new Date();
  for (const part of parts) {
    const clipped = part.length > MAX_LINE_LENGTH ? `${part.slice(0, MAX_LINE_LENGTH)}… [truncated]` : part;
    lines.push({ seq: ++seq, time, level, stream, text: redact(clipped) });
  }
  if (lines.length > CAPACITY) lines.splice(0, lines.length - CAPACITY);
}

function hook(target, stream) {
  const original = target.write.bind(target);
  target.write = function (chunk, encoding, callback) {
    try {
      capture(chunk, stream);
    } catch (_) {
      // never let capture break logging
    }
    return original(chunk, encoding, callback);
  };
}

// ── CPU / event loop sampling ───────────────────────────────────────────────

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
let loopSnapshot = { meanMs: null, p99Ms: null, maxMs: null };
let cpuPercent = null;

function startSampling() {
  loopDelay.enable();
  const toMs = (ns) => Math.round((ns / 1e6) * 10) / 10;
  setInterval(() => {
    loopSnapshot = { meanMs: toMs(loopDelay.mean), p99Ms: toMs(loopDelay.percentile(99)), maxMs: toMs(loopDelay.max) };
    loopDelay.reset();
  }, 60 * 1000).unref();

  let lastCpu = process.cpuUsage();
  let lastAt = process.hrtime.bigint();
  setInterval(() => {
    const cpu = process.cpuUsage(lastCpu);
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - lastAt) / 1000;
    cpuPercent = elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : null;
    lastCpu = process.cpuUsage();
    lastAt = now;
  }, 5 * 1000).unref();
}

/** Call once, as early as possible in server.js. */
function install() {
  if (installed) return;
  installed = true;
  hook(process.stdout, "stdout");
  hook(process.stderr, "stderr");
  startSampling();
}

// ── Container limits (Render runs the app in a cgroup) ──────────────────────

function readFirst(paths) {
  for (const p of paths) {
    try {
      return fs.readFileSync(p, "utf8").trim();
    } catch (_) {
      // not on this system
    }
  }
  return null;
}

// Memory limit in MB and CPU limit in cores; null when there is none or it can't
// be read (e.g. on a laptop). SERVER_MEMORY_LIMIT_MB / SERVER_CPU_LIMIT override.
function readContainerLimits() {
  const memRaw = readFirst(["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
  const memBytes = memRaw && /^\d+$/.test(memRaw) ? Number(memRaw) : null;
  const memoryLimitMb =
    Number(process.env.SERVER_MEMORY_LIMIT_MB) ||
    (memBytes && memBytes < 2 ** 50 ? Math.round(memBytes / 1024 / 1024) : null); // huge = unlimited

  let cpuLimit = Number(process.env.SERVER_CPU_LIMIT) || null;
  if (!cpuLimit) {
    const v2 = readFirst(["/sys/fs/cgroup/cpu.max"]); // "<quota> <period>" or "max <period>"
    if (v2 && !v2.startsWith("max")) {
      const [quota, period] = v2.split(/\s+/).map(Number);
      if (quota > 0 && period > 0) cpuLimit = quota / period;
    } else if (!v2) {
      const quota = Number(readFirst(["/sys/fs/cgroup/cpu/cpu.cfs_quota_us"]));
      const period = Number(readFirst(["/sys/fs/cgroup/cpu/cpu.cfs_period_us"]));
      if (quota > 0 && period > 0) cpuLimit = quota / period;
    }
  }
  return { memoryLimitMb, cpuLimit };
}

const limits = readContainerLimits();

// ── In-flight requests (fed by requestLogger) ───────────────────────────────

let inFlight = 0;
let inFlightPeak = 0;

function requestStarted() {
  inFlight += 1;
  if (inFlight > inFlightPeak) inFlightPeak = inFlight;
}

function requestFinished() {
  inFlight = Math.max(0, inFlight - 1);
}

// Peak since the last call, then start a new window. Used by the capacity sampler.
function takeInFlightPeak() {
  const peak = inFlightPeak;
  inFlightPeak = inFlight;
  return peak;
}

function takePoolTimeouts() {
  const n = poolTimeouts;
  poolTimeouts = 0;
  return n;
}

// ── Request stats (fed by requestLogger) ────────────────────────────────────

const minutes = new Map(); // minute number → { requests, serverErrors, clientErrors, totalMs, samples[] }

function recordRequest(statusCode, responseTime) {
  const minute = Math.floor(Date.now() / 60000);
  let bucket = minutes.get(minute);
  if (!bucket) {
    bucket = { requests: 0, serverErrors: 0, clientErrors: 0, totalMs: 0, samples: [] };
    minutes.set(minute, bucket);
    for (const key of minutes.keys()) if (key <= minute - STATS_MINUTES) minutes.delete(key);
  }
  bucket.requests += 1;
  bucket.totalMs += responseTime;
  if (statusCode >= 500) bucket.serverErrors += 1;
  else if (statusCode >= 400) bucket.clientErrors += 1;
  if (bucket.samples.length < MAX_SAMPLES_PER_MINUTE) bucket.samples.push(responseTime);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function requestStats(windowMinutes = 5) {
  const current = Math.floor(Date.now() / 60000);
  const series = [];
  let requests = 0, serverErrors = 0, clientErrors = 0, totalMs = 0;
  const samples = [];
  for (let m = current - STATS_MINUTES + 1; m <= current; m++) {
    const b = minutes.get(m) || { requests: 0, serverErrors: 0, clientErrors: 0, totalMs: 0, samples: [] };
    series.push({
      minute: new Date(m * 60000),
      requests: b.requests,
      serverErrors: b.serverErrors,
      avgMs: b.requests ? Math.round(b.totalMs / b.requests) : null,
    });
    if (m > current - windowMinutes) {
      requests += b.requests;
      serverErrors += b.serverErrors;
      clientErrors += b.clientErrors;
      totalMs += b.totalMs;
      samples.push(...b.samples);
    }
  }
  return {
    windowMinutes,
    total: requests,
    perMinute: Math.round((requests / windowMinutes) * 10) / 10,
    serverErrors,
    clientErrors,
    serverErrorRate: requests ? Math.round((serverErrors / requests) * 1000) / 10 : 0,
    avgMs: requests ? Math.round(totalMs / requests) : null,
    p95Ms: percentile(samples, 95),
    series,
  };
}

// ── Readers ─────────────────────────────────────────────────────────────────

/**
 * after: last seq the client has (0 = initial load). level: error | warn | info
 * (that level and anything more severe; omit for everything). q: text search.
 */
function getLines({ after = 0, level, q, limit = 500 } = {}) {
  const maxRank = level && LEVELS[level] !== undefined ? LEVELS[level] : Infinity;
  const needle = q ? String(q).toLowerCase() : null;
  const oldestSeq = lines.length ? lines[0].seq : seq + 1;

  const matched = lines.filter(
    (l) => l.seq > after && LEVELS[l.level] <= maxRank && (!needle || l.text.toLowerCase().includes(needle))
  );
  const truncated = matched.length > limit;

  return {
    lines: truncated ? matched.slice(-limit) : matched,
    lastSeq: seq,
    // true when lines were dropped from the buffer between two polls
    gap: after > 0 && after < oldestSeq - 1,
    truncated,
    buffered: lines.length,
    capacity: CAPACITY,
    oldestAt: lines.length ? lines[0].time : null,
    capturing: installed,
  };
}

function getProcessStats() {
  const mem = process.memoryUsage();
  const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  return {
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    environment: process.env.NODE_ENV || "development",
    memory: { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), heapTotalMb: mb(mem.heapTotal), externalMb: mb(mem.external) },
    cpuPercent,
    // BB-112: share of the container's CPU limit (100 = all of it), when known
    cpuPercentOfLimit: cpuPercent != null && limits.cpuLimit ? Math.round((cpuPercent / limits.cpuLimit) * 10) / 10 : null,
    limits,
    eventLoop: loopSnapshot,
    inFlight,
  };
}

module.exports = {
  install,
  redact,
  recordRequest,
  requestStats,
  requestStarted,
  requestFinished,
  takeInFlightPeak,
  takePoolTimeouts,
  getLines,
  getProcessStats,
};
