// src/services/Reports/leaveCalendarReportService.js
//
// BB-119: the Leave Calendar report (one month), built on the server (was the
// client's lib/exports/leaveCalendar.js). Reuses the BB-098 "requests" query
// for every leave overlapping the month, then works out which days to mark:
//   - decided leaves (LeaveDay rows exist): only the days actually counted
//     (BB-054 — weekends / days without shifts may be left out);
//   - pending / rejected / cancelled: the requested span, skipping Saturday
//     and Sunday when the request excludes weekends (Leave.includeWeekends).
// Leave dates are calendar dates (company time zone), read without conversion.
//
// Filters: month=YYYY-MM (default: this month, company time zone) and status
// (pending, approved, rejected, cancelled; "pending" also covers
// pending_secondary — the dialog offers them as one). Scope like Leave
// Requests: admin/superadmin whole company, supervisor department + direct reports.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { COMPANY_CREDIT_SELECT } = require("@services/Leave/leaveCreditService");
const { ReportError, DEFAULT_TZ, resolveScope, requestsReport, parseList, r2 } = require("@services/Reports/leaveReportService");
const { payOutcome, STATUS_LABEL, PAY_LABEL } = require("@services/Reports/leaveRequestsReportService");
const { resolveRequester } = require("@services/Reports/reportRequester");

const CALENDAR_STATUSES = ["pending", "approved", "rejected", "cancelled"];
const EXPAND = { pending: ["pending", "pending_secondary"], approved: ["approved"], rejected: ["rejected"], cancelled: ["cancelled"] };

// "Jhenelle Villanueva" → "Jhenelle V." — short enough for a day cell.
function shortName(name) {
  const parts = String(name || "Unknown").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || "Unknown";
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/**
 * @param {{ id, role, companyId, agentId? }} actor  req.user
 * @param {{ month?, status? }} query
 */
async function buildLeaveCalendarReport(actor, query = {}) {
  const [company, me] = await Promise.all([
    prisma.company.findUnique({ where: { id: actor.companyId }, select: { ...COMPANY_CREDIT_SELECT, name: true } }),
    prisma.user.findUnique({ where: { id: actor.id }, select: { email: true, isSystemAgent: true, profile: { select: { firstName: true, lastName: true } } } }),
  ]);
  if (!company) throw new ReportError(404, "Company not found.");
  const tz = company.timeZone || DEFAULT_TZ;

  // ── Filters ──
  const month = query.month || moment.tz(tz).format("YYYY-MM");
  if (!/^\d{4}-\d{2}$/.test(month) || !moment.utc(month, "YYYY-MM", true).isValid()) throw new ReportError(400, "month must be YYYY-MM");
  const first = moment.utc(month, "YYYY-MM").startOf("month");
  const last = first.clone().endOf("month");
  const monthFrom = first.format("YYYY-MM-DD");
  const monthTo = last.format("YYYY-MM-DD");

  const picked = parseList(query.status).filter((s) => s !== "all");
  const chosen = picked.length ? picked : [...CALENDAR_STATUSES];
  const bad = chosen.filter((s) => !CALENDAR_STATUSES.includes(s));
  if (bad.length) throw new ReportError(400, `Invalid status: ${bad.join(", ")}. Allowed: all, ${CALENDAR_STATUSES.join(", ")}`);
  const status = chosen.flatMap((s) => EXPAND[s]);

  const f = { type: "requests", from: monthFrom, to: monthTo, tz, status, policyIds: [], departmentId: null, userIds: [], includeInactive: true };
  const { employees, policies } = await resolveScope(actor, f, { team: true });
  const result = employees.size && policies.length ? await requestsReport({ f, company, employees, policies }) : { rows: [] };

  // ── Which days each leave covers in this month ──
  const ids = result.rows.map((r) => r.leaveId);
  const [leaveDays, leaveMeta] = ids.length
    ? await Promise.all([
        prisma.leaveDay.findMany({
          where: { leaveId: { in: ids }, revertedAt: null, date: { gte: first.toDate(), lte: last.toDate() } }, // BB-125
          select: { leaveId: true, date: true, hours: true },
        }),
        prisma.leave.findMany({ where: { id: { in: ids } }, select: { id: true, includeWeekends: true } }),
      ])
    : [[], []];
  const daysByLeave = new Map();
  for (const d of leaveDays) {
    if (!daysByLeave.has(d.leaveId)) daysByLeave.set(d.leaveId, { dates: new Set(), hours: 0 });
    const e = daysByLeave.get(d.leaveId);
    e.dates.add(ymd(d.date));
    e.hours += Number(d.hours);
  }
  const includeWeekends = new Map(leaveMeta.map((l) => [l.id, l.includeWeekends]));

  const leaves = result.rows
    .map((r) => {
      const decided = r.dayCount != null;
      let dates;
      if (decided) {
        dates = [...(daysByLeave.get(r.leaveId)?.dates || [])].sort();
      } else {
        dates = [];
        const skipWeekends = includeWeekends.get(r.leaveId) === false;
        const start = moment.utc(r.startDate < monthFrom ? monthFrom : r.startDate);
        const end = moment.utc(r.endDate > monthTo ? monthTo : r.endDate);
        for (const d = start.clone(); !d.isAfter(end); d.add(1, "day")) {
          if (skipWeekends && (d.day() === 0 || d.day() === 6)) continue;
          dates.push(d.format("YYYY-MM-DD"));
        }
      }
      const pay = payOutcome(r);
      return {
        leaveId: r.leaveId,
        employeeName: r.employee?.name || r.employee?.email || "Unknown",
        shortName: shortName(r.employee?.name || r.employee?.email),
        leaveType: r.leaveType,
        startDate: r.startDate,
        endDate: r.endDate,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status] || r.status,
        pay,
        payLabel: pay ? PAY_LABEL[pay] : null,
        decided,
        dates,
        daysThisMonth: dates.length,
        hoursThisMonth: decided ? r2(daysByLeave.get(r.leaveId)?.hours || 0) : null,
        submittedAt: r.submittedAt,
        submittedOn: r.submittedAt ? moment(r.submittedAt).tz(tz).format("YYYY-MM-DD") : null,
      };
    })
    .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1)); // earliest submitter first, like the live calendar

  // day of month → chips, in submission order
  const days = {};
  for (const l of leaves) {
    for (const date of l.dates) {
      const day = Number(date.slice(8, 10));
      (days[day] ||= []).push({ name: l.shortName, status: l.status });
    }
  }

  const list = [...leaves].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.employeeName.localeCompare(b.employeeName)));
  const statusNames =
    chosen.length === CALENDAR_STATUSES.length ? "All statuses" : chosen.map((s) => (s === "pending" ? "Pending" : STATUS_LABEL[s])).join(", ");

  return {
    company: { name: company.name, timeZone: tz },
    requester: await resolveRequester(actor, me),
    scope: actor.role === "supervisor" ? { label: "Your team" } : { label: "Whole company" },
    month: { key: month, label: first.format("MMMM YYYY"), year: first.year(), monthIndex: first.month(), daysInMonth: last.date(), firstWeekday: first.day() },
    filters: { statuses: chosen, statusNames },
    generatedAt: moment().tz(tz),
    days,
    list,
    summary: {
      requests: leaves.length,
      employees: new Set(result.rows.map((r) => r.employee?.userId)).size,
      leaveDays: leaves.reduce((t, l) => t + l.daysThisMonth, 0),
      busiest: Object.entries(days).reduce((best, [d, chips]) => (chips.length > (best?.count || 0) ? { day: Number(d), count: chips.length } : best), null),
    },
  };
}

const reportFileName = (report) =>
  `BizBuddy_LeaveCalendar_${report.month.key}_${report.requester.fileName}_${report.generatedAt.format("YYYY-MM-DD_HH-mm")}.pdf`;

module.exports = { buildLeaveCalendarReport, reportFileName, ReportError };
