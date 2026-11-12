// src/services/Reports/departmentReportService.js
//
// BB-119: the Departments report, built on the server (was lib/exports/departments.js
// on the client). One data set feeds both the PDF and the CSV.
//
// Scope: admin/superadmin get every department (search and filters on the page
// don't apply). Supervisors get only their own department; req.user carries no
// departmentId, so it is read from the database.
//
// Headcounts are real people only (HUMAN_ONLY): a department's supervisor is
// counted only if they are a member — the old client export added 1.
//
// Time & pay settings mirror how the system applies them:
//   - Lunch paid (Department.paidBreak): unpaid lunches are deducted.
//   - Coffee breaks: coffeeBreakMaxCount × coffeeBreakMinutes, paid or not.
//   - Auto lunch / auto coffee (autoBreakService): only used when the company's
//     autoBreakBasis is "department" AND the company switch (autoLunchEnabled /
//     autoCoffeeEnabled) is on. Otherwise the report says why they don't apply.
//   - Fixed hours (BB-089): fixedHoursPerCutoff when fixedHoursEnabled.
//   - Cutoff schedule: an active DepartmentCutoffSettings row for the
//     department, else "Company schedule".

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

const FREQUENCY = { "bi-weekly": "Bi-weekly", "bi-monthly": "Bi-monthly", monthly: "Monthly", weekly: "Weekly" };

const personName = (u) => {
  const name = `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim();
  return name || u?.email || null;
};
const calYmd = (d) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null);
const hours = (h) => (h == null ? null : `${Number(h)} h`);

/**
 * @param {{ id: string, role: string, companyId: string }} actor  req.user
 */
async function buildDepartmentReport(actor) {
  const [company, me] = await Promise.all([
    prisma.company.findUnique({
      where: { id: actor.companyId },
      select: { id: true, name: true, timeZone: true, autoBreakBasis: true, autoLunchEnabled: true, autoCoffeeEnabled: true },
    }),
    prisma.user.findUnique({
      where: { id: actor.id },
      select: { email: true, isSystemAgent: true, departmentId: true, profile: { select: { firstName: true, lastName: true } } },
    }),
  ]);
  if (!company) throw new ReportError(404, "Company not found.");
  const tz = company.timeZone || DEFAULT_TZ;

  const isSupervisor = actor.role === "supervisor";
  if (isSupervisor && !me?.departmentId) throw new ReportError(403, "You aren't assigned to a department.");

  const [departments, members, cutoffs] = await Promise.all([
    prisma.department.findMany({
      where: { companyId: actor.companyId, ...(isSupervisor && { id: me.departmentId }) },
      select: {
        id: true,
        name: true,
        createdAt: true,
        paidBreak: true,
        breakDuration: true,
        coffeeBreakMaxCount: true,
        coffeeBreakMinutes: true,
        coffeeBreakPaid: true,
        autoLunchEntitled: true,
        autoBreakLunchMinutes: true,
        autoBreakLunchAfterHours: true,
        autoBreakLunchDeductible: true,
        autoCoffeeEntitled: true,
        autoBreakCoffeeMinutes: true,
        autoBreakCoffeeCount: true,
        autoBreakCoffeeDeductible: true,
        fixedHoursEnabled: true,
        fixedHoursPerCutoff: true,
        supervisor: { select: { email: true, status: true, profile: { select: { firstName: true, lastName: true } } } },
      },
    }),
    prisma.user.findMany({
      where: { ...HUMAN_ONLY, companyId: actor.companyId, ...(isSupervisor && { departmentId: me.departmentId }) },
      select: { departmentId: true, status: true, employmentDetail: { select: { employmentStatus: true } } },
    }),
    prisma.departmentCutoffSettings.findMany({
      where: { companyId: actor.companyId, isActive: true, departmentId: { not: null } },
      select: { departmentId: true, frequency: true, startDate: true, paymentOffsetDays: true },
    }),
  ]);

  // Company-level state of automatic breaks (autoBreakService).
  const basis = company.autoBreakBasis || null;
  const autoState = {
    basis,
    lunchOn: basis === "department" && company.autoLunchEnabled,
    coffeeOn: basis === "department" && company.autoCoffeeEnabled,
    note:
      basis === "shift"
        ? "Automatic breaks in this company follow each shift's settings, so the department values below aren't used."
        : basis !== "department"
          ? "Automatic breaks are turned off for this company, so the department values below aren't used."
          : !company.autoLunchEnabled || !company.autoCoffeeEnabled
            ? `Automatic ${[!company.autoLunchEnabled && "lunch", !company.autoCoffeeEnabled && "coffee"].filter(Boolean).join(" and ")} ${!company.autoLunchEnabled && !company.autoCoffeeEnabled ? "are" : "is"} switched off for the whole company.`
            : null,
  };

  const counts = new Map();
  const tally = (key) => {
    if (!counts.has(key)) counts.set(key, { total: 0, active: 0, inactive: 0, fullTime: 0, partTime: 0 });
    return counts.get(key);
  };
  for (const m of members) {
    const c = tally(m.departmentId || "");
    c.total += 1;
    if (m.status === "active") c.active += 1;
    else c.inactive += 1;
    if (m.employmentDetail?.employmentStatus === "full_time") c.fullTime += 1;
    if (m.employmentDetail?.employmentStatus === "part_time") c.partTime += 1;
  }
  const cutoffBy = new Map(cutoffs.map((c) => [c.departmentId, c]));

  const rows = departments
    .map((d) => {
      const c = counts.get(d.id) || { total: 0, active: 0, inactive: 0, fullTime: 0, partTime: 0 };
      const cut = cutoffBy.get(d.id);
      return {
        name: d.name,
        supervisorName: d.supervisor ? personName(d.supervisor) : null,
        supervisorEmail: d.supervisor?.email || null,
        supervisorInactive: !!d.supervisor && d.supervisor.status !== "active",
        ...c,
        createdOn: d.createdAt ? moment(d.createdAt).tz(tz).format("YYYY-MM-DD") : null,
        lunchPaid: !!d.paidBreak,
        breakDuration: d.breakDuration ?? null,
        coffeeCount: d.coffeeBreakMaxCount || 0,
        coffeeMinutes: d.coffeeBreakMinutes || 0,
        coffeePaid: !!d.coffeeBreakPaid,
        autoLunch: d.autoLunchEntitled
          ? { minutes: d.autoBreakLunchMinutes ?? 60, afterHours: d.autoBreakLunchAfterHours ?? 4, deducted: !!d.autoBreakLunchDeductible }
          : null,
        autoCoffee: d.autoCoffeeEntitled
          ? { count: Math.max(1, d.autoBreakCoffeeCount ?? 1), minutes: d.autoBreakCoffeeMinutes ?? 15, deducted: !!d.autoBreakCoffeeDeductible }
          : null,
        fixedHours: d.fixedHoursEnabled ? Number(d.fixedHoursPerCutoff) : null,
        cutoff: cut
          ? { frequency: FREQUENCY[cut.frequency] || cut.frequency, startDate: calYmd(cut.startDate), paymentOffsetDays: cut.paymentOffsetDays }
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const unassigned = isSupervisor ? null : counts.get("") || null;
  const inDepartments = rows.reduce((t, r) => t + r.total, 0);

  return {
    company: { name: company.name, timeZone: tz },
    requester: await resolveRequester(actor, me),
    scope: isSupervisor
      ? { label: "Your department", detail: rows[0]?.name || "Your department" }
      : { label: "Whole company", detail: "Every department" },
    generatedAt: moment().tz(tz),
    autoState,
    rows,
    unassigned,
    summary: {
      departments: rows.length,
      withSupervisor: rows.filter((r) => r.supervisorName).length,
      withoutSupervisor: rows.filter((r) => !r.supervisorName).length,
      inactiveSupervisor: rows.filter((r) => r.supervisorInactive).length,
      inDepartments,
      activeInDepartments: rows.reduce((t, r) => t + r.active, 0),
      unassigned: unassigned?.total || 0,
      fixedHours: rows.filter((r) => r.fixedHours != null).length,
      ownCutoff: rows.filter((r) => r.cutoff).length,
    },
  };
}

// ── Text used by both the PDF and the CSV ──

const coffeeText = (r) => (r.coffeeCount ? `${r.coffeeCount} × ${r.coffeeMinutes} min, ${r.coffeePaid ? "paid" : "unpaid"}` : "None");
const autoLunchText = (r) => (r.autoLunch ? `${r.autoLunch.minutes} min after ${r.autoLunch.afterHours} h, ${r.autoLunch.deducted ? "deducted" : "not deducted"}` : "Off");
const autoCoffeeText = (r) => (r.autoCoffee ? `${r.autoCoffee.count} × ${r.autoCoffee.minutes} min, ${r.autoCoffee.deducted ? "deducted" : "not deducted"}` : "Off");
const fixedText = (r) => (r.fixedHours != null ? `${hours(r.fixedHours)} per cutoff` : "Off");
const cutoffText = (r, fmtDate) =>
  r.cutoff ? `${r.cutoff.frequency} from ${fmtDate(r.cutoff.startDate)}, paid +${r.cutoff.paymentOffsetDays} d` : "Company schedule";

const csvHeaders = (report) => [
  "Department",
  "Supervisor",
  "Supervisor email",
  "Supervisor account",
  "Employees",
  "Active",
  "Inactive",
  "Full-time",
  "Part-time",
  `Created on (${report.company.timeZone})`,
  "Lunch paid",
  "Coffee breaks",
  "Coffee break minutes",
  "Coffee breaks paid",
  "Auto lunch",
  "Auto lunch minutes",
  "Auto lunch after hours",
  "Auto lunch deducted",
  "Auto coffee",
  "Auto coffee count",
  "Auto coffee minutes",
  "Auto coffee deducted",
  "Fixed hours per cutoff",
  "Cutoff schedule",
  "Cutoff start date",
  "Payday offset days",
];

const yn = (v) => (v ? "Yes" : "No");

function departmentsCsvRows(report) {
  return report.rows.map((r) => [
    r.name,
    r.supervisorName,
    r.supervisorEmail,
    r.supervisorName ? (r.supervisorInactive ? "Inactive" : "Active") : null,
    r.total,
    r.active,
    r.inactive,
    r.fullTime,
    r.partTime,
    r.createdOn,
    yn(r.lunchPaid),
    r.coffeeCount,
    r.coffeeCount ? r.coffeeMinutes : null,
    r.coffeeCount ? yn(r.coffeePaid) : null,
    yn(r.autoLunch),
    r.autoLunch?.minutes ?? null,
    r.autoLunch?.afterHours ?? null,
    r.autoLunch ? yn(r.autoLunch.deducted) : null,
    yn(r.autoCoffee),
    r.autoCoffee?.count ?? null,
    r.autoCoffee?.minutes ?? null,
    r.autoCoffee ? yn(r.autoCoffee.deducted) : null,
    r.fixedHours,
    r.cutoff ? r.cutoff.frequency : "Company schedule",
    r.cutoff?.startDate ?? null,
    r.cutoff?.paymentOffsetDays ?? null,
  ]);
}

const reportFileName = (report, ext) =>
  `BizBuddy_Departments_${report.requester.fileName}_${report.generatedAt.format("YYYY-MM-DD_HH-mm")}.${ext}`;

module.exports = {
  buildDepartmentReport,
  departmentsCsvRows,
  csvHeaders,
  reportFileName,
  ReportError,
  coffeeText,
  autoLunchText,
  autoCoffeeText,
  fixedText,
  cutoffText,
};
