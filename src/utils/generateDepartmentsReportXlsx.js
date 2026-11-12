// src/utils/generateDepartmentsReportXlsx.js
//
// BB-119: the Departments report as an Excel workbook on the shared template
// (utils/xlsx/reportWorkbook.js). Same data as the PDF and CSV
// (departmentReportService.buildDepartmentReport).
//
//   Sheet "Departments": one row per department — headcounts, then its time &
//                        pay settings in readable form, totals row, filters.
//   Sheet "Summary":     headline figures and the company-level notes.

const moment = require("moment-timezone");
const XL = require("@utils/xlsx/reportWorkbook");
const { coffeeText, autoLunchText, autoCoffeeText, cutoffText } = require("@services/Reports/departmentReportService");

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtDate = (ymd) => (ymd ? moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY") : "");

/**
 * @param {object} report  from buildDepartmentReport
 * @returns {Promise<Buffer>}
 */
function generateDepartmentsReportXlsx(report) {
  const { company, requester, scope, rows, summary: s, autoState, unassigned } = report;
  const tz = company.timeZone;

  const book = XL.createWorkbook({
    company: company.name,
    reportName: "Departments Report",
    tag: "client",
    requester,
    generatedLabel: report.generatedAt.format("MMM D, YYYY, h:mm A z"),
    timeZone: tz,
  });
  const subtitle = `${scope.label} · ${plural(s.departments, "department")} · ${plural(s.inDepartments, "employee")}`;

  // A department's auto-break value is "(not used)" when a company setting keeps it off.
  const autoLunch = (r) => (r.autoLunch && !autoState.lunchOn ? `${autoLunchText(r)} (not used)` : autoLunchText(r));
  const autoCoffee = (r) => (r.autoCoffee && !autoState.coffeeOn ? `${autoCoffeeText(r)} (not used)` : autoCoffeeText(r));

  const notes = [
    "Employees counts real people only, including inactive accounts. Full-time and part-time come from each employee's employment details.",
    "Lunch paid: when No, lunch breaks are deducted from worked hours. Auto lunch and auto coffee are added when an employee doesn't take the break themselves; \"(not used)\" means a company setting keeps them off.",
    "Fixed hours: a flat number of hours per cutoff covers the department's scheduled duty (BB-089). Cutoff schedule: \"Company schedule\" means the department follows the company's cutoffs.",
  ];
  if (autoState.note) notes.unshift(autoState.note);
  if (unassigned?.total) notes.push(`${plural(unassigned.total, "employee")} ${unassigned.total === 1 ? "isn't" : "aren't"} in any department (${unassigned.active} active).`);

  XL.addTableSheet(book, {
    name: "Departments",
    subtitle,
    freezeColumns: 1,
    columns: [
      { header: "Department", value: (r) => r.name, width: 24 },
      { header: "Supervisor", value: (r) => r.supervisorName || "No supervisor", width: 20 },
      { header: "Supervisor email", value: (r) => r.supervisorEmail, width: 26 },
      { header: "Supervisor account", value: (r) => (r.supervisorName ? (r.supervisorInactive ? "Inactive" : "Active") : null), width: 11 },
      { header: "Employees", value: (r) => r.total, type: "int" },
      { header: "Active", value: (r) => r.active, type: "int", width: 8 },
      { header: "Inactive", value: (r) => r.inactive, type: "int", width: 8 },
      { header: "Full-time", value: (r) => r.fullTime, type: "int", width: 9 },
      { header: "Part-time", value: (r) => r.partTime, type: "int", width: 9 },
      { header: "Lunch paid", value: (r) => (r.lunchPaid ? "Yes" : "No"), width: 9 },
      { header: "Coffee breaks", value: (r) => coffeeText(r), width: 22 },
      { header: "Auto lunch", value: (r) => autoLunch(r), width: 30 },
      { header: "Auto coffee", value: (r) => autoCoffee(r), width: 28 },
      { header: "Fixed hours per cutoff", value: (r) => r.fixedHours, type: "hours", width: 12 },
      { header: "Cutoff schedule", value: (r) => cutoffText(r, fmtDate), width: 34 },
      { header: "Created on", value: (r) => r.createdOn, type: "date" },
    ],
    rows,
    totals: { label: "Total", values: { 4: s.inDepartments, 5: s.activeInDepartments, 6: rows.reduce((t, r) => t + r.inactive, 0), 7: rows.reduce((t, r) => t + r.fullTime, 0), 8: rows.reduce((t, r) => t + r.partTime, 0) } },
    notes,
  });

  XL.addSummarySheet(book, {
    name: "Summary",
    title: "Departments Report — Summary",
    subtitle,
    figures: [
      { label: "Departments", value: s.departments },
      { label: "With a supervisor", value: s.withSupervisor, note: s.inactiveSupervisor ? `${s.inactiveSupervisor} with an inactive supervisor` : undefined },
      { label: "Without a supervisor", value: s.withoutSupervisor },
      { label: "Employees in departments", value: s.inDepartments, note: `${s.activeInDepartments} active` },
      ...(scope.label === "Whole company" ? [{ label: "Employees without a department", value: s.unassigned }] : []),
      { label: "Departments on fixed hours", value: s.fixedHours },
      { label: "Departments with their own cutoff schedule", value: s.ownCutoff },
    ],
    notes: autoState.note ? [autoState.note] : [],
  });

  return XL.finish(book);
}

module.exports = { generateDepartmentsReportXlsx };
