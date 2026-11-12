// src/utils/generateContestReportPDF.js
//
// BB-119: the Contest Time Logs report (punch corrections) as a US Letter
// landscape PDF on the shared report layout (Client report). Data comes from
// contestReportService. The Employee column appears only for team reports.

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");
const { rangeText, changeText } = require("@services/Reports/contestReportService");

const { THEME, PILL, mm } = L;

const STATUS_PILL = {
  pending: { label: "Pending", ...PILL.warn },
  approved: { label: "Approved", ...PILL.ok },
  rejected: { label: "Rejected", ...PILL.bad },
};

const dash = { text: "—", color: THEME.faint };
const txt = (v, extra = {}) => (v == null || v === "" ? dash : { text: String(v), ...extra });
const fmtDate = (ymd) => (ymd ? moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY") : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} report  from buildContestReport
 * @returns {Promise<Buffer>}
 */
function generateContestReportPDF(report) {
  try {
    const { company, requester, scope, filters, summary: s, rows } = report;
    const generatedLabel = report.generatedAt.format("MMM D, YYYY, h:mm A z");

    const w = L.createReport({
      orientation: "landscape",
      tag: "client",
      company: company.name,
      reportName: "Contest Time Logs Report",
      eyebrow: "Time & attendance",
      generatedLabel,
      continuation: { title: "Contest Time Logs Report", detail: `${filters.rangeLabel}  ·  ${company.name}` },
      info: { Title: `BizBuddy Contest Time Logs Report — ${company.name}`, Subject: "Punch correction requests" },
    });

    // ── Title and meta ──
    L.title(w, "Contest Time Logs Report", `${filters.rangeLabel}  ·  ${plural(s.total, "contest")}`);
    L.metaStrip(w, [
      { label: "Company", value: company.name },
      { label: "Requested by", value: requester.name, sub: requester.email },
      { label: "Generated", value: generatedLabel },
      { label: "Times shown in", value: `${L.zoneCity(company.timeZone)} time`, sub: company.timeZone },
      { label: "Filters", value: filters.rangeLabel, sub: `${filters.statusNames} · ${scope.label.toLowerCase()} · by punch date` },
    ]);

    // ── Summary ──
    L.sectionTitle(w, "Summary");
    const net = changeText(s.approvedChangeHours);
    L.kpiTiles(w, [
      { label: "Contests", value: String(s.total), sub: scope.team ? plural(s.employees, "employee") : "Punch corrections you asked for" },
      { label: "Pending", value: String(s.pending), sub: "Waiting for a reviewer" },
      { label: "Approved", value: String(s.approved), sub: "Punch times were corrected" },
      { label: "Rejected", value: String(s.rejected), sub: "Original times kept" },
      { label: "Net time change", value: s.approved ? (net === "no change" ? "0h 00m" : net) : "—", sub: "From approved contests" },
    ]);

    // ── Contests ──
    L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * 5);
    L.sectionTitle(w, "Contests", { note: `${plural(rows.length, "contest")}, newest punch first` });
    if (!rows.length) {
      L.paragraph(w, "No contests match these filters.", { color: THEME.muted });
    } else {
      const cols = [
        ...(scope.team ? [{ label: "Employee", width: null, cell: (r) => ({ text: r.employeeName }) }] : []),
        { label: "Punch date", width: 56, cell: (r) => txt(fmtDate(r.punchDate)) },
        { label: "Original", width: 96, cell: (r) => txt(rangeText(r.originalIn, r.originalOut), { color: THEME.muted }) },
        { label: "Requested", width: 96, cell: (r) => txt(rangeText(r.requestedIn, r.requestedOut)) },
        {
          label: "Change",
          width: 50,
          align: "right",
          cell: (r) => {
            const t = changeText(r.changeHours);
            if (!t) return dash;
            return { text: t, color: t === "no change" ? THEME.faint : r.changeHours > 0 ? PILL.ok.fg : PILL.bad.fg };
          },
        },
        { label: "Reason", width: scope.team ? 96 : null, cell: (r) => txt(r.reason) },
        { label: "Status", width: 58, cell: (r) => ({ pill: STATUS_PILL[r.status] || { label: r.statusLabel, ...PILL.neutral } }) },
        { label: "Reviewer", width: 76, cell: (r) => txt(r.reviewer, { color: r.status === "pending" ? THEME.muted : THEME.ink }) },
        { label: "Reviewed", width: 52, cell: (r) => txt(fmtDate(r.reviewedOn)) },
        { label: "Submitted", width: 52, cell: (r) => txt(fmtDate(r.submittedOn)) },
      ];
      L.table(w, cols, rows, { striped: true });
    }

    L.endNote(w, [
      "Original is the punch as it was recorded; Requested is the correction asked for. When a contest is approved, the punch log is changed to the requested times. \"(+1)\" means the clock-out was on the next day.",
      "Change is requested worked time minus original worked time. Net time change adds up approved contests only. For a pending contest, Reviewer is the person it was sent to.",
      "The CSV export adds the employee's details and the decision note.",
    ]);
    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

module.exports = { generateContestReportPDF };
