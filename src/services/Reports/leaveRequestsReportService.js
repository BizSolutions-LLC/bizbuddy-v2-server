// src/services/Reports/leaveRequestsReportService.js
//
// BB-119: the Leave Requests report, built on the server (was the client's
// lib/exports/leaveRequests.js). Reuses the BB-098 "requests" query
// (leaveReportService.requestsReport): real hours per day, paid/unpaid split,
// approver / second approver / decided by and when, credits by fiscal year.
//
// Filters the page passes: from / to (YYYY-MM-DD, company time zone; both
// optional = all dates) and status (one or more, or "all"). The free-text
// search box is ignored. Inactive employees' requests are included.
//
// Scope: admin/superadmin the whole company; supervisor their department plus
// direct reports, like the Leave Requests page (BB-072).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { COMPANY_CREDIT_SELECT } = require("@services/Leave/leaveCreditService");
const {
  ReportError,
  DEFAULT_TZ,
  REQUEST_STATUSES,
  resolveScope,
  requestsReport,
  parseList,
  isYmd,
  r2,
} = require("@services/Reports/leaveReportService");
const { resolveRequester } = require("@services/Reports/reportRequester");

const ALL_FROM = "1970-01-01";
const ALL_TO = "2999-12-31";

const STATUS_LABEL = {
  pending: "Pending",
  pending_secondary: "Pending final",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  reverted: "Reverted", // BB-125: approved, but the employee punched in — leave hours returned
};
const PAY_LABEL = { paid: "Paid", unpaid: "Unpaid", partial: "Partially paid" };

// Same rule as the client's resolveLeavePayOutcome: the actual split once decided.
function payOutcome(r) {
  if (r.isPaid == null) return null;
  if (r.status === "reverted") return null; // BB-125: nothing paid as leave — every day was worked
  if (r.status === "approved" && (r.paidHours != null || r.unpaidHours != null)) {
    const paid = Number(r.paidHours || 0);
    const unpaid = Number(r.unpaidHours || 0);
    if (paid > 0 && unpaid > 0) return "partial";
    if (unpaid > 0) return "unpaid";
    if (paid > 0) return "paid";
  }
  return r.isPaid ? "paid" : "unpaid";
}

const calendarDays = (from, to) => moment.utc(to).diff(moment.utc(from), "days") + 1;
const fmt = (ymd) => (ymd ? moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY") : null);

/**
 * @param {{ id, role, companyId, agentId? }} actor  req.user
 * @param {{ from?, to?, status? }} query
 */
async function buildLeaveRequestsReport(actor, query = {}) {
  const [company, me] = await Promise.all([
    prisma.company.findUnique({ where: { id: actor.companyId }, select: { ...COMPANY_CREDIT_SELECT, name: true } }),
    prisma.user.findUnique({ where: { id: actor.id }, select: { email: true, isSystemAgent: true, profile: { select: { firstName: true, lastName: true } } } }),
  ]);
  if (!company) throw new ReportError(404, "Company not found.");
  const tz = company.timeZone || DEFAULT_TZ;

  // ── Filters ──
  const from = query.from || null;
  const to = query.to || null;
  if (from && !isYmd(from)) throw new ReportError(400, "from must be YYYY-MM-DD");
  if (to && !isYmd(to)) throw new ReportError(400, "to must be YYYY-MM-DD");
  if (from && to && from > to) throw new ReportError(400, "from must not be after to");

  const requested = parseList(query.status).filter((s) => s !== "all");
  const status = requested.length ? requested : [...REQUEST_STATUSES];
  const bad = status.filter((s) => !REQUEST_STATUSES.includes(s));
  if (bad.length) throw new ReportError(400, `Invalid status: ${bad.join(", ")}. Allowed: all, ${REQUEST_STATUSES.join(", ")}`);

  const f = {
    type: "requests",
    from: from || ALL_FROM,
    to: to || ALL_TO,
    tz,
    status,
    policyIds: [],
    departmentId: null,
    userIds: [],
    includeInactive: true,
  };

  const { employees, policies } = await resolveScope(actor, f, { team: true });
  const result = employees.size && policies.length ? await requestsReport({ f, company, employees, policies }) : { rows: [] };

  // "Balance now": today's available hours for that employee and leave type.
  const balances = result.rows.length
    ? await prisma.leaveBalance.findMany({
        where: { userId: { in: [...new Set(result.rows.map((r) => r.employee.userId))] }, policyId: { in: [...new Set(result.rows.map((r) => r.policyId))] } },
        select: { userId: true, policyId: true, balanceHours: true },
      })
    : [];
  const balanceOf = new Map(balances.map((b) => [`${b.userId}|${b.policyId}`, Number(b.balanceHours)]));

  const rows = result.rows
    .map((r) => {
      const decided = r.dayCount != null;
      const pay = payOutcome(r);
      return {
        ...r,
        employeeName: r.employee?.name || r.employee?.email || "Unknown",
        email: r.employee?.email || null,
        department: r.employee?.department || null,
        // BB-125: an approved leave with some days reverted reads "Partly reverted".
        statusLabel: r.status === "approved" && r.revertedDays > 0 ? "Partly reverted" : STATUS_LABEL[r.status] || r.status,
        pay,
        payLabel: pay ? PAY_LABEL[pay] : null,
        days: decided ? r.dayCount : calendarDays(r.startDate, r.endDate),
        daysEstimated: !decided,
        balanceNow: balanceOf.has(`${r.employee?.userId}|${r.policyId}`) ? balanceOf.get(`${r.employee.userId}|${r.policyId}`) : null,
        submittedOn: r.submittedAt ? moment(r.submittedAt).tz(tz).format("YYYY-MM-DD") : null,
        decidedOn: r.decidedAt ? moment(r.decidedAt).tz(tz).format("YYYY-MM-DD") : null,
      };
    })
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.employeeName.localeCompare(b.employeeName)));

  // ── Summary ──
  const count = (fn) => rows.filter(fn).length;
  const byTypeMap = new Map();
  for (const r of rows) {
    const key = r.leaveType || "Unknown";
    if (!byTypeMap.has(key)) byTypeMap.set(key, { leaveType: key, requests: 0, approved: 0, pending: 0, paidHours: 0, unpaidHours: 0 });
    const t = byTypeMap.get(key);
    t.requests += 1;
    if (r.status === "approved") t.approved += 1;
    if (r.status === "pending" || r.status === "pending_secondary") t.pending += 1;
    t.paidHours = r2(t.paidHours + (r.paidHours ?? 0));
    t.unpaidHours = r2(t.unpaidHours + (r.unpaidHours ?? 0));
  }

  const statusNames = status.length === REQUEST_STATUSES.length ? "All statuses" : status.map((s) => STATUS_LABEL[s]).join(", ");
  const rangeLabel = from && to ? `${fmt(from)} – ${fmt(to)}` : from ? `From ${fmt(from)}` : to ? `Up to ${fmt(to)}` : "All dates";

  return {
    company: { name: company.name, timeZone: tz },
    requester: await resolveRequester(actor, me),
    scope:
      actor.role === "supervisor"
        ? { label: "Your team", detail: "Your department and direct reports" }
        : { label: "Whole company", detail: "Every employee, including inactive" },
    filters: { from, to, status, rangeLabel, statusNames },
    generatedAt: moment().tz(tz),
    rows,
    byType: [...byTypeMap.values()].sort((a, b) => a.leaveType.localeCompare(b.leaveType)),
    summary: {
      total: rows.length,
      pending: count((r) => r.status === "pending" || r.status === "pending_secondary"),
      pendingFinal: count((r) => r.status === "pending_secondary"),
      approved: count((r) => r.status === "approved"),
      rejected: count((r) => r.status === "rejected"),
      cancelled: count((r) => r.status === "cancelled"),
      reverted: count((r) => r.status === "reverted"),
      partlyReverted: count((r) => r.status === "approved" && r.revertedDays > 0),
      paidHours: r2(rows.reduce((t, r) => t + (r.paidHours ?? 0), 0)),
      unpaidHours: r2(rows.reduce((t, r) => t + (r.unpaidHours ?? 0), 0)),
      employees: new Set(rows.map((r) => r.employee?.userId)).size,
    },
  };
}

const csvHeaders = (report) => [
  "Employee",
  "Email",
  "Department",
  "Leave type",
  "Start date",
  "End date",
  "Days",
  "Days basis",
  "Hours",
  "Paid hours",
  "Unpaid hours",
  "Pay",
  "Status",
  "Reason",
  "Approver",
  "Second approver",
  "Decided by",
  `Decided on (${report.company.timeZone})`,
  `Submitted on (${report.company.timeZone})`,
  "Balance now (hours)",
  "Credits used by fiscal year",
];

function leaveRequestsCsvRows(report) {
  return report.rows.map((r) => [
    r.employeeName,
    r.email,
    r.department,
    r.leaveType,
    r.startDate,
    r.endDate,
    r.days,
    r.daysEstimated ? "Calendar days (not decided yet)" : "Leave days counted",
    r.requestedHours,
    r.paidHours,
    r.unpaidHours,
    r.payLabel,
    r.statusLabel,
    r.reason,
    r.approver,
    r.secondaryApprover,
    r.decidedBy,
    r.decidedOn,
    r.submittedOn,
    r.balanceNow,
    (r.creditsUsed || []).map((c) => `${c.label}: ${c.hours}h`).join("; ") || null,
  ]);
}

const reportFileName = (report, ext) =>
  `BizBuddy_LeaveRequests_${report.requester.fileName}_${report.generatedAt.format("YYYY-MM-DD_HH-mm")}.${ext}`;

module.exports = { buildLeaveRequestsReport, leaveRequestsCsvRows, csvHeaders, reportFileName, ReportError, payOutcome, STATUS_LABEL, PAY_LABEL };
