// src/utils/generateEmployeesReportPDF.js
//
// BB-119: the Employees report as a US Letter landscape PDF on the shared
// report layout (Client report). Data comes from employeeReportService.

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");

const { THEME, PILL, mm } = L;

const STATUS_PILL = {
  active: { label: "Active", ...PILL.ok },
  inactive: { label: "Inactive", ...PILL.neutral },
  deleted: { label: "Deleted", ...PILL.bad },
};

const dash = { text: "—", color: THEME.faint };
const txt = (v, extra = {}) => (v == null || v === "" ? dash : { text: String(v), ...extra });
const num = (n) => (n ? { text: String(n) } : { text: "0", color: THEME.faint });
const fmtDate = (ymd) => (ymd ? moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY") : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} report  from buildEmployeeReport
 * @returns {Promise<Buffer>}
 */
function generateEmployeesReportPDF(report) {
  try {
    const { company, requester, scope, summary: s, rows } = report;
    const generatedLabel = report.generatedAt.format("MMM D, YYYY, h:mm A z");

    const w = L.createReport({
      orientation: "landscape",
      tag: "client",
      company: company.name,
      reportName: "Employees Report",
      eyebrow: "People & organization",
      generatedLabel,
      continuation: { title: "Employees Report", detail: company.name },
      info: { Title: `BizBuddy Employees Report — ${company.name}`, Subject: "Company employees" },
    });

    // ── Title and meta ──
    L.title(w, "Employees Report", `${plural(s.total, "employee")}  ·  ${s.active} active`);
    L.metaStrip(w, [
      { label: "Company", value: company.name },
      { label: "Requested by", value: requester.name, sub: requester.email },
      { label: "Generated", value: generatedLabel },
      { label: "Times shown in", value: `${L.zoneCity(company.timeZone)} time`, sub: company.timeZone },
      { label: "Scope", value: scope.label, sub: `${scope.detail} · all account statuses` },
    ]);

    // ── Summary ──
    L.sectionTitle(w, "Summary");
    L.kpiTiles(w, [
      { label: "Employees", value: String(s.total), sub: `${s.active} active · ${s.inactive} inactive` },
      { label: "Active accounts", value: String(s.active), sub: s.total ? `${Math.round((s.active / s.total) * 100)}% of employees` : "—" },
      { label: "Full-time", value: String(s.fullTime), sub: `${s.partTime} part-time · ${s.employmentNotSet} not set` },
      { label: "Departments", value: String(s.departments), sub: s.noDepartment ? `${plural(s.noDepartment, "employee")} without one` : "Everyone assigned" },
      { label: "Supervisors", value: String(s.supervisors), sub: "Employees with the supervisor role" },
    ]);

    if (report.byDepartment.length) {
      L.sectionTitle(w, "By department");
      const totals = report.byDepartment.reduce(
        (t, d) => ({ total: t.total + d.total, active: t.active + d.active, inactive: t.inactive + d.inactive, fullTime: t.fullTime + d.fullTime, partTime: t.partTime + d.partTime }),
        { total: 0, active: 0, inactive: 0, fullTime: 0, partTime: 0 }
      );
      L.table(
        w,
        [
          { label: "Department", width: null, cell: (d) => (d.isTotal ? { text: "Total" } : { text: d.name, color: d.none ? THEME.muted : THEME.ink }) },
          { label: "Department supervisor", width: 170, cell: (d) => (d.isTotal ? { text: "" } : txt(d.supervisor)) },
          { label: "Employees", width: 72, align: "right", cell: (d) => ({ text: String(d.total), bold: true }) },
          { label: "Active", width: 64, align: "right", cell: (d) => num(d.active) },
          { label: "Inactive", width: 64, align: "right", cell: (d) => num(d.inactive) },
          { label: "Full-time", width: 68, align: "right", cell: (d) => num(d.fullTime) },
          { label: "Part-time", width: 68, align: "right", cell: (d) => num(d.partTime) },
        ],
        [...report.byDepartment, { isTotal: true, ...totals }],
        { isTotal: (d) => d.isTotal }
      );
    }

    if (report.byRole.length) {
      L.sectionTitle(w, "By role");
      L.table(
        w,
        [
          { label: "Role", width: null, cell: (r) => ({ text: r.role }) },
          { label: "Employees", width: 72, align: "right", cell: (r) => ({ text: String(r.total), bold: true }) },
          { label: "Active", width: 64, align: "right", cell: (r) => num(r.active) },
          { label: "Inactive", width: 64, align: "right", cell: (r) => num(r.total - r.active) },
        ],
        report.byRole
      );
    }

    // ── Employees ── start on a new page unless the header and a few rows fit.
    L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * 5);
    L.sectionTitle(w, "Employees", { note: `${plural(rows.length, "employee")}, sorted by last name` });
    if (!rows.length) {
      L.paragraph(w, "No employees in this scope.", { color: THEME.muted });
    } else {
      L.table(
        w,
        [
          { label: "Employee ID", width: 52, cell: (r) => txt(r.employeeId, { mono: true, size: 7 }) },
          { label: "Name", width: null, cell: (r) => txt(r.lastName || r.firstName ? `${r.lastName}${r.lastName && r.firstName ? ", " : ""}${r.firstName}` : r.name) },
          { label: "Role", width: 54, cell: (r) => txt(r.roleLabel) },
          { label: "Department", width: 84, cell: (r) => txt(r.department) },
          { label: "Job title", width: 86, cell: (r) => txt(r.jobTitle) },
          {
            label: "Supervisor",
            width: 96,
            cell: (r) => (r.supervisorName ? { text: `${r.supervisorName}${r.supervisorSource === "Department" ? " (dept)" : ""}` } : dash),
          },
          { label: "Employment", width: 54, cell: (r) => txt(r.employment) },
          { label: "Type", width: 34, cell: (r) => txt(r.type) },
          { label: "Location", width: 48, cell: (r) => txt(r.location) },
          { label: "Hire date", width: 58, cell: (r) => txt(fmtDate(r.hireDate)) },
          { label: "Status", width: 52, cell: (r) => ({ pill: STATUS_PILL[r.status] || { label: r.statusLabel, ...PILL.neutral } }) },
        ],
        rows,
        { striped: true }
      );
    }

    L.endNote(w, [
      "Supervisor is the employee's direct supervisor; \"(dept)\" means none is set, so their department's supervisor applies.",
      "Inactive accounts are signed out and receive no notifications. Hire dates are the calendar dates entered for each employee.",
      "The CSV export has every field, including email, exempt status, probation end date, driver and last sign-in.",
    ]);
    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

module.exports = { generateEmployeesReportPDF };
