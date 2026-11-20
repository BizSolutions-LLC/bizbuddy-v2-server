// src/services/Security/loginEventService.js
//
// BB-137: records every sign-in attempt and sign-out as a LoginEvent, with flags
// worked out from the history BEFORE it (see the LoginEvent model):
//   platformSwitch, newDevice, sharedDevice (+ sharedWith), failedBurst.
//
// Live: the sign-in / sign-out controllers call recordSignIn / recordSignOut from
// res.on("finish"), i.e. after the response is sent. Nothing here can delay,
// change or fail a sign-in: every error is caught and only logged on the server.
// Employees are never told about it (no response field, no notification).
//
// Backfill: scripts/backfill-bb137-login-events.js calls writeLoginEvent() in
// chronological order with source "backfill" and the RequestLog id.

const { prisma } = require("@config/connection");
const { punchSource } = require("@utils/punchDeviceProof");
const { getNormalizedDeviceId } = require("@utils/mobileDeviceLogin");

const FAILED_BURST_COUNT = 3;
const FAILED_BURST_MS = 15 * 60 * 1000;
const SHARED_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

const clip = (v, n) => (v === null || v === undefined || v === "" ? null : String(v).slice(0, n));

function cleanBrowserId(v) {
  const s = clip(v, 100);
  return s && /^[A-Za-z0-9._:-]+$/.test(s) ? s : null;
}

/** mobile when a deviceId is sent, web when a browserId is sent, else by user agent. */
function platformOf({ deviceId, browserId, userAgent }) {
  if (deviceId) return "mobile";
  if (browserId) return "web";
  const src = punchSource(userAgent);
  return src === "app" ? "mobile" : src === "web" ? "web" : "other";
}

function outcomeFromStatus(status) {
  if (status >= 200 && status < 300) return "success";
  if (status === 400) return "invalid_request";
  if (status === 401) return "wrong_password";
  if (status === 403) return "inactive";
  if (status === 404) return "user_not_found";
  if (status === 429) return "agent_denied";
  return "error";
}

/** Flags from the history before `at`. */
async function computeFlags(d, at) {
  const flags = { platformSwitch: false, newDevice: false, sharedDevice: false, sharedWith: null, failedBurst: false };

  if (d.event === "sign_in" && d.outcome === "success" && d.userId) {
    const before = { lt: at };
    const prev = await prisma.loginEvent.findFirst({
      where: { userId: d.userId, event: "sign_in", outcome: "success", createdAt: before },
      orderBy: { createdAt: "desc" },
      select: { platform: true },
    });
    if (prev && prev.platform !== d.platform && prev.platform !== "other" && d.platform !== "other") {
      flags.platformSwitch = true;
    }

    const key = d.deviceId ? { deviceId: d.deviceId } : d.browserId ? { browserId: d.browserId } : null;
    if (key) {
      if (prev) {
        const seen = await prisma.loginEvent.findFirst({
          where: { userId: d.userId, outcome: "success", createdAt: before, ...key },
          select: { id: true },
        });
        flags.newDevice = !seen;
      }
      const others = await prisma.loginEvent.findMany({
        where: {
          ...key,
          outcome: "success",
          isSystemAgent: false,
          userId: { not: null, notIn: [d.userId] },
          createdAt: { gte: new Date(at.getTime() - SHARED_LOOKBACK_MS), lt: at },
        },
        distinct: ["userId"],
        select: { userId: true },
        take: 20,
      });
      if (others.length && !d.isSystemAgent) {
        flags.sharedDevice = true;
        flags.sharedWith = others.map((o) => o.userId);
      }
    }
  }

  if (d.event === "sign_in" && d.outcome !== "success" && d.email) {
    const recent = await prisma.loginEvent.count({
      where: {
        email: d.email,
        companyId: d.companyId,
        event: "sign_in",
        outcome: { not: "success" },
        createdAt: { gte: new Date(at.getTime() - FAILED_BURST_MS), lt: at },
      },
    });
    flags.failedBurst = recent + 1 >= FAILED_BURST_COUNT;
  }

  return flags;
}

// A failed sign-in carries whatever companyId the client sent, and old history can
// point at deleted companies / users. Keep the row, but only link ids that exist
// (otherwise the foreign key refuses the whole row). Small in-process cache.
const existsCache = new Map(); // "company:<id>" | "user:<id>" → { ok, at }
const EXISTS_TTL_MS = 10 * 60 * 1000;
async function existing(kind, id) {
  if (!id) return null;
  const key = `${kind}:${id}`;
  const hit = existsCache.get(key);
  if (hit && Date.now() - hit.at < EXISTS_TTL_MS) return hit.ok ? id : null;
  const row = kind === "company"
    ? await prisma.company.findUnique({ where: { id: String(id) }, select: { id: true } })
    : await prisma.user.findUnique({ where: { id: String(id) }, select: { id: true } });
  if (existsCache.size > 5000) existsCache.clear();
  existsCache.set(key, { ok: Boolean(row), at: Date.now() });
  return row ? id : null;
}

/**
 * Write one event (live or backfill). Throws on database errors; live callers
 * go through record*(), which swallow them.
 */
async function writeLoginEvent(input) {
  const d = {
    ...input,
    companyId: await existing("company", input.companyId),
    userId: await existing("user", input.userId),
  };
  const at = d.createdAt instanceof Date ? d.createdAt : new Date();
  const flags = await computeFlags(d, at);
  return prisma.loginEvent.create({
    data: {
      companyId: d.companyId || null,
      userId: d.userId || null,
      email: d.email || null,
      event: d.event,
      outcome: d.outcome,
      platform: d.platform,
      deviceId: d.deviceId || null,
      browserId: d.browserId || null,
      ipAddress: clip(d.ipAddress, 100),
      userAgent: clip(d.userAgent, 500),
      isSystemAgent: Boolean(d.isSystemAgent),
      ...flags,
      sharedWith: flags.sharedWith || undefined,
      source: d.source || "live",
      requestLogId: d.requestLogId || null,
      createdAt: at,
    },
  });
}

const ipOf = (req) => req.ip || req.socket?.remoteAddress || null;

/**
 * Live sign-in (call from res.on("finish")). `audit` is filled by the controller:
 * { user, outcome }. Never throws.
 */
async function recordSignIn(req, statusCode, audit = {}) {
  try {
    const body = { ...(req.query || {}), ...(req.body || {}) };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : null;
    const user = audit.user || null;
    const deviceId = user?.isSystemAgent ? null : getNormalizedDeviceId(body.deviceId) || null;
    const browserId = cleanBrowserId(body.browserId);
    const userAgent = req.headers["user-agent"] || null;
    await writeLoginEvent({
      companyId: user?.companyId || clip(body.companyId, 64),
      userId: user?.id || null,
      email,
      event: "sign_in",
      outcome: audit.outcome || outcomeFromStatus(statusCode),
      platform: platformOf({ deviceId, browserId, userAgent }),
      deviceId: deviceId ? clip(deviceId, 200) : null,
      browserId,
      ipAddress: ipOf(req),
      userAgent,
      isSystemAgent: Boolean(user?.isSystemAgent),
    });
  } catch (e) {
    console.error("[BB-137] recording a sign-in failed:", e.message);
  }
}

/** Live sign-out (call from res.on("finish")). Never throws. */
async function recordSignOut(req, statusCode) {
  try {
    if (!req.user?.id || statusCode >= 400) return;
    const body = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = getNormalizedDeviceId(body.deviceId) || null;
    const browserId = cleanBrowserId(body.browserId);
    const userAgent = req.headers["user-agent"] || null;
    await writeLoginEvent({
      companyId: req.user.companyId || null,
      userId: req.user.id,
      email: req.user.email ? String(req.user.email).toLowerCase() : null,
      event: "sign_out",
      outcome: "success",
      platform: platformOf({ deviceId, browserId, userAgent }),
      deviceId: deviceId ? clip(deviceId, 200) : null,
      browserId,
      ipAddress: ipOf(req),
      userAgent,
      isSystemAgent: Boolean(req.user.isSystemAgent),
    });
  } catch (e) {
    console.error("[BB-137] recording a sign-out failed:", e.message);
  }
}

module.exports = { writeLoginEvent, recordSignIn, recordSignOut, platformOf, outcomeFromStatus, cleanBrowserId };
