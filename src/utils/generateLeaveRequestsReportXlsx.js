// src/utils/generateLeaveRequestsReportXlsx.js
//
// BB-119: the Leave Requests report as an Excel workbook on the shared template
// (utils/xlsx/reportWorkbook.js). Same data and filters as the PDF and CSV
// (leaveRequestsReportService.buildLeaveRequestsReport).
//
//   Sheet "Leave requests": one row per request, oldest start date first,
//                           real dates and hours, totals row, filters.
//   Sheet "Summary":        counts by status, paid/unpaid hours, by leave type.

const XL = require("@utils/xlsx/reportWorkbook");

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} report  from buildLeaveRequestsReport
 * @returns {Promise<Buffer>}
 */
function generateLeaveRequestsReportXlsx(report) {
  const { company, requester, scope, filters, rows, summary: s, byType } = report;
  const tz = company.timeZone;

  const book = XL.createWorkbook({
    company: company.name,
    reportName: "Leave Requests Report",
    tag: "client",
    requester,
    generatedLabel: report.generatedAt.format("MMM D, YYYY, h:mm A z"),
    timeZone: tz,
  });
  const subtitle = `${filters.rangeLabel} · ${filters.statusNames} · ${scope.label} · ${plural(s.total, "request")}`;

  XL.addTableSheet(book, {
    name: "Leave requests",
    subtitle,
    freezeColumns: 1,
    columns: [
      { header: "Employee", value: (r) => r.employeeName, width: 22 },
      { header: "Email", value: (r) => r.email, width: 26 },
      { header: "Department", value: (r) => r.department, width: 18 },
      { header: "Leave type", value: (r) => r.leaveType, width: 16 },
      { header: "Start date", value: (r) => r.startDate, type: "date" },
      { header: "End date", value: (r) => r.endDate, type: "date" },
      { header: "Days", value: (r) => r.days, type: "number", width: 7 },
      { header: "Days basis", value: (r) => (r.daysEstimated ? "Calendar days (not decided yet)" : "Leave days counted"), width: 18 },
      { header: "Hours", value: (r) => r.requestedHours, type: "hours", width: 8 },
      { header: "Paid hours", value: (r) => r.paidHours, type: "hours", width: 9 },
      { header: "Unpaid hours", value: (r) => r.unpaidHours, type: "hours", width: 9 },
      { header: "Pay", value: (r) => r.payLabel, width: 12 },
      { header: "Status", value: (r) => r.statusLabel, width: 12 },
      { header: "Reason", value: (r) => r.reason, width: 30 },
      { header: "Approver", value: (r) => r.approver, width: 18 },
      { header: "Second approver", value: (r) => r.secondaryApprover, width: 18 },
      { header: "Decided by", value: (r) => r.decidedBy, width: 18 },
      { header: "Decided on", value: (r) => r.decidedOn, type: "date" },
      { header: "Submitted on", value: (r) => r.submittedOn, type: "date" },
      { header: "Balance now (hours)", value: (r) => r.balanceNow, type: "hours", width: 11 },
      { header: "Credits used by fiscal year", value: (r) => (r.creditsUsed || []).map((c) => `${c.label}: ${c.hours}h`).join("; ") || null, width: 26 },
    ],
    rows,
    totals: {
      label: "Total",
      values: {
        8: rows.reduce((t, r) => t + (Number(r.requestedHours) || 0), 0),
        9: s.paidHours,
        10: s.unpaidHours,
      },
    },
    notes: [
      `Dates are in ${tz} (the company's time zone). Start and end dates are the leave's calendar dates.`,
      "Days: for decided leave, the leave days actually counted (weekends and days without shifts can be left out); for pending, rejected or cancelled requests, the calendar days requested.",
      "Paid and unpaid hours are the actual split once a request is decided. Balance now is the employee's available hours for that leave type today.",
      "The search box on the page doesn't filter this file; the date range and status do.",
    ],
  });

  XL.addSummarySheet(book, {
    name: "Summary",
    title: "Leave Requests Report — Summary",
    subtitle,
    figures: [
      { label: "Requests", value: s.total, note: plural(s.employees, "employee") },
      { label: "Pending", value: s.pending, note: s.pendingFinal ? `${s.pendingFinal} waiting for final approval` : undefined },
      { label: "Approved", value: s.approved },
      { label: "Rejected", value: s.rejected },
      { label: "Cancelled", value: s.cancelled },
      { label: "Paid hours", value: s.paidHours },
      { label: "Unpaid hours", value: s.unpaidHours },
    ],
    tables: [
      {
        heading: "By leave type",
        columns: [
          { header: "Leave type", value: (t) => t.leaveType },
          { header: "Requests", value: (t) => t.requests, type: "int" },
          { header: "Approved", value: (t) => t.approved, type: "int" },
          { header: "Pending", value: (t) => t.pending, type: "int" },
          { header: "Paid hours", value: (t) => t.paidHours, type: "hours" },
          { header: "Unpaid hours", value: (t) => t.unpaidHours, type: "hours" },
        ],
        rows: byType,
        totals: { label: "Total", values: { 1: s.total, 2: s.approved, 3: s.pending, 4: s.paidHours, 5: s.unpaidHours } },
      },
    ],
  });

  return XL.finish(book);
}

module.exports = { generateLeaveRequestsReportXlsx };
