// src/services/Reports/employeeReportService.js
//
// BB-119: the Employees report, built on the server (was lib/exports/employees.js
// on the client). One data set feeds both the PDF and the CSV.
//
// Scope: admin/superadmin get the whole company. Supervisors get their team —
// their department plus their direct reports (EmploymentDetail.supervisorId),
// the same scope as leaves and punch requests (BB-080). req.user carries no
// departmentId, so it is read from the database. B. Buddy is never listed
// (HUMAN_ONLY), and inactive/deleted accounts are included with their status.
//
// Dates: hireDate and probationEndDate hold calendar dates (saved as UTC
// midnight from a date picker), so they're read without conversion. Real
// timestamps (last sign-in, generated) use the company's time zone (BB-119).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { resolveRequester } = require("@services/Reports/reportRequester");

const DEFAULT_TZ = "America/Los_Angeles";

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ROLE = { superadmin: "Superadmin", admin: "Admin", supervisor: "Supervisor", employee: "Employee" };
const ROLE_ORDER = ["superadmin", "admin", "supervisor", "employee"];
const ACCOUNT = { active: "Active", inactive: "Inactive", deleted: "Deleted" };
const EMPLOYMENT = { full_time: "Full-time", part_time: "Part-time" };
const TYPE = { employee_W2: "W-2", contractor_1099: "1099" };
const EXEMPT = { exempt: "Exempt", non_exempt: "Non-exempt" };
const LOCATION = { onsite: "Onsite", remote: "Remote", hybrid: "Hybrid" };

// Calendar dates (YYYY-MM-DD) — read without time-zone conversion.
const calYmd = (d) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null);

const personName = (u) => {
  const name = `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim();
  return name || u?.email || null;
};

const PERSON = { email: true, profile: { select: { firstName: true, lastName: true } } };

/**
 * @param {{ id: string, role: string, companyId: string }} actor  req.user
 * @returns report data for generateEmployeesReportPDF / toEmployeesCsv
 */
async function buildEmployeeReport(actor) {
  const [company, me] = await Promise.all([
    prisma.company.findUnique({ where: { id: actor.companyId }, select: { id: true, name: true, timeZone: true } }),
    prisma.user.findUnique({
      where: { id: actor.id },
      select: { email: true, isSystemAgent: true, departmentId: true, department: { select: { name: true } }, profile: { select: { firstName: true, lastName: true } } },
    }),
  ]);
  if (!company) throw new ReportError(404, "Company not found.");
  const tz = company.timeZone || DEFAULT_TZ;

  const where = { ...HUMAN_ONLY, companyId: actor.companyId };
  let scope = { label: "Whole company", detail: "All departments" };
  if (actor.role === "supervisor") {
    where.OR = [{ employmentDetail: { supervisorId: actor.id } }, ...(me?.departmentId ? [{ departmentId: me.departmentId }] : [])];
    scope = me?.department
      ? { label: "Your team", detail: `${me.department.name} and your direct reports` }
      : { label: "Your team", detail: "Your direct reports" };
  }

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      employeeId: true,
      hireDate: true,
      createdAt: true,
      lastLoginAt: true,
      profile: { select: { firstName: true, lastName: true } },
      department: { select: { id: true, name: true, supervisor: { select: PERSON } } },
      employmentDetail: {
        select: {
          jobTitle: true,
          employmentStatus: true,
          employmentType: true,
          exemptStatus: true,
          workLocation: true,
          probationEndDate: true,
          isDriver: true,
          supervisor: { select: PERSON },
        },
      },
    },
  });

  const rows = users
    .map((u) => {
      const ed = u.employmentDetail || {};
      const direct = ed.supervisor || null;
      const viaDept = !direct ? u.department?.supervisor || null : null;
      const sup = direct || viaDept;
      return {
        employeeId: u.employeeId || null,
        firstName: u.profile?.firstName || "",
        lastName: u.profile?.lastName || "",
        name: personName(u),
        email: u.email,
        role: u.role,
        roleLabel: ROLE[u.role] || u.role,
        status: u.status,
        statusLabel: ACCOUNT[u.status] || u.status,
        departmentId: u.department?.id || null,
        department: u.department?.name || null,
        jobTitle: ed.jobTitle || null,
        supervisorName: sup ? personName(sup) : null,
        supervisorEmail: sup?.email || null,
        supervisorSource: direct ? "Direct" : viaDept ? "Department" : null,
        employmentStatus: ed.employmentStatus || null,
        employment: EMPLOYMENT[ed.employmentStatus] || null,
        type: TYPE[ed.employmentType] || null,
        exempt: EXEMPT[ed.exemptStatus] || null,
        location: LOCATION[ed.workLocation] || null,
        isDriver: !!ed.isDriver,
        hireDate: calYmd(u.hireDate),
        probationEndDate: calYmd(ed.probationEndDate),
        lastLoginAt: u.lastLoginAt ? moment(u.lastLoginAt).tz(tz).format("YYYY-MM-DD HH:mm") : null,
        addedOn: u.createdAt ? moment(u.createdAt).tz(tz).format("YYYY-MM-DD") : null,
      };
    })
    .sort((a, b) => (a.lastName || a.name || "").localeCompare(b.lastName || b.name || "") || (a.firstName || "").localeCompare(b.firstName || ""));

  // ── Summary ──
  const count = (fn) => rows.filter(fn).length;
  const deptMap = new Map();
  for (const r of rows) {
    const key = r.departmentId || "";
    if (!deptMap.has(key)) {
      const dept = users.find((u) => (u.department?.id || "") === key)?.department;
      deptMap.set(key, {
        name: r.department || "No department",
        supervisor: dept?.supervisor ? personName(dept.supervisor) : null,
        none: !key,
        total: 0,
        active: 0,
        inactive: 0,
        fullTime: 0,
        partTime: 0,
      });
    }
    const d = deptMap.get(key);
    d.total += 1;
    if (r.status === "active") d.active += 1;
    else d.inactive += 1;
    if (r.employmentStatus === "full_time") d.fullTime += 1;
    if (r.employmentStatus === "part_time") d.partTime += 1;
  }
  const byDepartment = [...deptMap.values()].sort((a, b) => (a.none - b.none) || a.name.localeCompare(b.name));
  const byRole = ROLE_ORDER.map((role) => ({
    role: ROLE[role],
    total: count((r) => r.role === role),
    active: count((r) => r.role === role && r.status === "active"),
  })).filter((r) => r.total > 0);

  const summary = {
    total: rows.length,
    active: count((r) => r.status === "active"),
    inactive: count((r) => r.status !== "active"),
    fullTime: count((r) => r.employmentStatus === "full_time"),
    partTime: count((r) => r.employmentStatus === "part_time"),
    employmentNotSet: count((r) => !r.employmentStatus),
    departments: byDepartment.filter((d) => !d.none).length,
    noDepartment: count((r) => !r.departmentId),
    supervisors: count((r) => r.role === "supervisor"),
  };

  const now = moment().tz(tz);
  return {
    company: { name: company.name, timeZone: tz },
    requester: await resolveRequester(actor, me),
    scope,
    generatedAt: now,
    rows,
    summary,
    byDepartment,
    byRole,
  };
}

// Last sign-in and Added on are in the company's time zone, named in the header.
const csvHeaders = (report) => [
  "Employee ID",
  "First name",
  "Last name",
  "Email",
  "Role",
  "Account status",
  "Department",
  "Job title",
  "Supervisor",
  "Supervisor email",
  "Supervisor source",
  "Employment",
  "Employment type",
  "Exempt status",
  "Work location",
  "Driver",
  "Hire date",
  "Probation end date",
  `Last sign-in (${report.company.timeZone})`,
  `Added on (${report.company.timeZone})`,
];

/** Clean CSV rows (one header row + data). */
function employeesCsvRows(report) {
  return report.rows.map((r) => [
    r.employeeId,
    r.firstName,
    r.lastName,
    r.email,
    r.roleLabel,
    r.statusLabel,
    r.department,
    r.jobTitle,
    r.supervisorName,
    r.supervisorEmail,
    r.supervisorSource,
    r.employment,
    r.type,
    r.exempt,
    r.location,
    r.isDriver ? "Yes" : "No",
    r.hireDate,
    r.probationEndDate,
    r.lastLoginAt,
    r.addedOn,
  ]);
}

const reportFileName = (report, ext) =>
  `BizBuddy_Employees_${report.requester.fileName}_${report.generatedAt.format("YYYY-MM-DD_HH-mm")}.${ext}`;

module.exports = { buildEmployeeReport, employeesCsvRows, csvHeaders, reportFileName, ReportError };
