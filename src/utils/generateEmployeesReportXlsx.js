// src/utils/generateEmployeesReportXlsx.js
//
// BB-119: the Employees report as an Excel workbook on the shared template
// (utils/xlsx/reportWorkbook.js). Same data as the PDF and CSV
// (employeeReportService.buildEmployeeReport).
//
//   Sheet "Employees": every employee, every field, filter buttons, name columns frozen.
//   Sheet "Summary":   headcounts, by department and by role.

const XL = require("@utils/xlsx/reportWorkbook");

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} report  from buildEmployeeReport
 * @returns {Promise<Buffer>}
 */
function generateEmployeesReportXlsx(report) {
  const { company, requester, scope, rows, summary: s, byDepartment, byRole } = report;
  const tz = company.timeZone;

  const book = XL.createWorkbook({
    company: company.name,
    reportName: "Employees Report",
    tag: "client",
    requester,
    generatedLabel: report.generatedAt.format("MMM D, YYYY, h:mm A z"),
    timeZone: tz,
  });
  const subtitle = `${scope.label} · ${plural(s.total, "employee")} (${s.active} active, ${s.inactive} inactive)`;

  XL.addTableSheet(book, {
    name: "Employees",
    subtitle,
    freezeColumns: 3,
    columns: [
      { header: "Employee ID", value: (r) => r.employeeId, width: 13 },
      { header: "Last name", value: (r) => r.lastName || (!r.firstName ? r.name : null), width: 16 },
      { header: "First name", value: (r) => r.firstName, width: 16 },
      { header: "Email", value: (r) => r.email, width: 28 },
      { header: "Role", value: (r) => r.roleLabel, width: 11 },
      { header: "Account status", value: (r) => r.statusLabel, width: 12 },
      { header: "Department", value: (r) => r.department, width: 20 },
      { header: "Job title", value: (r) => r.jobTitle, width: 20 },
      { header: "Supervisor", value: (r) => r.supervisorName, width: 20 },
      { header: "Supervisor email", value: (r) => r.supervisorEmail, width: 26 },
      { header: "Supervisor source", value: (r) => r.supervisorSource, width: 12 },
      { header: "Employment", value: (r) => r.employment, width: 12 },
      { header: "Employment type", value: (r) => r.type, width: 12 },
      { header: "Exempt status", value: (r) => r.exempt, width: 12 },
      { header: "Work location", value: (r) => r.location, width: 12 },
      { header: "Driver", value: (r) => (r.isDriver ? "Yes" : "No"), width: 8 },
      { header: "Hire date", value: (r) => r.hireDate, type: "date" },
      { header: "Probation end", value: (r) => r.probationEndDate, type: "date" },
      { header: "Last sign-in", value: (r) => r.lastLoginAt, type: "datetime" },
      { header: "Added on", value: (r) => r.addedOn, type: "date" },
    ],
    rows,
    notes: [
      `Last sign-in and Added on are in ${tz} (the company's time zone). Hire and probation dates are calendar dates.`,
      "Supervisor source: Direct = the employee's own supervisor; Department = their department's supervisor (no direct supervisor set).",
      "Inactive and deleted accounts are included with their status.",
    ],
  });

  XL.addSummarySheet(book, {
    name: "Summary",
    title: "Employees Report — Summary",
    subtitle,
    figures: [
      { label: "Employees", value: s.total },
      { label: "Active", value: s.active },
      { label: "Inactive or deleted", value: s.inactive },
      { label: "Full-time", value: s.fullTime },
      { label: "Part-time", value: s.partTime },
      ...(s.employmentNotSet ? [{ label: "Employment not set", value: s.employmentNotSet, note: "No full-time or part-time setting" }] : []),
      { label: "Departments", value: s.departments, note: s.noDepartment ? `${plural(s.noDepartment, "employee")} without a department` : undefined },
      { label: "Supervisors", value: s.supervisors },
    ],
    tables: [
      {
        heading: "By department",
        columns: [
          { header: "Department", value: (d) => d.name },
          { header: "Supervisor", value: (d) => d.supervisor },
          { header: "Employees", value: (d) => d.total, type: "int" },
          { header: "Active", value: (d) => d.active, type: "int" },
          { header: "Inactive", value: (d) => d.inactive, type: "int" },
          { header: "Full-time", value: (d) => d.fullTime, type: "int" },
          { header: "Part-time", value: (d) => d.partTime, type: "int" },
        ],
        rows: byDepartment,
        totals: { label: "Total", values: { 2: s.total, 3: s.active, 4: s.inactive, 5: s.fullTime, 6: s.partTime } },
      },
      {
        heading: "By role",
        columns: [
          { header: "Role", value: (r) => r.role },
          { header: "Employees", value: (r) => r.total, type: "int" },
          { header: "Active", value: (r) => r.active, type: "int" },
        ],
        rows: byRole,
      },
    ],
  });

  return XL.finish(book);
}

module.exports = { generateEmployeesReportXlsx };
