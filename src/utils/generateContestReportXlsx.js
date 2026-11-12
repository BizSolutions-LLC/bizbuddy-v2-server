// src/utils/generateContestReportXlsx.js
//
// BB-119: the Contest Time Logs report (punch corrections) as an Excel workbook
// on the shared template (utils/xlsx/reportWorkbook.js). Same data and filters
// as the PDF and CSV (contestReportService.buildContestReport).
//
//   Sheet "Contests": one row per contest, newest punch first; original and
//                     requested times as real date-times, hours and the signed
//                     change. Employee columns only on team reports.
//   Sheet "Summary":  counts by status and the net time change of approved contests.

const XL = require("@utils/xlsx/reportWorkbook");

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stamp = (m) => (m ? m.format("YYYY-MM-DD HH:mm") : null); // company-zone wall clock
const r2 = (h) => (h == null ? null : Math.round(h * 100) / 100);
const SIGNED_HOURS = '+0.00;-0.00;0.00';

/**
 * @param {object} report  from buildContestReport
 * @returns {Promise<Buffer>}
 */
function generateContestReportXlsx(report) {
  const { company, requester, scope, filters, rows, summary: s } = report;
  const tz = company.timeZone;
  const team = scope.team;

  const book = XL.createWorkbook({
    company: company.name,
    reportName: "Contest Time Logs Report",
    tag: "client",
    requester,
    generatedLabel: report.generatedAt.format("MMM D, YYYY, h:mm A z"),
    timeZone: tz,
  });
  const subtitle = `${filters.rangeLabel} · ${filters.statusNames} · ${scope.label} · ${plural(s.total, "contest")}`;

  XL.addTableSheet(book, {
    name: "Contests",
    subtitle,
    freezeColumns: team ? 1 : 0,
    columns: [
      ...(team
        ? [
            { header: "Employee", value: (r) => r.employeeName, width: 22 },
            { header: "Email", value: (r) => r.email, width: 26 },
            { header: "Department", value: (r) => r.department, width: 18 },
          ]
        : []),
      { header: "Punch date", value: (r) => r.punchDate, type: "date" },
      { header: "Original clock-in", value: (r) => stamp(r.originalIn), type: "datetime" },
      { header: "Original clock-out", value: (r) => stamp(r.originalOut), type: "datetime" },
      { header: "Requested clock-in", value: (r) => stamp(r.requestedIn), type: "datetime" },
      { header: "Requested clock-out", value: (r) => stamp(r.requestedOut), type: "datetime" },
      { header: "Original hours", value: (r) => r2(r.originalHours), type: "hours", width: 9 },
      { header: "Requested hours", value: (r) => r2(r.requestedHours), type: "hours", width: 10 },
      { header: "Change (hours)", value: (r) => r2(r.changeHours), type: "hours", numFmt: SIGNED_HOURS, width: 9 },
      { header: "Status", value: (r) => r.statusLabel, width: 10 },
      { header: "Reason", value: (r) => r.reason, width: 24 },
      { header: "Details", value: (r) => r.description, width: 30 },
      { header: "Reviewer", value: (r) => r.reviewer, width: 18 },
      { header: "Reviewed on", value: (r) => r.reviewedOn, type: "date" },
      { header: "Decision note", value: (r) => r.decisionNote, width: 24 },
      { header: "Submitted on", value: (r) => r.submittedOn, type: "date" },
    ],
    rows,
    notes: [
      `Dates and times are in ${tz} (the company's time zone). The date range filters on the punch date, not the date the contest was submitted.`,
      "Original is the punch as it was recorded; Requested is the correction asked for. When a contest is approved, the punch log is changed to the requested times.",
      "Change is requested hours minus original hours. For a pending contest, Reviewer is the person it was sent to.",
    ],
  });

  XL.addSummarySheet(book, {
    name: "Summary",
    title: "Contest Time Logs Report — Summary",
    subtitle,
    figures: [
      { label: "Contests", value: s.total, note: team ? plural(s.employees, "employee") : undefined },
      { label: "Pending", value: s.pending, note: "Waiting for a reviewer" },
      { label: "Approved", value: s.approved, note: "Punch times were corrected" },
      { label: "Rejected", value: s.rejected, note: "Original times kept" },
      { label: "Net time change (hours)", value: s.approved ? r2(s.approvedChangeHours) : null, note: "From approved contests" },
    ],
  });

  return XL.finish(book);
}

module.exports = { generateContestReportXlsx };
