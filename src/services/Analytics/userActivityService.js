// src/services/Analytics/userActivityService.js
//
// BB-112: User Activity Analytics for the system-admin dashboard. Read-only,
// built on RequestLog with database-side aggregates (never loads rows into
// memory). B. Buddy and system-admin traffic are excluded — this is about
// real customers' usage.

const { Prisma } = require("@prisma/client");
const { prisma } = require("@config/connection");

const DAY_MS = 24 * 60 * 60 * 1000;
const SIGN_IN_ENDPOINTS = ["/api/account/login", "/api/account/sign-in"];

// Requests made by real users (not B. Buddy, not system admins, not anonymous).
const CUSTOMER_TRAFFIC = Prisma.sql`r."userId" IS NOT NULL AND r."isSystemAgent" = false AND r."systemAdminId" IS NULL`;

// Web vs mobile app by user agent: browsers send "Mozilla/…"; the native apps'
// HTTP stacks don't (okhttp on Android, CFNetwork/Darwin on iOS, Expo/RN).
const CLIENT_KIND = Prisma.sql`
  CASE
    WHEN r."userAgent" ~* '(okhttp|cfnetwork|darwin|expo|reactnative|dart)' THEN 'app'
    WHEN r."userAgent" ILIKE 'mozilla%' THEN 'web'
    ELSE 'other'
  END`;

// Feature buckets by endpoint (normalized, ids → :id).
const FEATURE = Prisma.sql`
  CASE
    WHEN r.endpoint ~ '^/api/timelogs/(time-in|time-out|coffee-break|lunch-break)' THEN 'clock_in_out'
    WHEN r.endpoint LIKE '/api/timelogs%' THEN 'time_logs'
    WHEN r.endpoint LIKE '/api/leaves%' OR r.endpoint LIKE '/api/leave-%' THEN 'leave'
    WHEN r.endpoint LIKE '/api/overtime%' THEN 'overtime'
    WHEN r.endpoint LIKE '/api/request-punch-log%' OR r.endpoint LIKE '/api/contest-policy%' THEN 'punch_requests'
    WHEN r.endpoint LIKE '/api/cutoff%' THEN 'cutoff_approvals'
    WHEN r.endpoint LIKE '/api/payroll%' OR r.endpoint LIKE '/api/disbursements%'
      OR r.endpoint LIKE '/api/employee-payroll-details%' THEN 'payroll'
    WHEN r.endpoint LIKE '/api/shift%' OR r.endpoint LIKE '/api/usershifts%'
      OR r.endpoint LIKE '/api/schedule-import%' THEN 'schedules'
    WHEN r.endpoint LIKE '/api/employee%' OR r.endpoint LIKE '/api/employment-details%'
      OR r.endpoint LIKE '/api/departments%' THEN 'employees'
    WHEN r.endpoint LIKE '/api/reports%' OR r.endpoint LIKE '/api/analytics%' THEN 'reports'
    WHEN r.endpoint LIKE '/api/notifications%' THEN 'notifications'
    ELSE 'other'
  END`;

const toNumber = (v) => (typeof v === "bigint" ? Number(v) : v == null ? null : Number(v));

function rangeDays(value, fallback = 30) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, 1), 365);
}

function companyFilter(companyId) {
  return companyId ? Prisma.sql`AND r."companyId" = ${companyId}` : Prisma.empty;
}

/**
 * Active users and sign-ins.
 * Query: days (default 30, max 365), companyId?
 */
async function getOverview({ days, companyId } = {}) {
  const d = rangeDays(days);
  const now = new Date();
  const since = new Date(now.getTime() - d * DAY_MS);
  const since1 = new Date(now.getTime() - DAY_MS);
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const cf = companyFilter(companyId);

  const [[actives], dailyActive, clients, signIns] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COUNT(DISTINCT r."userId") FILTER (WHERE r."createdAt" >= ${since1})  AS "dau",
        COUNT(DISTINCT r."userId") FILTER (WHERE r."createdAt" >= ${since7})  AS "wau",
        COUNT(DISTINCT r."userId")                                            AS "mau"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since30} AND ${CUSTOMER_TRAFFIC} ${cf}`,
    prisma.$queryRaw`
      SELECT date_trunc('day', r."createdAt") AS "day", COUNT(DISTINCT r."userId") AS "activeUsers"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND ${CUSTOMER_TRAFFIC} ${cf}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw`
      SELECT ${CLIENT_KIND} AS "client", COUNT(DISTINCT r."userId") AS "users", COUNT(*) AS "requests"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since} AND ${CUSTOMER_TRAFFIC} ${cf}
      GROUP BY 1`,
    // Sign-ins have no token yet, so they're identified by the email/company in the body.
    prisma.$queryRaw`
      SELECT date_trunc('day', r."createdAt") AS "day",
        COUNT(*) FILTER (WHERE r."statusCode" < 400)  AS "succeeded",
        COUNT(*) FILTER (WHERE r."statusCode" >= 400) AS "failed"
      FROM "RequestLog" r
      WHERE r."createdAt" >= ${since}
        AND r.endpoint IN (${Prisma.join(SIGN_IN_ENDPOINTS)})
        AND r."isSystemAgent" = false
        ${companyId ? Prisma.sql`AND r."requestBody"->>'companyId' = ${companyId}` : Prisma.empty}
      GROUP BY 1 ORDER BY 1`,
  ]);

  return {
    days: d,
    activeUsers: { last24h: toNumber(actives.dau), last7Days: toNumber(actives.wau), last30Days: toNumber(actives.mau) },
    dailyActiveUsers: dailyActive.map((r) => ({ day: r.day, activeUsers: toNumber(r.activeUsers) })),
    clients: clients.map((r) => ({ client: r.client, users: toNumber(r.users), requests: toNumber(r.requests) })),
    signIns: signIns.map((r) => ({ day: r.day, succeeded: toNumber(r.succeeded), failed: toNumber(r.failed) })),
    note: "Web vs app is inferred from the user agent. B. Buddy and system-admin traffic are excluded.",
  };
}

/**
 * Feature usage per company: actions (writes) and views (reads) per feature.
 * Query: days (default 30), companyId?
 */
async function getFeatureUsage({ days, companyId } = {}) {
  const d = rangeDays(days);
  const since = new Date(Date.now() - d * DAY_MS);
  const rows = await prisma.$queryRaw`
    SELECT
      r."companyId"                                        AS "companyId",
      c.name                                               AS "companyName",
      ${FEATURE}                                           AS "feature",
      COUNT(*) FILTER (WHERE r.method <> 'GET')            AS "actions",
      COUNT(*) FILTER (WHERE r.method = 'GET')             AS "views",
      COUNT(DISTINCT r."userId")                           AS "users"
    FROM "RequestLog" r
    LEFT JOIN "Company" c ON c.id = r."companyId"
    WHERE r."createdAt" >= ${since} AND ${CUSTOMER_TRAFFIC} ${companyFilter(companyId)}
    GROUP BY 1, 2, 3
    ORDER BY 2, 4 DESC`;

  return {
    days: d,
    rows: rows.map((r) => ({
      companyId: r.companyId,
      companyName: r.companyName,
      feature: r.feature,
      actions: toNumber(r.actions),
      views: toNumber(r.views),
      users: toNumber(r.users),
    })),
  };
}

/**
 * Requests per hour of day, in each company's own timezone.
 * Query: days (default 30), companyId?
 */
async function getPeakHours({ days, companyId } = {}) {
  const d = rangeDays(days);
  const since = new Date(Date.now() - d * DAY_MS);
  const rows = await prisma.$queryRaw`
    SELECT
      r."companyId" AS "companyId",
      c.name        AS "companyName",
      COALESCE(c."timeZone", 'America/Los_Angeles') AS "timeZone",
      EXTRACT(HOUR FROM r."createdAt" AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'))::int AS "hour",
      COUNT(*) AS "requests",
      COUNT(DISTINCT r."userId") AS "users"
    FROM "RequestLog" r
    JOIN "Company" c ON c.id = r."companyId"
    WHERE r."createdAt" >= ${since} AND ${CUSTOMER_TRAFFIC} ${companyFilter(companyId)}
    GROUP BY 1, 2, 3, 4
    ORDER BY 2, 4`;

  return {
    days: d,
    rows: rows.map((r) => ({
      companyId: r.companyId,
      companyName: r.companyName,
      timeZone: r.timeZone,
      hour: r.hour,
      requests: toNumber(r.requests),
      users: toNumber(r.users),
    })),
  };
}

/**
 * Active accounts with no sign-in and no requests for N days (cleanup / seat review).
 * Query: days (default 30), companyId?, limit (default 200, max 1000)
 */
async function getInactiveUsers({ days, companyId, limit } = {}) {
  const d = rangeDays(days);
  const cutoff = new Date(Date.now() - d * DAY_MS);
  const take = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);

  const rows = await prisma.$queryRaw`
    SELECT * FROM (
      SELECT
        u.id AS "userId", u.email, u.role::text AS "role", u."employeeId",
        p."firstName", p."lastName",
        u."companyId", c.name AS "companyName",
        u."lastLoginAt",
        (SELECT MAX(r."createdAt") FROM "RequestLog" r WHERE r."userId" = u.id) AS "lastRequestAt",
        u."createdAt"
      FROM "User" u
      JOIN "Company" c ON c.id = u."companyId"
      LEFT JOIN "UserProfile" p ON p."userId" = u.id
      WHERE u.status = 'active' AND u."isSystemAgent" = false
        ${companyId ? Prisma.sql`AND u."companyId" = ${companyId}` : Prisma.empty}
    ) t
    WHERE COALESCE(GREATEST(t."lastLoginAt", t."lastRequestAt"), t."createdAt") < ${cutoff}
    ORDER BY COALESCE(GREATEST(t."lastLoginAt", t."lastRequestAt"), t."createdAt") ASC
    LIMIT ${take}`;

  return {
    days: d,
    rows: rows.map((r) => ({
      userId: r.userId,
      name: [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
      email: r.email,
      role: r.role,
      employeeId: r.employeeId,
      companyId: r.companyId,
      companyName: r.companyName,
      lastSeenAt: [r.lastLoginAt, r.lastRequestAt].filter(Boolean).sort((a, b) => b - a)[0] || null,
      createdAt: r.createdAt,
    })),
    note: "Never-seen accounts are judged by their creation date.",
  };
}

module.exports = {
  getOverview,
  getFeatureUsage,
  getPeakHours,
  getInactiveUsers,
};
