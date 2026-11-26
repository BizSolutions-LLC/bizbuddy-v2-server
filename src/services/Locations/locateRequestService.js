// src/services/Locations/locateRequestService.js
//
// BB-128 phase 3b, "Locate now" (2026-11-26). On the Live map an admin clicks an
// employee's initials (or Refresh for everyone) to ask the phone for a fresh location.
//
//   POST /api/employee-map/live/:employeeId/locate   one employee
//   POST /api/employee-map/live/locate               everyone clocked in (Refresh), cap MAX_ALL
//
// Flow: server sends a SILENT data-only push LOCATE_REQUEST { requestId, timeLogId,
// companyId, expiresAt } to the employee's phone → the app takes one fix and uploads it
// through the existing POST /api/timelogs/location-breadcrumbs with source "locate" +
// requestId → markAnswered → GET /live shows locate.status "answered" and the new point.
//
// Rules (user decisions 2026-11-26):
//   - Silent: the employee sees nothing (no notification block, no inbox row).
//   - Admins + superadmins only (B. Buddy included), 404 for anyone else (same as Live).
//   - Only an OPEN punch, clocked in less than MAX_OPEN_HOURS ago, company tracking on.
//   - One request per employee per COOLDOWN_MS; an admin may send MAX_PER_ADMIN per window.
//
// Pending requests live in memory: they only matter for ~1 minute, so no table. A
// restart/deploy only drops requests in flight (the web then shows "no answer"). The
// API runs as ONE instance on Render; with several instances this would need a table.
// Who asked whom is already in RequestLog (path has the employee id; B. Buddy agentId).

const crypto = require("crypto");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { sendPush } = require("@services/notificationService");
const { EmployeeMapError, MANAGER_ROLES } = require("@services/Locations/employeeMapService");

const ANSWER_WINDOW_MS = 60 * 1000;      // the app has 60 s to answer
const COOLDOWN_MS = 30 * 1000;           // one request per employee per 30 s
const KEEP_MS = 10 * 60 * 1000;          // status stays visible on Live for 10 min
const MAX_OPEN_HOURS = 24;               // same as Live
const MAX_ALL = 50;                      // Refresh: at most this many phones per click
const MAX_PER_ADMIN = 200;               // pushes per admin per ADMIN_WINDOW_MS
const ADMIN_WINDOW_MS = 10 * 60 * 1000;

const byRequestId = new Map();  // requestId → request
const latestByLog = new Map();  // timeLogId → requestId (newest)
const adminSends = new Map();   // actorId → [timestamps]

function prune(now = Date.now()) {
  for (const [id, r] of byRequestId) {
    if (now - r.requestedAt.getTime() > KEEP_MS) {
      byRequestId.delete(id);
      if (latestByLog.get(r.timeLogId) === id) latestByLog.delete(r.timeLogId);
    }
  }
  for (const [actorId, list] of adminSends) {
    const kept = list.filter((t) => now - t < ADMIN_WINDOW_MS);
    if (kept.length) adminSends.set(actorId, kept);
    else adminSends.delete(actorId);
  }
}

function adminBudget(actorId, now) {
  const used = (adminSends.get(actorId) || []).filter((t) => now - t < ADMIN_WINDOW_MS).length;
  return Math.max(0, MAX_PER_ADMIN - used);
}

function noteAdminSend(actorId, now) {
  const list = adminSends.get(actorId) || [];
  list.push(now);
  adminSends.set(actorId, list);
}

/** Status of a request, for the API. */
function statusOf(r, now = Date.now()) {
  if (r.answeredAt) return "answered";
  if (r.pushFailed) return "not_sent";
  return now < r.expiresAt.getTime() ? "pending" : "no_answer";
}

function view(r, now = Date.now()) {
  return {
    requestId: r.requestId,
    status: statusOf(r, now),
    requestedAt: r.requestedAt,
    expiresAt: r.expiresAt,
    answeredAt: r.answeredAt || null,
  };
}

function silentLocatePush({ token, requestId, timeLogId, companyId, expiresAt }) {
  return {
    token,
    data: {
      type: "LOCATE_REQUEST",
      requestId,
      timeLogId: String(timeLogId),
      companyId: String(companyId),
      expiresAt: expiresAt.toISOString(),
    },
    android: { priority: "high" },
    apns: {
      headers: { "apns-push-type": "background", "apns-priority": "5" },
      payload: { aps: { "content-available": 1 } },
    },
  };
}

/** Company must exist and have tracking on (the app's upload is refused otherwise). */
async function loadCompany(actor) {
  if (!MANAGER_ROLES.includes(actor.role)) throw new EmployeeMapError(404, "Not found.");
  const company = await prisma.company.findUnique({
    where: { id: actor.companyId },
    select: { id: true, isActive: true, breadcrumbsEnabled: true },
  });
  if (!company) throw new EmployeeMapError(404, "Company not found.");
  if (company.isActive === false) throw new EmployeeMapError(409, "This company is inactive.");
  if (company.breadcrumbsEnabled !== true)
    throw new EmployeeMapError(409, "Location tracking is off for this company, so phones can't be located.");
  return company;
}

/** Open punches (≤ MAX_OPEN_HOURS), newest per employee, with the phone token. */
async function openPunches(companyId, { employeeId = null, departmentId = null } = {}) {
  const now = new Date();
  const logs = await prisma.timeLog.findMany({
    where: {
      timeOut: null,
      timeIn: { gte: new Date(now.getTime() - MAX_OPEN_HOURS * 3600 * 1000), lte: now },
      ...(employeeId && { userId: employeeId }),
      user: { ...HUMAN_ONLY, companyId, status: "active", ...(departmentId && { departmentId }) },
    },
    select: { id: true, timeIn: true, userId: true, user: { select: { deviceToken: true } } },
    orderBy: { timeIn: "desc" },
  });
  const byUser = new Map();
  for (const l of logs) if (!byUser.has(l.userId)) byUser.set(l.userId, l);
  return [...byUser.values()];
}

/**
 * Sends one locate request (or returns the running one inside the cooldown).
 * @returns {Promise<{ employeeId, timeLogId, sent, reused, reason, locate }>}
 */
async function requestFor(actor, log, now) {
  prune(now);
  const runningId = latestByLog.get(log.id);
  const running = runningId && byRequestId.get(runningId);
  if (running && now - running.requestedAt.getTime() < COOLDOWN_MS) {
    return { employeeId: log.userId, timeLogId: log.id, sent: false, reused: true, reason: "cooldown", locate: view(running, now) };
  }
  if (!log.user?.deviceToken) {
    return { employeeId: log.userId, timeLogId: log.id, sent: false, reused: false, reason: "no_device", locate: null };
  }
  if (adminBudget(actor.id, now) <= 0) {
    return { employeeId: log.userId, timeLogId: log.id, sent: false, reused: false, reason: "rate_limited", locate: null };
  }

  const r = {
    requestId: `loc_${crypto.randomUUID()}`,
    companyId: actor.companyId,
    employeeId: log.userId,
    timeLogId: log.id,
    requestedBy: actor.id,
    agentId: actor.agentId || null,
    requestedAt: new Date(now),
    expiresAt: new Date(now + ANSWER_WINDOW_MS),
    answeredAt: null,
    pushFailed: false,
  };
  byRequestId.set(r.requestId, r);
  latestByLog.set(r.timeLogId, r.requestId);
  noteAdminSend(actor.id, now);

  const ok = await sendPush(silentLocatePush({
    token: log.user.deviceToken, requestId: r.requestId, timeLogId: r.timeLogId,
    companyId: r.companyId, expiresAt: r.expiresAt,
  }));
  if (!ok) r.pushFailed = true;
  return {
    employeeId: log.userId, timeLogId: log.id, sent: ok, reused: false,
    reason: ok ? null : "push_failed", locate: view(r, now),
  };
}

/** POST /live/:employeeId/locate */
async function locateEmployee(actor, employeeId) {
  const company = await loadCompany(actor);
  const [log] = await openPunches(company.id, { employeeId: String(employeeId) });
  if (!log) throw new EmployeeMapError(409, "This employee isn't clocked in, so they can't be located.");
  return requestFor(actor, log, Date.now());
}

/** POST /live/locate (Refresh): everyone clocked in, optional departmentId, cap MAX_ALL. */
async function locateAll(actor, body = {}) {
  const company = await loadCompany(actor);
  const departmentId = body.departmentId ? String(body.departmentId) : null;
  const logs = await openPunches(company.id, { departmentId });
  const targets = logs.slice(0, MAX_ALL);
  const now = Date.now();
  const results = await Promise.all(targets.map((log) => requestFor(actor, log, now)));
  const count = (pred) => results.filter(pred).length;
  return {
    clockedIn: logs.length,
    requested: targets.length,
    skippedOverCap: Math.max(0, logs.length - targets.length),
    sent: count((r) => r.sent),
    reused: count((r) => r.reused),
    noDevice: count((r) => r.reason === "no_device"),
    failed: count((r) => r.reason === "push_failed"),
    rateLimited: count((r) => r.reason === "rate_limited"),
    results,
  };
}

/**
 * Upload side: a sample with source "locate" + requestId answers that request
 * (saved or duplicate). Only the request's own punch can answer it.
 */
function markAnswered(requestId, timeLogId, recordedAt) {
  const r = typeof requestId === "string" && byRequestId.get(requestId);
  if (!r || r.timeLogId !== timeLogId || r.answeredAt) return;
  r.answeredAt = new Date();
  r.answerRecordedAt = recordedAt;
}

/**
 * Live side: newest request per punch (null when none in the last KEEP_MS).
 * A normal interval point that arrives after the request also counts as an answer.
 */
function locateStatusFor(timeLogId, latestPointAt, now = Date.now()) {
  prune(now);
  const id = latestByLog.get(timeLogId);
  const r = id && byRequestId.get(id);
  if (!r) return null;
  if (!r.answeredAt && latestPointAt && new Date(latestPointAt) >= r.requestedAt) r.answeredAt = new Date(latestPointAt);
  return view(r, now);
}

module.exports = {
  locateEmployee,
  locateAll,
  markAnswered,
  locateStatusFor,
  ANSWER_WINDOW_MS,
  COOLDOWN_MS,
  MAX_ALL,
};
