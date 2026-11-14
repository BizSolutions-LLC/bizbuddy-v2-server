// src/utils/generateLeaveRequestsReportPDF.js
//
// BB-119: the Leave Requests report as a US Letter landscape PDF on the shared
// report layout (Client report). Data comes from leaveRequestsReportService.

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");

const { THEME, PILL, mm } = L;

const STATUS_PILL = {
  pending: { label: "Pending", ...PILL.warn },
  pending_secondary: { label: "Pending final", ...PILL.warn },
  approved: { label: "Approved", ...PILL.ok },
  rejected: { label: "Rejected", ...PILL.bad },
  cancelled: { label: "Cancelled", ...PILL.neutral },
  reverted: { label: "Reverted", ...PILL.neutral }, // BB-125
};
const PAY_PILL = {
  paid: { label: "Paid", ...PILL.ok },
  unpaid: { label: "Unpaid", ...PILL.neutral },
  partial: { label: "Partial", ...PILL.info },
};

const dash = { text: "—", color: THEME.faint };
const fmtDate = (ymd) => (ymd ? moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY") : null);
const hrs = (h) => (h == null ? null : `${Number(h).toFixed(2)}h`);
const num = (n) => (n ? { text: String(n) } : { text: "0", color: THEME.faint });
const hoursCell = (h) => (h == null ? dash : Number(h) === 0 ? { text: "0.00h", color: THEME.faint } : { text: hrs(h) });
const txt = (v, extra = {}) => (v == null || v === "" ? dash : { text: String(v), ...extra });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} report  from buildLeaveRequestsReport
 * @returns {Promise<Buffer>}
 */
function generateLeaveRequestsReportPDF(report) {
  try {
    const { company, requester, scope, filters, summary: s, rows } = report;
    const generatedLabel = report.generatedAt.format("MMM D, YYYY, h:mm A z");

    const w = L.createReport({
      orientation: "landscape",
      tag: "client",
      company: company.name,
      reportName: "Leave Requests Report",
      eyebrow: "Time & attendance",
      generatedLabel,
      continuation: { title: "Leave Requests Report", detail: `${filters.rangeLabel}  ·  ${company.name}` },
      info: { Title: `BizBuddy Leave Requests Report — ${company.name}`, Subject: "Leave requests" },
    });

    // ── Title and meta ──
    L.title(w, "Leave Requests Report", `${filters.rangeLabel}  ·  ${plural(s.total, "request")}`);
    L.metaStrip(w, [
      { label: "Company", value: company.name },
      { label: "Requested by", value: requester.name, sub: requester.email },
      { label: "Generated", value: generatedLabel },
      { label: "Times shown in", value: `${L.zoneCity(company.timeZone)} time`, sub: company.timeZone },
      { label: "Filters", value: filters.rangeLabel, sub: `${filters.statusNames} · ${scope.label.toLowerCase()}` },
    ]);

    // ── Summary ──
    L.sectionTitle(w, "Summary");
    L.kpiTiles(w, [
      { label: "Requests", value: String(s.total), sub: `${plural(s.employees, "employee")}` },
      { label: "Pending", value: String(s.pending), sub: s.pendingFinal ? `${s.pendingFinal} awaiting final approval` : "Awaiting an approver" },
      { label: "Approved", value: String(s.approved), sub: `${hrs(s.paidHours)} paid · ${hrs(s.unpaidHours)} unpaid` },
      { label: "Rejected", value: String(s.rejected), sub: [s.cancelled ? `${s.cancelled} cancelled` : "None cancelled", s.reverted ? `${s.reverted} reverted` : null].filter(Boolean).join(" · ") },
      { label: "Leave hours", value: hrs(s.paidHours + s.unpaidHours), sub: "Decided requests only" },
    ]);

    if (report.byType.length) {
      L.sectionTitle(w, "By leave type");
      const totals = report.byType.reduce(
        (t, r) => ({ requests: t.requests + r.requests, approved: t.approved + r.approved, pending: t.pending + r.pending, paidHours: t.paidHours + r.paidHours, unpaidHours: t.unpaidHours + r.unpaidHours }),
        { requests: 0, approved: 0, pending: 0, paidHours: 0, unpaidHours: 0 }
      );
      L.table(
        w,
        [
          { label: "Leave type", width: null, cell: (r) => ({ text: r.isTotal ? "Total" : r.leaveType }) },
          { label: "Requests", width: 76, align: "right", cell: (r) => ({ text: String(r.requests), bold: true }) },
          { label: "Approved", width: 76, align: "right", cell: (r) => num(r.approved) },
          { label: "Pending", width: 76, align: "right", cell: (r) => num(r.pending) },
          { label: "Paid hours", width: 86, align: "right", cell: (r) => hoursCell(r.paidHours) },
          { label: "Unpaid hours", width: 86, align: "right", cell: (r) => hoursCell(r.unpaidHours) },
        ],
        [...report.byType, { isTotal: true, ...totals }],
        { isTotal: (r) => r.isTotal }
      );
    }

    // ── Requests ──
    L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * 5);
    L.sectionTitle(w, "Requests", { note: `${plural(rows.length, "request")}, sorted by start date` });
    if (!rows.length) {
      L.paragraph(w, "No leave requests match these filters.", { color: THEME.muted });
    } else {
      L.table(
        w,
        [
          { label: "Employee", width: null, cell: (r) => ({ text: r.employeeName }) },
          { label: "Leave type", width: 62, cell: (r) => txt(r.leaveType) },
          { label: "Dates", width: 96, cell: (r) => ({ text: r.startDate === r.endDate ? fmtDate(r.startDate) : `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}` }) },
          { label: "Days", width: 30, align: "right", cell: (r) => ({ text: String(r.days), color: r.daysEstimated ? THEME.muted : THEME.ink }) },
          { label: "Hours", width: 44, align: "right", cell: (r) => hoursCell(r.requestedHours) },
          { label: "Pay", width: 60, cell: (r) => (r.pay ? { pill: PAY_PILL[r.pay] } : dash) },
          { label: "Balance now", width: 46, align: "right", cell: (r) => (r.balanceNow == null ? dash : { text: hrs(r.balanceNow), color: THEME.muted }) },
          { label: "Approver", width: 64, cell: (r) => txt(r.secondaryApprover ? `${r.approver || "—"} / ${r.secondaryApprover}` : r.approver) },
          { label: "Decided by", width: 60, cell: (r) => txt(r.decidedBy) },
          { label: "Decided", width: 50, cell: (r) => txt(fmtDate(r.decidedOn)) },
          { label: "Submitted", width: 50, cell: (r) => txt(fmtDate(r.submittedOn)) },
          { label: "Status", width: 64, cell: (r) => ({ pill: r.statusLabel === "Partly reverted" ? { label: "Partly reverted", ...PILL.ok } : STATUS_PILL[r.status] || { label: r.statusLabel, ...PILL.neutral } }) },
        ],
        rows,
        { striped: true }
      );
    }

    L.endNote(w, [
      "Days and Hours are the leave days actually counted once a request is decided (weekends and days without shifts can be excluded). For pending requests, Days is the calendar span shown in grey and Hours is \"—\" until the leave is decided.",
      "Pay shows the actual paid/unpaid outcome once approved. Balance now is today's available hours for that leave type, not the balance when the leave was taken.",
      "Approver shows \"first / second\" when the request needs two approvals. The CSV export adds the reason and the credits used by fiscal year.",
      "Reverted: the leave was approved, but the employee punched in on that day. The punch was paid and the leave hours were returned to their balance. Partly reverted: only some days of the request were reverted; Days and Hours count the remaining days.",
    ]);
    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

module.exports = { generateLeaveRequestsReportPDF };
