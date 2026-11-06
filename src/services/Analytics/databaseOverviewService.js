// src/services/Analytics/databaseOverviewService.js
//
// BB-110: read-only database overview for the system-admin dashboard —
// storage per table, business numbers, growth, and cleanup candidates.
// Nothing here writes or deletes; actual cleanup is done by scripts the
// developer reviews and runs.

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

const DAY_MS = 24 * 60 * 60 * 1000;

// How each table should be treated. Keys are Postgres table names
// (the Prisma model name unless the model has @@map).
const CATEGORIES = {
  keep: {
    label: "Payroll & legal records — keep",
    policy: "Never delete. Payroll and timekeeping records generally must be kept 3–4+ years.",
    tables: [
      "TimeLog", "TimeLogApproval", "CutoffPeriod", "CutoffOtBlock", "CutoffFixedHours",
      "requested_time_logs", "ContestTimeLog", "Overtime",
      "PaySchedule", "PayrollRun", "PayrollEntry", "PayrollLine", "PayrollExportBatch",
      "EmployeePayrollDetails", "EmployeeEarningRate", "UserRate",
      "DisbursementBatch", "DisbursementRecipient", "DisbursementAuditEvent",
      "Leave", "LeaveDay", "LeaveBalance", "LeaveTransaction", "LeaveCredit", "LeaveCreditUsage",
    ],
  },
  core: {
    label: "Companies, people & settings",
    policy: "Live data. Removed only when a company or employee is deleted.",
    tables: [
      "Company", "User", "UserProfile", "EmploymentDetail", "Department", "Location",
      "LocationRestriction", "UserPresence", "LiveUser", "CompanyCutoffSettings",
      "DepartmentCutoffSettings", "Holiday", "Shift", "ShiftSchedule", "UserShift",
      "LeavePolicy", "LeavePolicyAssignment", "EarningType", "DeductionType",
      "PayrollConfiguration", "WithholdingTaxBracket", "ContributionBracket",
      "FederalTaxRate", "StateIncomeTaxRate", "Subscription", "SubscriptionPlan",
      "Payment", "Feedback", "AccountDeletionRequest", "SupportAgent", "SystemAdmin",
    ],
  },
  logs: {
    label: "Logs — needs a retention rule",
    policy: "Grows forever today. Trim by age once a retention window is chosen.",
    tables: ["RequestLog", "NotificationLog", "EmailNotificationLog", "UserActivity"],
  },
  temporary: {
    label: "Temporary — safe to clean routinely",
    policy: "Expired or used rows have no further use.",
    tables: ["Otp", "password_reset_tokens"],
  },
  legacy: {
    label: "Legacy — nothing writes here anymore",
    policy: "Drop in a schema cleanup if empty; back up first if not.",
    tables: ["Tax", "AttendanceSummary", "PayrollExport", "Payroll", "Deduction"],
  },
};

const TABLE_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([key, c]) => c.tables.map((t) => [t, key]))
);

const toNumber = (v) => (typeof v === "bigint" ? Number(v) : v == null ? null : Number(v));

function daysParam(value, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, 1), 3650);
}

// Postgres statistics — no table scans. Row counts are the planner's estimates.
async function getStorage() {
  const [tables, [db]] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        s.relname                              AS "table",
        s.n_live_tup                           AS "rowsEstimate",
        s.n_dead_tup                           AS "deadRows",
        pg_total_relation_size(s.relid)        AS "totalBytes",
        pg_relation_size(s.relid)              AS "tableBytes",
        pg_indexes_size(s.relid)               AS "indexBytes",
        GREATEST(s.last_vacuum, s.last_autovacuum)   AS "lastVacuum",
        GREATEST(s.last_analyze, s.last_autoanalyze) AS "lastAnalyze"
      FROM pg_stat_user_tables s
      WHERE s.schemaname = 'public'
      ORDER BY pg_total_relation_size(s.relid) DESC`,
    prisma.$queryRaw`SELECT pg_database_size(current_database()) AS "bytes"`,
  ]);

  const rows = tables.map((t) => {
    const category = TABLE_CATEGORY[t.table] || "other";
    return {
      table: t.table,
      category,
      rowsEstimate: toNumber(t.rowsEstimate),
      deadRows: toNumber(t.deadRows),
      totalBytes: toNumber(t.totalBytes),
      tableBytes: toNumber(t.tableBytes),
      indexBytes: toNumber(t.indexBytes),
      lastVacuum: t.lastVacuum,
      lastAnalyze: t.lastAnalyze,
    };
  });

  const categories = Object.entries(CATEGORIES).map(([key, c]) => {
    const inCat = rows.filter((r) => r.category === key);
    return {
      key,
      label: c.label,
      policy: c.policy,
      tableCount: inCat.length,
      totalBytes: inCat.reduce((n, r) => n + r.totalBytes, 0),
      rowsEstimate: inCat.reduce((n, r) => n + r.rowsEstimate, 0),
    };
  });

  return {
    databaseBytes: toNumber(db.bytes),
    note: "Row counts are Postgres estimates (refreshed by autovacuum/analyze).",
    categories,
    tables: rows,
  };
}

// Companies, active employees (B. Buddy excluded) and per-company activity.
async function getBusiness() {
  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const [companyCount, activeEmployees, perCompany] = await Promise.all([
    prisma.company.count(),
    prisma.user.count({ where: { ...HUMAN_ONLY, status: "active" } }),
    prisma.$queryRaw`
      SELECT
        c.id   AS "companyId",
        c.name AS "companyName",
        (SELECT COUNT(*) FROM "User" u
          WHERE u."companyId" = c.id AND u.status = 'active' AND u."isSystemAgent" = false) AS "activeEmployees",
        (SELECT COUNT(*) FROM "TimeLog" t JOIN "User" u ON u.id = t."userId"
          WHERE u."companyId" = c.id AND t."timeIn" >= ${since30}) AS "timeLogsLast30Days",
        (SELECT COUNT(*) FROM "CutoffPeriod" p
          WHERE p."companyId" = c.id AND p.status = 'open') AS "openCutoffPeriods",
        (SELECT MAX(r."createdAt") FROM "RequestLog" r
          WHERE r."companyId" = c.id) AS "lastActivityAt"
      FROM "Company" c
      ORDER BY c.name`,
  ]);

  return {
    companies: companyCount,
    activeEmployees,
    perCompany: perCompany.map((c) => ({
      companyId: c.companyId,
      companyName: c.companyName,
      activeEmployees: toNumber(c.activeEmployees),
      timeLogsLast30Days: toNumber(c.timeLogsLast30Days),
      openCutoffPeriods: toNumber(c.openCutoffPeriods),
      lastActivityAt: c.lastActivityAt,
    })),
  };
}

// Rows added in the last 7 / 30 days for the tables that grow fastest.
const GROWTH_TABLES = [
  { table: "RequestLog", model: "requestLog", field: "createdAt" },
  { table: "NotificationLog", model: "notificationLog", field: "createdAt" },
  { table: "EmailNotificationLog", model: "emailNotificationLog", field: "sentAt" },
  { table: "UserActivity", model: "userActivity", field: "createdAt" },
  { table: "TimeLog", model: "timeLog", field: "createdAt" },
  { table: "Otp", model: "otp", field: "createdAt" },
  { table: "password_reset_tokens", model: "passwordResetToken", field: "createdAt" },
];

async function getGrowth() {
  const since7 = new Date(Date.now() - 7 * DAY_MS);
  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const results = await Promise.all(
    GROWTH_TABLES.map(async ({ table, model, field }) => {
      const [last7Days, last30Days] = await Promise.all([
        prisma[model].count({ where: { [field]: { gte: since7 } } }),
        prisma[model].count({ where: { [field]: { gte: since30 } } }),
      ]);
      return { table, last7Days, last30Days, perDayAvg30: Math.round((last30Days / 30) * 10) / 10 };
    })
  );
  return results.sort((a, b) => b.last30Days - a.last30Days);
}

// How many rows each retention rule WOULD remove. Display only — nothing is deleted.
// Query (days): requestLogDays (90), auditLogDays (730), notificationDays (365),
// emailLogDays (365), activityDays (365).
async function getCleanupCandidates(query = {}) {
  const windows = {
    requestLogDays: daysParam(query.requestLogDays, 90),
    auditLogDays: daysParam(query.auditLogDays, 730),
    notificationDays: daysParam(query.notificationDays, 365),
    emailLogDays: daysParam(query.emailLogDays, 365),
    activityDays: daysParam(query.activityDays, 365),
  };
  const now = new Date();
  const before = (days) => new Date(now.getTime() - days * DAY_MS);
  const auditRow = { OR: [{ isSystemAgent: true }, { systemAdminId: { not: null } }] };

  const [
    expiredOtps,
    spentResetTokens,
    requestLogsOld,
    auditLogsOld,
    notificationsOld,
    emailLogsOld,
    activityOld,
    legacyTax,
    legacyAttendanceSummary,
    legacyPayrollExport,
    legacyPayroll,
    legacyDeduction,
  ] = await Promise.all([
    prisma.otp.count({ where: { expiresAt: { lt: now } } }),
    prisma.passwordResetToken.count({ where: { OR: [{ used: true }, { expiresAt: { lt: now } }] } }),
    prisma.requestLog.count({
      where: { createdAt: { lt: before(windows.requestLogDays) }, isSystemAgent: false, systemAdminId: null },
    }),
    prisma.requestLog.count({ where: { createdAt: { lt: before(windows.auditLogDays) }, ...auditRow } }),
    prisma.notificationLog.count({ where: { createdAt: { lt: before(windows.notificationDays) } } }),
    prisma.emailNotificationLog.count({ where: { sentAt: { lt: before(windows.emailLogDays) } } }),
    prisma.userActivity.count({ where: { createdAt: { lt: before(windows.activityDays) } } }),
    prisma.tax.count(),
    prisma.attendanceSummary.count(),
    prisma.payrollExport.count(),
    prisma.payroll.count(),
    prisma.deduction.count(),
  ]);

  return {
    windows,
    note: "Counts only. Nothing is deleted from the dashboard — cleanup runs as reviewed scripts.",
    candidates: [
      { key: "expiredOtps", table: "Otp", rule: "Expired sign-in / verification codes", rows: expiredOtps },
      { key: "spentResetTokens", table: "password_reset_tokens", rule: "Used or expired password-reset links", rows: spentResetTokens },
      { key: "requestLogs", table: "RequestLog", rule: `Ordinary request logs older than ${windows.requestLogDays} days`, rows: requestLogsOld },
      { key: "auditLogs", table: "RequestLog", rule: `B. Buddy & system-admin audit logs older than ${windows.auditLogDays} days`, rows: auditLogsOld },
      { key: "notifications", table: "NotificationLog", rule: `In-app notifications older than ${windows.notificationDays} days`, rows: notificationsOld },
      { key: "emailLogs", table: "EmailNotificationLog", rule: `Email send logs older than ${windows.emailLogDays} days`, rows: emailLogsOld },
      { key: "activity", table: "UserActivity", rule: `Activity entries older than ${windows.activityDays} days`, rows: activityOld },
    ],
    legacyTables: [
      { table: "Tax", rows: legacyTax },
      { table: "AttendanceSummary", rows: legacyAttendanceSummary },
      { table: "PayrollExport", rows: legacyPayrollExport },
      { table: "Payroll", rows: legacyPayroll },
      { table: "Deduction", rows: legacyDeduction },
    ],
  };
}

module.exports = {
  CATEGORIES,
  getStorage,
  getBusiness,
  getGrowth,
  getCleanupCandidates,
};
