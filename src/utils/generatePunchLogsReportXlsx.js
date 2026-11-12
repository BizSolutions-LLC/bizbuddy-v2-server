// src/utils/generatePunchLogsReportXlsx.js
//
// BB-119: the Punch Logs report as an Excel workbook on the shared template
// (utils/xlsx/reportWorkbook.js) — replaces the company page's browser-built
// "CSV Detail" (lib/exports/employeePunchLogs.js:exportEmployeePunchLogsCSV).
// Same data, filters and data basis as the PDF (punchLogReportService).
//
// Keeps the old CSV Detail's core contents:
//   - requester, generated time, filters, company time zone → title block + Summary;
//   - summary statistics (records, active / completed / scheduled sessions,
//     worked, scheduled and overtime hours) → Summary;
//   - employee summary (worked, scheduled, overtime, days worked, average per
//     day, fixed-hours employees marked) with a total → Summary "By employee";
//   - the detail rows (employee, time in/out, duration, gross, status, punch
//     type, cutoff status, scheduled, period hours, OT / OT status, late,
//     undertime, coffee, lunch, lunch start/end, location required, check-in /
//     check-out location, device in/out) → "Punches";
//   - the accountability notice → notes + footer on every sheet.
// Dropped on purpose: the record ID and the requester's user ID / username
// (system identifiers aren't printed on reports).

const moment = require("moment-timezone");
const XL = require("@utils/xlsx/reportWorkbook");

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const BASIS_LABEL = { final: "Final — reviewed, paid hours", preliminary: "Preliminary — live punches", partial: "Partly final — some cutoffs reviewed" };
const ROW_BASIS = { reviewed: "Reviewed", live: "Live" };
const hoursLabel = (v) => `${Number(v).toFixed(2).replace(/\.00$/, "")}h`;

/**
 * @param {object} report  from buildPunchLogReport
 * @returns {Promise<Buffer>}
 */
function generatePunchLogsReportXlsx(report) {
  const { company, requester, scope, filters, periods, basis, summary: s, rows, byEmployee, fixedHours, hasDriverAide, cutoffOt, cutoffBasis } = report;
  const tz = company.timeZone;
  const team = scope.team;
  const clock = (d) => (d ? moment(d).tz(tz).format("h:mm A") : null);
  const stamp = (d) => (d ? moment(d).tz(tz).format("YYYY-MM-DD HH:mm") : null); // company-zone wall clock
  const subject = team ? plural(s.employees, "employee") : rows[0]?.employeeName || requester.name;

  const book = XL.createWorkbook({
    company: company.name,
    reportName: "Punch Logs Report",
    tag: "client",
    requester,
    generatedLabel: report.generatedAt.format("MMM D, YYYY, h:mm A z"),
    timeZone: tz,
  });

  const filterBits = [filters.punchLabel, filters.statusLabel];
  if (team && filters.departmentId) filterBits.push(rows[0]?.department || "one department");
  if (team && filters.employeeIds.length) filterBits.push(`${plural(filters.employeeIds.length, "employee")} chosen`);
  const subtitle = `${filters.rangeLabel} · ${subject} · ${BASIS_LABEL[basis].split(" — ")[0]} · ${filterBits.join(" · ")}`;

  // ── Punches ──
  XL.addTableSheet(book, {
    name: "Punches",
    subtitle,
    freezeColumns: team ? 2 : 1,
    columns: [
      ...(team
        ? [
            { header: "Last name", value: (r) => r.lastName || (!r.firstName ? r.employeeName : null), width: 15 },
            { header: "First name", value: (r) => r.firstName, width: 14 },
            { header: "Employee ID", value: (r) => r.employeeId, width: 11 },
            { header: "Department", value: (r) => r.department, width: 16 },
          ]
        : []),
      { header: "Date", value: (r) => r.date, type: "date" },
      { header: "Time in", value: (r) => stamp(r.clockIn), type: "datetime" },
      { header: "Time out", value: (r) => stamp(r.clockOut), type: "datetime" },
      { header: "Adjusted in review", value: (r) => (r.clockAdjusted ? "Yes" : null), width: 10 },
      { header: "Status", value: (r) => (r.active ? "Active" : "Completed"), width: 10 },
      { header: "Punch type", value: (r) => r.punchLabel, width: 13 },
      { header: "Scheduled", value: (r) => (r.isScheduled ? "Scheduled" : "Unscheduled"), width: 11 },
      { header: "Worked hours", value: (r) => r.worked, type: "hours" },
      { header: "Gross hours", value: (r) => r.gross, type: "hours" },
      ...(hasDriverAide
        ? [
            { header: "Driver/Aide AM", value: (r) => r.am, type: "hours" },
            { header: "Regular", value: (r) => r.regular, type: "hours", width: 9 },
            { header: "Driver/Aide PM", value: (r) => r.pm, type: "hours" },
          ]
        : []),
      { header: "Scheduled hours", value: (r) => r.scheduled, type: "hours" },
      ...(cutoffBasis
        ? []
        : [
            { header: "OT hours", value: (r) => r.otHours, type: "hours", width: 9 },
            { header: "OT status", value: (r) => (r.otStatus && r.otStatus !== "—" ? r.otStatus : null), width: 12 },
          ]),
      { header: "Late hours", value: (r) => r.late, type: "hours", width: 9 },
      { header: "Undertime hours", value: (r) => r.undertime, type: "hours" },
      { header: "Coffee (min)", value: (r) => r.coffeeMinutes, type: "int", width: 9 },
      { header: "Lunch (min)", value: (r) => r.lunchMinutes, type: "int", width: 9 },
      { header: "Lunch start", value: (r) => (r.lunchAuto ? "Auto-deducted" : clock(r.lunchStart)), width: 12 },
      { header: "Lunch end", value: (r) => (r.lunchAuto ? "Auto-deducted" : clock(r.lunchEnd)), width: 12 },
      { header: "Cutoff status", value: (r) => r.cutoffStatus, width: 14 },
      { header: "Data", value: (r) => ROW_BASIS[r.basis], width: 10 },
      { header: "Location required", value: (r) => (r.locationRequired ? "Required" : "None"), width: 10 },
      { header: "Check-in location", value: (r) => r.locationIn, width: 21 },
      { header: "Check-out location", value: (r) => r.locationOut, width: 21 },
      { header: "Device in", value: (r) => r.deviceIn, width: 18 },
      { header: "Device out", value: (r) => r.deviceOut, width: 18 },
    ],
    rows,
    notes: [
      `Dates and times are in ${tz} (the company's time zone). "Adjusted in review" means the reviewed clock time differs from the punch; the reviewed time is shown.`,
      basis !== "preliminary"
        ? "Locked or processed cutoffs show reviewed, payable hours: one row per employee per day, and excluded or rejected punches count as 0."
        : "Live punches show hours as recorded. They can still change when the cutoff is reviewed.",
      cutoffBasis
        ? `Overtime is counted per cutoff (hours above ${hoursLabel(company.otThreshold)} in a cutoff), so it isn't on these rows; see "Overtime by cutoff" on the Summary sheet.`
        : company.isBnC
          ? "OT hours come from the cutoff's daily OT blocks (Approved, Pending or Excluded)."
          : `OT hours are approved OT requests (OT Configuration: over ${hoursLabel(company.otThreshold)} a ${company.otBasis === "weekly" ? "week" : "day"}); "Not requested" means extra time was recorded with no OT request.`,
      "Lunch start and end are clock times; \"Auto-deducted\" means the lunch was deducted without a punch. Locations are latitude, longitude.",
      "This report contains time tracking data and should be handled with care. The requester is recorded above for audit purposes; unauthorized use or distribution may violate company policy.",
    ],
  });

  // ── Summary ──
  const tables = [];
  if (team && byEmployee.length) {
    const avg = (e) => (e.isFixedHours || !e.days ? null : Math.round((e.worked / e.days) * 100) / 100);
    tables.push({
      heading: "By employee",
      columns: [
        { header: "Employee", value: (e) => (e.isFixedHours ? `${e.listName} (fixed hours)` : e.listName) },
        { header: "Worked hours", value: (e) => e.worked, type: "hours" },
        { header: "Scheduled hours", value: (e) => e.scheduled, type: "hours" },
        { header: cutoffBasis ? "Overtime (cutoff)" : "Overtime hours", value: (e) => (cutoffBasis && !periods.length ? null : e.otHours), type: "hours" },
        { header: "Days worked", value: (e) => e.days, type: "int" },
        { header: "Avg hours / day", value: avg, type: "hours" },
        { header: "Late hours", value: (e) => e.late, type: "hours" },
        ...(fixedHours.length ? [{ header: "Fixed hours", value: (e) => e.fixedHours, type: "hours" }] : []),
      ],
      rows: byEmployee,
      totals: {
        label: "Total",
        values: {
          1: s.worked,
          2: s.scheduled,
          3: s.otHours,
          6: s.late,
          ...(fixedHours.length ? { 7: byEmployee.reduce((t, e) => t + (Number(e.fixedHours) || 0), 0) } : {}),
        },
      },
    });
  }
  if (periods.length) {
    tables.push({
      heading: "Cutoff periods",
      columns: [
        { header: "Start", value: (p) => p.start, type: "date" },
        { header: "End", value: (p) => p.end, type: "date" },
        { header: "Department", value: (p) => p.department || "All departments" },
        { header: "Cutoff status", value: (p) => ({ open: "Open", locked: "Locked", processed: "Processed" }[p.status] || p.status) },
        { header: "Data", value: (p) => (p.reviewed ? "Final" : "Preliminary") },
      ],
      rows: periods,
    });
  }
  if (cutoffBasis && periods.length) {
    tables.push({
      heading: `Overtime by cutoff (hours above ${hoursLabel(company.otThreshold)})`,
      columns: [
        { header: "Employee", value: (x) => x.listName },
        { header: "Cutoff start", value: (x) => x.periodStart, type: "date" },
        { header: "Cutoff end", value: (x) => x.periodEnd, type: "date" },
        { header: "Overtime hours", value: (x) => x.otHours, type: "hours" },
        { header: "OT status", value: (x) => x.status },
      ],
      rows: cutoffOt,
    });
  }
  if (fixedHours.length) {
    const periodById = new Map(periods.map((p) => [p.id, p]));
    const nameOf = new Map(byEmployee.map((e) => [e.userId, e.listName]));
    tables.push({
      heading: "Fixed hours",
      columns: [
        { header: "Employee", value: (x) => nameOf.get(x.userId) || [x.user?.profile?.lastName, x.user?.profile?.firstName].filter(Boolean).join(", ") || x.user?.email },
        { header: "Cutoff start", value: (x) => periodById.get(x.cutoffPeriodId)?.start, type: "date" },
        { header: "Cutoff end", value: (x) => periodById.get(x.cutoffPeriodId)?.end, type: "date" },
        { header: "Fixed hours", value: (x) => x.hours, type: "hours" },
        { header: "Paid leave", value: (x) => x.leaveHours, type: "hours" },
        { header: "Regular", value: (x) => x.regularHours, type: "hours" },
      ],
      rows: fixedHours,
    });
  }

  XL.addSummarySheet(book, {
    name: "Summary",
    title: "Punch Logs Report — Summary",
    subtitle,
    figures: [
      { label: "Data", value: BASIS_LABEL[basis] },
      ...(team ? [{ label: "Employees", value: s.employees }] : []),
      { label: "Records", value: s.records, note: plural(s.days, "work day") },
      { label: "Active sessions", value: s.active, note: "Still clocked in" },
      { label: "Completed sessions", value: s.completed },
      { label: "Scheduled sessions", value: s.scheduledRecords, note: "A shift was assigned that day" },
      { hours: true, label: "Worked hours", value: s.worked, note: basis === "preliminary" ? "As recorded" : "Payable hours" },
      { hours: true, label: "Gross hours", value: s.gross, note: "Clock-in to clock-out, before breaks" },
      { hours: true, label: "Scheduled hours", value: s.scheduled },
      { hours: true, label: "Overtime hours", value: s.otHours, note: cutoffBasis && !periods.length ? "Counted per cutoff — choose cutoff periods to see it" : undefined },
      { hours: true, label: "Late hours", value: s.late },
      ...(s.pendingReview ? [{ label: "Rows pending review", value: s.pendingReview }] : []),
    ],
    tables,
    notes: [
      "This report contains time tracking data and should be handled with care. The requester is recorded above for audit purposes; unauthorized use or distribution may violate company policy.",
    ],
  });

  return XL.finish(book);
}

module.exports = { generatePunchLogsReportXlsx };
