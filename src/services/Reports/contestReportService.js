// src/services/Reports/contestReportService.js
//
// BB-119: the Contest Time Logs report (punch-correction requests), built on the
// server (was the client's lib/exports/contestLogs.js). One endpoint serves:
//   scope=mine (default) — the requester's own contests (employee page);
//   scope=team           — admin/superadmin: whole company; supervisor: their
//                          department + direct reports (company Contest Requests page).
// No 50-row cap (the old page only ever loaded the latest 50).
//
// Dates/times: every punch time is shown in the company's time zone (BB-119).
// The date range filters on the PUNCH date — the day of the original clock-in
// (currentClockIn, or the requested clock-in when there was none) in company
// time — not on when the contest was submitted.
//
// Status values in the table are "PENDING" / "APPROVED" / "REJECTED".

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { resolveRequester } = require("@services/Reports/reportRequester");

const DEFAULT_TZ = "America/Los_Angeles";
const STATUSES = ["pending", "approved", "rejected"];
const STATUS_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" };

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && moment.utc(s, "YYYY-MM-DD", true).isValid();
const parseList = (v) => (v ? String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
const personName = (u) => {
  const name = `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim();
  return name || u?.email || null;
};
const PERSON = { id: true, email: true, profile: { select: { firstName: true, lastName: true } } };

/**
 * @param {{ id, role, companyId, agentId? }} actor  req.user
 * @param {{ scope?, from?, to?, status? }} query
 */
async function buildContestReport(actor, query = {}) {
  const scopeMode = query.scope === "team" ? "team" : "mine";
  if (scopeMode === "team" && !["admin", "superadmin", "supervisor"].includes(actor.role)) {
    throw new ReportError(403, "Only admins and supervisors can report on other employees' contests.");
  }

  const [company, me] = await Promise.all([
    prisma.company.findUnique({ where: { id: actor.companyId }, select: { name: true, timeZone: true } }),
    prisma.user.findUnique({
      where: { id: actor.id },
      select: { email: true, isSystemAgent: true, departmentId: true, profile: { select: { firstName: true, lastName: true } } },
    }),
  ]);
  if (!company) throw new ReportError(404, "Company not found.");
  const tz = company.timeZone || DEFAULT_TZ;

  // ── Filters ──
  const from = query.from || null;
  const to = query.to || null;
  if (from && !isYmd(from)) throw new ReportError(400, "from must be YYYY-MM-DD");
  if (to && !isYmd(to)) throw new ReportError(400, "to must be YYYY-MM-DD");
  if (from && to && from > to) throw new ReportError(400, "from must not be after to");
  const picked = parseList(query.status).filter((s) => s !== "all");
  const statuses = picked.length ? picked : [...STATUSES];
  const bad = statuses.filter((s) => !STATUSES.includes(s));
  if (bad.length) throw new ReportError(400, `Invalid status: ${bad.join(", ")}. Allowed: all, ${STATUSES.join(", ")}`);

  // ── Scope ──
  let userWhere;
  let scope;
  if (scopeMode === "mine") {
    userWhere = { id: actor.id };
    scope = { label: "Your contests", team: false };
  } else if (actor.role === "supervisor") {
    userWhere = {
      ...HUMAN_ONLY,
      companyId: actor.companyId,
      OR: [{ employmentDetail: { supervisorId: actor.id } }, ...(me?.departmentId ? [{ departmentId: me.departmentId }] : [])],
    };
    scope = { label: "Your team", team: true };
  } else {
    userWhere = { ...HUMAN_ONLY, companyId: actor.companyId };
    scope = { label: "Whole company", team: true };
  }

  // Punch-date range → UTC instants of company calendar days.
  const gte = from ? moment.tz(from, tz).startOf("day").toDate() : null;
  const lte = to ? moment.tz(to, tz).endOf("day").toDate() : null;
  const range = gte || lte ? { ...(gte && { gte }), ...(lte && { lte }) } : null;

  const contests = await prisma.contestTimeLog.findMany({
    where: {
      status: { in: statuses.map((s) => s.toUpperCase()) },
      timeLog: { user: userWhere },
      ...(range && { OR: [{ currentClockIn: range }, { currentClockIn: null, requestedClockIn: range }] }),
    },
    select: {
      reason: true,
      description: true,
      status: true,
      currentClockIn: true,
      currentClockOut: true,
      requestedClockIn: true,
      requestedClockOut: true,
      submittedAt: true,
      createdAt: true,
      approvedAt: true,
      approvedReason: true,
      approver: { select: PERSON },
      timeLog: { select: { user: { select: { ...PERSON, department: { select: { name: true } } } } } },
    },
  });

  const local = (d) => (d ? moment(d).tz(tz) : null);
  const hoursBetween = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 3600000 : null);

  const rows = contests
    .map((c) => {
      const status = String(c.status || "").toLowerCase();
      const punch = local(c.currentClockIn || c.requestedClockIn);
      const original = hoursBetween(c.currentClockIn, c.currentClockOut);
      const requested = hoursBetween(c.requestedClockIn, c.requestedClockOut);
      const user = c.timeLog?.user;
      return {
        employeeName: personName(user) || "Unknown",
        email: user?.email || null,
        department: user?.department?.name || null,
        punchDate: punch ? punch.format("YYYY-MM-DD") : null,
        originalIn: local(c.currentClockIn),
        originalOut: local(c.currentClockOut),
        requestedIn: local(c.requestedClockIn),
        requestedOut: local(c.requestedClockOut),
        originalHours: original,
        requestedHours: requested,
        changeHours: original != null && requested != null ? requested - original : null,
        status,
        statusLabel: STATUS_LABEL[status] || c.status,
        reason: c.reason || null,
        description: c.description || null,
        reviewer: c.approver ? personName(c.approver) : null,
        reviewedOn: status !== "pending" && c.approvedAt ? local(c.approvedAt).format("YYYY-MM-DD") : null,
        decisionNote: status !== "pending" ? c.approvedReason || null : null,
        submittedOn: local(c.submittedAt || c.createdAt)?.format("YYYY-MM-DD") || null,
      };
    })
    .sort((a, b) => ((a.punchDate || "") < (b.punchDate || "") ? 1 : (a.punchDate || "") > (b.punchDate || "") ? -1 : a.employeeName.localeCompare(b.employeeName))); // newest punch first

  const count = (s) => rows.filter((r) => r.status === s).length;
  const approvedChange = rows.filter((r) => r.status === "approved" && r.changeHours != null).reduce((t, r) => t + r.changeHours, 0);
  const fmt = (ymd) => moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY");

  return {
    company: { name: company.name, timeZone: tz },
    requester: await resolveRequester(actor, me),
    scope,
    filters: {
      from,
      to,
      rangeLabel: from && to ? `${fmt(from)} – ${fmt(to)}` : from ? `From ${fmt(from)}` : to ? `Up to ${fmt(to)}` : "All dates",
      statusNames: statuses.length === STATUSES.length ? "All statuses" : statuses.map((s) => STATUS_LABEL[s]).join(", "),
    },
    generatedAt: moment().tz(tz),
    rows,
    summary: {
      total: rows.length,
      pending: count("pending"),
      approved: count("approved"),
      rejected: count("rejected"),
      employees: new Set(rows.map((r) => r.email)).size,
      approvedChangeHours: approvedChange,
    },
  };
}

// "8:30 AM", plus "(+1)" when the clock-out falls on the next day.
function timeText(m, ref) {
  if (!m) return null;
  const t = m.format("h:mm A");
  return ref && m.format("YYYY-MM-DD") !== ref.format("YYYY-MM-DD") ? `${t} (+${m.clone().startOf("day").diff(ref.clone().startOf("day"), "days")})` : t;
}
const rangeText = (a, b) => (a || b ? `${timeText(a) || "—"} – ${timeText(b, a) || "—"}` : null);
const changeText = (h) => {
  if (h == null) return null;
  const mins = Math.round(h * 60);
  if (!mins) return "no change";
  const sign = mins > 0 ? "+" : "-";
  const abs = Math.abs(mins);
  return `${sign}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, "0")}m`;
};

const csvHeaders = (report) => {
  const z = report.company.timeZone;
  return [
    "Employee",
    "Email",
    "Department",
    `Punch date (${z})`,
    `Original clock-in (${z})`,
    `Original clock-out (${z})`,
    `Requested clock-in (${z})`,
    `Requested clock-out (${z})`,
    "Original hours",
    "Requested hours",
    "Change (hours)",
    "Status",
    "Reason",
    "Details",
    "Reviewer",
    `Reviewed on (${z})`,
    "Decision note",
    `Submitted on (${z})`,
  ];
};

const stamp = (m) => (m ? m.format("YYYY-MM-DD HH:mm") : null);
const round2 = (h) => (h == null ? null : Math.round(h * 100) / 100);

function contestsCsvRows(report) {
  return report.rows.map((r) => [
    r.employeeName,
    r.email,
    r.department,
    r.punchDate,
    stamp(r.originalIn),
    stamp(r.originalOut),
    stamp(r.requestedIn),
    stamp(r.requestedOut),
    round2(r.originalHours),
    round2(r.requestedHours),
    round2(r.changeHours),
    r.statusLabel,
    r.reason,
    r.description,
    r.reviewer,
    r.reviewedOn,
    r.decisionNote,
    r.submittedOn,
  ]);
}

const reportFileName = (report, ext) =>
  `BizBuddy_Contests_${report.requester.fileName}_${report.generatedAt.format("YYYY-MM-DD_HH-mm")}.${ext}`;

module.exports = { buildContestReport, contestsCsvRows, csvHeaders, reportFileName, ReportError, rangeText, changeText };
