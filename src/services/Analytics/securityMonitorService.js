// src/services/Analytics/securityMonitorService.js
//
// BB-112: Security Monitor & Threat Detection. Read-only — turns RequestLog
// into graded signals (critical / warning / info). It shows threats; blocking
// is done elsewhere (rate limiters, lockouts, 2FA).
//
// IP-based signals are only meaningful from the "trust proxy" fix on (before
// it, every request looked like Render's proxy). Set SECURITY_IP_RELIABLE_SINCE
// (ISO date, e.g. the v2.11.0 deploy time) so older history is ignored by the
// "new network" check.

const { Prisma } = require("@prisma/client");
const { prisma } = require("@config/connection");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SIGN_IN_ENDPOINTS = ["/api/account/login", "/api/account/sign-in"];
const ADMIN_SIGN_IN_ENDPOINTS = ["/api/system-admin/auth/login", "/api/system-admin/auth/2fa/verify", "/api/system-admin/auth/2fa/setup"];
const RESET_ENDPOINT = "/api/account/reset-password";
const SUPPORT_TIMEZONE = process.env.SUPPORT_TIMEZONE || "Asia/Manila"; // where BizBuddy support staff work

// Thresholds per window.
const T = {
  accountFailedWarn: 5,
  accountFailedCritical: 15,
  stuffingEmailsWarn: 5,
  stuffingEmailsCritical: 10,
  resetPerEmailWarn: 3,
  resetPerIpWarn: 10,
  deniedPerUserWarn: 10,
  agentWrongPinWarn: 3,
  agentWritesInfo: 300,
  adminFailedWarn: 3,
  serverErrorsWarn: 10,
  serverErrorsCritical: 50,
  floodPerHourWarn: 600,
};

const WINDOWS = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 };
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

const toNumber = (v) => (typeof v === "bigint" ? Number(v) : v == null ? null : Number(v));

function ipReliableSince() {
  const raw = process.env.SECURITY_IP_RELIABLE_SINCE;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function signal(type, severity, title, detail, extra = {}) {
  return { type, severity, title, detail, ...extra };
}

/**
 * All signals for a window. Query: timeRange (1h | 6h | 24h | 7d | 30d, default 24h)
 */
async function getSignals({ timeRange } = {}) {
  const hours = WINDOWS[timeRange] || 24;
  const now = new Date();
  const since = new Date(now.getTime() - hours * HOUR_MS);
  const historySince = new Date(since.getTime() - 30 * DAY_MS);
  const reliableSince = ipReliableSince();
  const historyFrom = reliableSince && reliableSince > historySince ? reliableSince : historySince;

  const [
    failedByAccount,
    stuffing,
    newNetwork,
    resetsByEmail,
    resetsByIp,
    deniedByUser,
    agentPins,
    agentLocks,
    agentUnassigned,
    agentOffHours,
    agentWrites,
    adminFailed,
    adminLocks,
    adminRecovery,
    adminChanges,
    serverErrors,
    floods,
  ] = await Promise.all([
    // 1. Failed sign-ins per account (email + company). B. Buddy excluded — its
    //    first step always returns 401 by design; it has its own signals below.
    prisma.$queryRaw`
      SELECT lower(r."requestBody"->>'email') AS "email", r."requestBody"->>'companyId' AS "companyId",
        COUNT(*) AS "failures", COUNT(DISTINCT r."ipAddress") AS "ips",
        MIN(r."createdAt") AS "firstSeen", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)})
        AND r."statusCode" >= 400 AND r."isSystemAgent" = false AND r."requestBody"->>'email' IS NOT NULL
      GROUP BY 1, 2
      HAVING COUNT(*) >= ${T.accountFailedWarn}
      ORDER BY 3 DESC LIMIT 50`,

    // 2. Credential stuffing: one IP failing across many different emails.
    prisma.$queryRaw`
      SELECT r."ipAddress" AS "ip", COUNT(DISTINCT lower(r."requestBody"->>'email')) AS "emails",
        COUNT(*) AS "failures", MIN(r."createdAt") AS "firstSeen", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)})
        AND r."statusCode" >= 400 AND r."ipAddress" IS NOT NULL
      GROUP BY 1
      HAVING COUNT(DISTINCT lower(r."requestBody"->>'email')) >= ${T.stuffingEmailsWarn}
      ORDER BY 2 DESC LIMIT 50`,

    // 3. Successful sign-in from a network the account hasn't used in the
    //    previous 30 days (only accounts that have history).
    prisma.$queryRaw`
      WITH recent AS (
        SELECT lower(r."requestBody"->>'email') AS email, r."requestBody"->>'companyId' AS company,
          r."ipAddress" AS ip, r."userAgent" AS ua, r."createdAt" AS at
        FROM "RequestLog" r
        WHERE r."createdAt" >= ${since} AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)})
          AND r."statusCode" < 400 AND r."ipAddress" IS NOT NULL AND r."requestBody"->>'email' IS NOT NULL
      ),
      history AS (
        SELECT lower(r."requestBody"->>'email') AS email, r."requestBody"->>'companyId' AS company,
          r."ipAddress" AS ip
        FROM "RequestLog" r
        WHERE r."createdAt" >= ${historyFrom} AND r."createdAt" < ${since}
          AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)}) AND r."statusCode" < 400
          AND r."ipAddress" IS NOT NULL AND r."requestBody"->>'email' IS NOT NULL
      )
      SELECT n.email AS "email", n.company AS "companyId", n.ip AS "ip",
        MAX(n.ua) AS "userAgent", MIN(n.at) AS "firstSeen", MAX(n.at) AS "lastSeen"
      FROM recent n
      WHERE EXISTS (SELECT 1 FROM history h WHERE h.email = n.email AND h.company IS NOT DISTINCT FROM n.company)
        AND NOT EXISTS (SELECT 1 FROM history h WHERE h.email = n.email
          AND h.company IS NOT DISTINCT FROM n.company AND h.ip = n.ip)
      GROUP BY 1, 2, 3
      ORDER BY 6 DESC LIMIT 100`,

    // 4. Password reset spikes — per email, per IP.
    prisma.$queryRaw`
      SELECT lower(r."requestBody"->>'email') AS "email", COUNT(*) AS "requests", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND r.endpoint = ${RESET_ENDPOINT} AND r.method = 'POST'
        AND r."requestBody"->>'email' IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) >= ${T.resetPerEmailWarn}
      ORDER BY 2 DESC LIMIT 50`,
    prisma.$queryRaw`
      SELECT r."ipAddress" AS "ip", COUNT(*) AS "requests", COUNT(DISTINCT lower(r."requestBody"->>'email')) AS "emails",
        MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND r.endpoint = ${RESET_ENDPOINT} AND r.method = 'POST' AND r."ipAddress" IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) >= ${T.resetPerIpWarn}
      ORDER BY 2 DESC LIMIT 50`,

    // 5. Repeated "access denied" (403) for one signed-in user (B. Buddy excluded —
    //    its employee-panel blocks are expected).
    prisma.$queryRaw`
      SELECT r."userId" AS "userId", u.email AS "email", u.role::text AS "role", c.name AS "companyName",
        COUNT(*) AS "denied", COUNT(DISTINCT r.endpoint) AS "endpoints", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r
      LEFT JOIN "User" u ON u.id = r."userId"
      LEFT JOIN "Company" c ON c.id = r."companyId"
      WHERE r."createdAt" >= ${since} AND r."statusCode" = 403 AND r."userId" IS NOT NULL AND r."isSystemAgent" = false
      GROUP BY 1, 2, 3, 4 HAVING COUNT(*) >= ${T.deniedPerUserWarn}
      ORDER BY 5 DESC LIMIT 50`,

    // 6a. B. Buddy wrong PINs per staff member (401 on sign-in, staff identified).
    prisma.$queryRaw`
      SELECT a.code AS "code", a.name AS "name", COUNT(*) AS "wrongPins", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r JOIN "SupportAgent" a ON a.id = r."agentId"
      WHERE r."createdAt" >= ${since} AND r."isSystemAgent" = true
        AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)}) AND r."statusCode" = 401
      GROUP BY 1, 2 HAVING COUNT(*) >= ${T.agentWrongPinWarn}
      ORDER BY 3 DESC`,
    // 6b. B. Buddy staff lockouts (429).
    prisma.$queryRaw`
      SELECT a.code AS "code", a.name AS "name", COUNT(*) AS "lockedAttempts", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r JOIN "SupportAgent" a ON a.id = r."agentId"
      WHERE r."createdAt" >= ${since} AND r."isSystemAgent" = true
        AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)}) AND r."statusCode" = 429
      GROUP BY 1, 2 ORDER BY 4 DESC`,
    // 6c. B. Buddy sign-in into a company the staff member isn't assigned to (403).
    prisma.$queryRaw`
      SELECT a.code AS "code", a.name AS "name", c.name AS "companyName", COUNT(*) AS "attempts", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r JOIN "SupportAgent" a ON a.id = r."agentId"
      LEFT JOIN "Company" c ON c.id = r."companyId"
      WHERE r."createdAt" >= ${since} AND r."isSystemAgent" = true
        AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)}) AND r."statusCode" = 403
      GROUP BY 1, 2, 3 ORDER BY 5 DESC`,
    // 6d. B. Buddy sign-ins outside support hours (before 6am / from 10pm, support timezone).
    prisma.$queryRaw`
      SELECT a.code AS "code", a.name AS "name", c.name AS "companyName", r."createdAt" AS "at",
        EXTRACT(HOUR FROM r."createdAt" AT TIME ZONE ${SUPPORT_TIMEZONE})::int AS "localHour"
      FROM "RequestLog" r JOIN "SupportAgent" a ON a.id = r."agentId"
      LEFT JOIN "Company" c ON c.id = r."companyId"
      WHERE r."createdAt" >= ${since} AND r."isSystemAgent" = true
        AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)}) AND r."statusCode" < 400
        AND (EXTRACT(HOUR FROM r."createdAt" AT TIME ZONE ${SUPPORT_TIMEZONE}) < 6
          OR EXTRACT(HOUR FROM r."createdAt" AT TIME ZONE ${SUPPORT_TIMEZONE}) >= 22)
      ORDER BY 4 DESC LIMIT 50`,
    // 6e. Unusually many changes by one staff member.
    prisma.$queryRaw`
      SELECT a.code AS "code", a.name AS "name", COUNT(*) AS "writes", COUNT(DISTINCT r."companyId") AS "companies",
        MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r JOIN "SupportAgent" a ON a.id = r."agentId"
      WHERE r."createdAt" >= ${since} AND r."isSystemAgent" = true AND r.method <> 'GET'
        AND r.endpoint NOT IN (${Prisma.join(SIGN_IN_ENDPOINTS)})
      GROUP BY 1, 2 HAVING COUNT(*) >= ${T.agentWritesInfo}
      ORDER BY 3 DESC`,

    // 7a. Failed system-admin sign-ins per IP (password or 2FA code).
    prisma.$queryRaw`
      SELECT r."ipAddress" AS "ip", COUNT(*) AS "failures",
        array_remove(array_agg(DISTINCT lower(r."requestBody"->>'username')), NULL) AS "usernames",
        MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND r.endpoint IN (${Prisma.join(ADMIN_SIGN_IN_ENDPOINTS)})
        AND r."statusCode" IN (401, 403)
      GROUP BY 1 HAVING COUNT(*) >= ${T.adminFailedWarn}
      ORDER BY 2 DESC LIMIT 50`,
    // 7b. System-admin lockouts.
    prisma.$queryRaw`
      SELECT r."ipAddress" AS "ip", COUNT(*) AS "attempts", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND r.endpoint IN (${Prisma.join(ADMIN_SIGN_IN_ENDPOINTS)})
        AND r."statusCode" = 429
      GROUP BY 1 ORDER BY 3 DESC`,
    // 7c. Sign-ins with a recovery code (the key is logged, its value redacted).
    prisma.$queryRaw`
      SELECT r."ipAddress" AS "ip", r."createdAt" AS "at", r."statusCode" AS "statusCode"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND r.endpoint = '/api/system-admin/auth/2fa/verify'
        AND r."requestBody"->>'recoveryCode' IS NOT NULL AND r."statusCode" < 400
      ORDER BY 2 DESC LIMIT 50`,
    // 7d. Admin account changes (new admin, 2FA reset, password reset, edits).
    prisma.$queryRaw`
      SELECT r.method AS "method", r.endpoint AS "endpoint", sa.name AS "byName", sa.username AS "byUsername",
        r."createdAt" AS "at"
      FROM "RequestLog" r LEFT JOIN "SystemAdmin" sa ON sa.id = r."systemAdminId"
      WHERE r."createdAt" >= ${since} AND r.endpoint LIKE '/api/system-admin/admins%'
        AND r.method <> 'GET' AND r."statusCode" < 400
      ORDER BY 5 DESC LIMIT 50`,

    // 8a. Server error spikes per endpoint.
    prisma.$queryRaw`
      SELECT r.endpoint AS "endpoint", r.method AS "method", COUNT(*) AS "errors", MAX(r."createdAt") AS "lastSeen"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND r."statusCode" >= 500
      GROUP BY 1, 2 HAVING COUNT(*) >= ${T.serverErrorsWarn}
      ORDER BY 3 DESC LIMIT 50`,
    // 8b. Request floods: an IP's busiest hour in the window.
    prisma.$queryRaw`
      SELECT ip AS "ip", MAX(per_hour) AS "peakPerHour", SUM(per_hour) AS "requests", MAX(hour) AS "lastHour"
      FROM (
        SELECT r."ipAddress" AS ip, date_trunc('hour', r."createdAt") AS hour, COUNT(*) AS per_hour
        FROM "RequestLog" r
        WHERE r."createdAt" >= ${since} AND r."ipAddress" IS NOT NULL
        GROUP BY 1, 2
      ) t
      GROUP BY 1 HAVING MAX(per_hour) >= ${T.floodPerHourWarn}
      ORDER BY 2 DESC LIMIT 50`,
  ]);

  const signals = [];

  for (const r of failedByAccount) {
    const n = toNumber(r.failures);
    signals.push(signal("account_failed_signins", n >= T.accountFailedCritical ? "critical" : "warning",
      "Repeated failed sign-ins on one account",
      `${n} failed sign-ins for ${r.email} from ${toNumber(r.ips)} network(s).`,
      { subject: { email: r.email, companyId: r.companyId }, count: n, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
        filters: { endpoint: "/api/account/login" } }));
  }
  for (const r of stuffing) {
    const n = toNumber(r.emails);
    signals.push(signal("credential_stuffing", n >= T.stuffingEmailsCritical ? "critical" : "warning",
      "One network failing across many accounts",
      `${r.ip} failed to sign in to ${n} different accounts (${toNumber(r.failures)} attempts).`,
      { subject: { ip: r.ip }, count: n, firstSeen: r.firstSeen, lastSeen: r.lastSeen }));
  }
  for (const r of newNetwork) {
    signals.push(signal("new_network_signin", "info",
      "Sign-in from a new network",
      `${r.email} signed in from ${r.ip}, not used by this account in the previous 30 days.`,
      { subject: { email: r.email, companyId: r.companyId, ip: r.ip, userAgent: r.userAgent },
        firstSeen: r.firstSeen, lastSeen: r.lastSeen }));
  }
  for (const r of resetsByEmail) {
    signals.push(signal("reset_spike_account", "warning", "Many password resets for one account",
      `${toNumber(r.requests)} reset requests for ${r.email}.`,
      { subject: { email: r.email }, count: toNumber(r.requests), lastSeen: r.lastSeen }));
  }
  for (const r of resetsByIp) {
    signals.push(signal("reset_spike_network", "warning", "Many password resets from one network",
      `${toNumber(r.requests)} reset requests from ${r.ip} for ${toNumber(r.emails)} email(s).`,
      { subject: { ip: r.ip }, count: toNumber(r.requests), lastSeen: r.lastSeen }));
  }
  for (const r of deniedByUser) {
    signals.push(signal("repeated_access_denied", "warning", "Repeated access denied",
      `${r.email || r.userId} (${r.role || "unknown role"}, ${r.companyName || "no company"}) was denied ${toNumber(r.denied)} times on ${toNumber(r.endpoints)} endpoint(s).`,
      { subject: { userId: r.userId, email: r.email }, count: toNumber(r.denied), lastSeen: r.lastSeen,
        filters: { userId: r.userId, statusCode: 403 } }));
  }
  for (const r of agentPins) {
    signals.push(signal("bbuddy_wrong_pin", "warning", "B. Buddy: wrong PINs",
      `${r.name} (${r.code}) entered a wrong PIN ${toNumber(r.wrongPins)} times.`,
      { subject: { agentCode: r.code }, count: toNumber(r.wrongPins), lastSeen: r.lastSeen }));
  }
  for (const r of agentLocks) {
    signals.push(signal("bbuddy_locked", "critical", "B. Buddy: staff code locked",
      `${r.name} (${r.code}) hit the PIN lockout (${toNumber(r.lockedAttempts)} blocked attempts).`,
      { subject: { agentCode: r.code }, count: toNumber(r.lockedAttempts), lastSeen: r.lastSeen }));
  }
  for (const r of agentUnassigned) {
    signals.push(signal("bbuddy_wrong_company", "warning", "B. Buddy: sign-in to an unassigned company",
      `${r.name} (${r.code}) tried to enter ${r.companyName || "a company"} they aren't assigned to (${toNumber(r.attempts)}×).`,
      { subject: { agentCode: r.code }, count: toNumber(r.attempts), lastSeen: r.lastSeen }));
  }
  for (const r of agentOffHours) {
    signals.push(signal("bbuddy_off_hours", "info", "B. Buddy: sign-in outside support hours",
      `${r.name} (${r.code}) signed in to ${r.companyName || "a company"} at ${String(r.localHour).padStart(2, "0")}:00 ${SUPPORT_TIMEZONE} time.`,
      { subject: { agentCode: r.code }, lastSeen: r.at }));
  }
  for (const r of agentWrites) {
    signals.push(signal("bbuddy_high_activity", "info", "B. Buddy: unusually many changes",
      `${r.name} (${r.code}) made ${toNumber(r.writes)} changes across ${toNumber(r.companies)} company(ies).`,
      { subject: { agentCode: r.code }, count: toNumber(r.writes), lastSeen: r.lastSeen }));
  }
  for (const r of adminFailed) {
    signals.push(signal("admin_failed_signins", "warning", "System admin: failed sign-ins",
      `${toNumber(r.failures)} failed system-admin sign-ins from ${r.ip}${r.usernames?.length ? ` (${r.usernames.join(", ")})` : ""}.`,
      { subject: { ip: r.ip }, count: toNumber(r.failures), lastSeen: r.lastSeen }));
  }
  for (const r of adminLocks) {
    signals.push(signal("admin_locked", "critical", "System admin: account locked",
      `${toNumber(r.attempts)} blocked system-admin sign-in attempts from ${r.ip}.`,
      { subject: { ip: r.ip }, count: toNumber(r.attempts), lastSeen: r.lastSeen }));
  }
  for (const r of adminRecovery) {
    signals.push(signal("admin_recovery_code", "warning", "System admin: recovery code used",
      `A system admin signed in with a recovery code from ${r.ip}. Make sure it was them.`,
      { subject: { ip: r.ip }, lastSeen: r.at }));
  }
  for (const r of adminChanges) {
    const what = r.endpoint.endsWith("/reset-2fa") ? "reset an admin's 2FA"
      : r.endpoint.endsWith("/reset-password") ? "reset an admin's password"
      : r.method === "POST" ? "added a system admin" : "changed a system admin";
    signals.push(signal("admin_account_change", "info", "System admin account change",
      `${r.byName || r.byUsername || "An admin"} ${what}.`, { lastSeen: r.at }));
  }
  for (const r of serverErrors) {
    const n = toNumber(r.errors);
    signals.push(signal("server_errors", n >= T.serverErrorsCritical ? "critical" : "warning", "Server errors",
      `${n} server errors on ${r.method} ${r.endpoint}.`,
      { subject: { endpoint: r.endpoint }, count: n, lastSeen: r.lastSeen, filters: { endpoint: r.endpoint, isFailed: true } }));
  }
  for (const r of floods) {
    signals.push(signal("request_flood", "warning", "Request flood from one network",
      `${r.ip} peaked at ${toNumber(r.peakPerHour)} requests in one hour (${toNumber(r.requests)} in the window).`,
      { subject: { ip: r.ip }, count: toNumber(r.peakPerHour), lastSeen: r.lastHour }));
  }

  signals.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0)
  );

  return {
    timeRange: Object.keys(WINDOWS).find((k) => WINDOWS[k] === hours),
    generatedAt: now,
    ipReliableSince: reliableSince,
    thresholds: T,
    supportTimeZone: SUPPORT_TIMEZONE,
    counts: {
      critical: signals.filter((s) => s.severity === "critical").length,
      warning: signals.filter((s) => s.severity === "warning").length,
      info: signals.filter((s) => s.severity === "info").length,
    },
    signals,
  };
}

module.exports = { getSignals, THRESHOLDS: T };
