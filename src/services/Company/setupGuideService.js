// src/services/Company/setupGuideService.js
//
// BB-115 — "Set up your business" guide for new companies. A new company starts
// as a blank canvas (no departments, employees, shifts…). The guide lists the
// setup steps, in order, for the admin panel's left-side checklist.
//
// Most steps tick themselves off: they're worked out from live data on every
// request, so the guide stays right however the setup was done (web, mobile,
// B. Buddy, scripts). Two steps cover settings that already have defaults
// (attendance rules, leave settings). Data can't show whether anyone looked
// at them, so an admin marks them reviewed.
//
// Company.setupGuide (Json, nullable) stores only what can't be derived:
//   { skipped: string[], reviewed: string[], dismissedAt: ISO | null }
// Optional "auto" steps can be skipped. Required steps can't.
//
// Employee counts spread HUMAN_ONLY (B. Buddy is never a person) and leave
// out the owner account (Company.userId).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

const DEFAULT_TZ = "America/Los_Angeles";

class SetupGuideError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Step definitions (order = display order) ────────────────────────────────
//
// kind:  "auto"   — done when the data says so
//        "review" — done when an admin marks it reviewed
// page:  stable key the client maps to its own route
// check: (facts) → { done, current?, target?, detail? }
// appliesTo (optional): (facts) → boolean; the step is left out of the guide when false

const PROFILE_FIELDS = [
  ["addressLine1",  "street address"],
  ["city",          "city"],
  ["state",         "state"],
  ["businessEmail", "business email"],
  ["phoneNumber",   "phone number"],
  ["timeZone",      "time zone"],
];

const STEPS = [
  {
    key: "company_profile",
    title: "Complete your company profile",
    description: "Add your business address, contact details and time zone. The time zone sets the day boundaries for attendance, cutoffs and reports.",
    required: true,
    kind: "auto",
    page: "company_profile",
    dependsOn: [],
    check: (x) => {
      const missing = PROFILE_FIELDS.filter(([f]) => !String(x.company[f] ?? "").trim()).map(([, label]) => label);
      return {
        done: missing.length === 0,
        current: PROFILE_FIELDS.length - missing.length,
        target: PROFILE_FIELDS.length,
        detail: missing.length ? `Missing: ${missing.join(", ")}` : null,
      };
    },
  },
  {
    key: "departments",
    title: "Create your departments",
    description: "Departments group your people. Breaks, cutoffs, supervisors and reports all work by department.",
    required: true,
    kind: "auto",
    page: "departments",
    dependsOn: [],
    check: (x) => ({ done: x.departments > 0, current: x.departments, target: 1 }),
  },
  {
    key: "locations",
    title: "Add work locations",
    description: "Set where employees are allowed to clock in, with a map pin and radius. Skip this if you don't restrict clock-ins by location.",
    required: false,
    kind: "auto",
    page: "locations",
    dependsOn: [],
    check: (x) => ({ done: x.locations > 0, current: x.locations, target: 1 }),
  },
  {
    key: "employees",
    title: "Add your employees",
    description: "Invite the people who'll clock in, request leave and get paid.",
    required: true,
    kind: "auto",
    page: "employees",
    dependsOn: [],
    check: (x) => ({ done: x.employees > 0, current: x.employees, target: 1 }),
  },
  {
    key: "employee_details",
    title: "Assign employees to departments",
    description: "Give every employee a department and hire date. Hire dates drive leave eligibility and anniversaries.",
    required: true,
    kind: "auto",
    page: "employees",
    dependsOn: ["departments", "employees"],
    check: (x) => {
      const complete = x.employees - x.employeesIncomplete;
      return {
        done: x.employees > 0 && x.employeesIncomplete === 0,
        current: complete,
        target: x.employees,
        detail: x.employeesIncomplete ? `${x.employeesIncomplete} employee(s) missing a department or hire date` : null,
      };
    },
  },
  {
    key: "supervisors",
    title: "Assign department supervisors",
    description: "Supervisors approve time logs, overtime and leave for their department.",
    required: false,
    kind: "auto",
    page: "departments",
    dependsOn: ["departments", "employees"],
    check: (x) => ({
      done: x.departments > 0 && x.departmentsWithoutSupervisor === 0,
      current: x.departments - x.departmentsWithoutSupervisor,
      target: x.departments,
    }),
  },
  {
    key: "shifts",
    title: "Create shifts",
    description: "Define your working hours, e.g. 8:00 AM – 5:00 PM. Shifts are the building blocks of schedules.",
    required: true,
    kind: "auto",
    page: "shifts",
    dependsOn: [],
    check: (x) => ({ done: x.shifts > 0, current: x.shifts, target: 1 }),
  },
  {
    key: "schedules",
    title: "Schedule your employees",
    description: "Assign shifts to employees or departments so the system knows who is expected when, and can flag late or missed clock-ins.",
    required: true,
    kind: "auto",
    page: "schedules",
    dependsOn: ["shifts", "employees"],
    check: (x) => {
      const done = x.activeSchedules > 0 || x.upcomingUserShifts > 0;
      return { done, current: done ? 1 : 0, target: 1 };
    },
  },
  {
    key: "cutoff",
    title: "Set up pay periods (cutoffs)",
    description: "Choose how often you pay (weekly, bi-weekly…) and when the first period starts. Time logs are reviewed and approved per cutoff.",
    required: true,
    kind: "auto",
    page: "cutoff_settings",
    dependsOn: [],
    // Company cutoff settings are only used for cutoff-based overtime.
    appliesTo: (x) => x.company.otBasis === "cutoff",
    check: (x) => ({ done: x.cutoffConfigured, current: x.cutoffConfigured ? 1 : 0, target: 1 }),
  },
  {
    // Needs a generated period as well as settings: the nightly job only extends
    // existing periods, so a department with settings alone never gets one.
    key: "department_cutoffs",
    title: "Set up department cutoffs",
    description: "Set each department's cutoff schedule and generate its first periods. Time logs are reviewed and approved per cutoff.",
    required: true,
    kind: "auto",
    page: "cutoff_periods",
    dependsOn: ["departments"],
    check: (x) => {
      const missing = x.departments - x.departmentsWithCutoff;
      return {
        done: x.departments > 0 && missing === 0,
        current: x.departmentsWithCutoff,
        target: x.departments,
        detail: missing > 0 ? `${missing} department(s) still need a cutoff set up` : null,
      };
    },
  },
  {
    key: "attendance_rules",
    title: "Review attendance rules",
    description: "Check the defaults for grace periods, overtime thresholds, breaks and auto clock-out, and change any that don't fit your business.",
    required: false,
    kind: "review",
    page: "attendance_settings",
    dependsOn: [],
    check: () => ({ done: false }),
  },
  {
    key: "leave_policies",
    title: "Create leave types",
    description: "Add the kinds of leave employees can request, e.g. Vacation or Sick Leave, and whether they're paid.",
    required: false,
    kind: "auto",
    page: "leave_policies",
    dependsOn: [],
    check: (x) => ({ done: x.leavePolicies > 0, current: x.leavePolicies, target: 1 }),
  },
  {
    key: "leave_settings",
    title: "Review leave settings",
    description: "Check the leave year start, automatic credit grants and expiration.",
    required: false,
    kind: "review",
    page: "leave_settings",
    dependsOn: ["leave_policies"],
    check: () => ({ done: false }),
  },
  {
    key: "holidays",
    title: "Add this year's holidays",
    description: "List your company holidays so they show on schedules and aren't counted as absences.",
    required: false,
    kind: "auto",
    page: "holidays",
    dependsOn: [],
    check: (x) => ({ done: x.holidaysThisYear > 0, current: x.holidaysThisYear, target: 1 }),
  },
  {
    key: "payroll",
    title: "Set up payroll details",
    description: "Configure payroll and give each employee a pay type and rate. Skip this if you don't run payroll in BizBuddy.",
    required: false,
    kind: "auto",
    page: "payroll_settings",
    dependsOn: ["employees"],
    check: (x) => ({
      done: x.payrollConfigured && x.employees > 0 && x.employeesWithPayroll >= x.employees,
      current: x.employeesWithPayroll,
      target: x.employees,
      detail: !x.payrollConfigured ? "Payroll configuration not set up yet" : null,
    }),
  },
];

const STEP_BY_KEY = new Map(STEPS.map((s) => [s.key, s]));

// ── Stored state ────────────────────────────────────────────────────────────

function readState(raw) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const keys = (v) => (Array.isArray(v) ? v.filter((k) => STEP_BY_KEY.has(k)) : []);
  return {
    skipped:     keys(s.skipped),
    reviewed:    keys(s.reviewed),
    dismissedAt: typeof s.dismissedAt === "string" ? s.dismissedAt : null,
  };
}

// ── Facts (one round of parallel counts) ────────────────────────────────────

async function loadFacts(company) {
  const companyId = company.id;
  const tz = company.timeZone || DEFAULT_TZ;
  const year = moment.tz(tz).year();
  const today = moment.tz(tz).format("YYYY-MM-DD");

  const employeeWhere = {
    ...HUMAN_ONLY,
    companyId,
    status: "active",
    ...(company.userId && { id: { not: company.userId } }),
  };

  const [
    departments,
    departmentsWithoutSupervisor,
    locations,
    employees,
    employeesIncomplete,
    shifts,
    activeSchedules,
    upcomingUserShifts,
    companyCutoff,
    departmentsWithCutoff,
    leavePolicies,
    holidaysThisYear,
    payrollConfig,
    employeesWithPayroll,
  ] = await Promise.all([
    prisma.department.count({ where: { companyId } }),
    prisma.department.count({ where: { companyId, supervisorId: null } }),
    prisma.location.count({ where: { companyId } }),
    prisma.user.count({ where: employeeWhere }),
    prisma.user.count({ where: { ...employeeWhere, OR: [{ departmentId: null }, { hireDate: null }] } }),
    prisma.shift.count({ where: { companyId } }),
    prisma.shiftSchedule.count({ where: { companyId, isActive: true } }),
    prisma.userShift.count({
      where: { assignedDate: { gte: new Date(`${today}T00:00:00.000Z`) }, user: { companyId, ...HUMAN_ONLY } },
    }),
    prisma.companyCutoffSettings.count({ where: { companyId } }),
    prisma.department.count({
      where: { companyId, cutoffSettings: { some: { isActive: true } }, cutoffPeriods: { some: {} } },
    }),
    prisma.leavePolicy.count({ where: { companyId, isArchived: false } }),
    prisma.holiday.count({
      where: { companyId, date: { gte: new Date(`${year}-01-01T00:00:00.000Z`), lte: new Date(`${year}-12-31T00:00:00.000Z`) } },
    }),
    prisma.payrollConfiguration.count({ where: { companyId } }),
    prisma.employeePayrollDetails.count({ where: { user: employeeWhere } }),
  ]);

  return {
    company,
    departments,
    departmentsWithoutSupervisor,
    locations,
    employees,
    employeesIncomplete,
    shifts,
    activeSchedules,
    upcomingUserShifts,
    cutoffConfigured: companyCutoff > 0,
    departmentsWithCutoff,
    leavePolicies,
    holidaysThisYear,
    payrollConfigured: payrollConfig > 0,
    employeesWithPayroll,
  };
}

// ── Checklist ───────────────────────────────────────────────────────────────

const COMPANY_SELECT = {
  id: true, name: true, userId: true, createdAt: true, setupGuide: true,
  addressLine1: true, city: true, state: true, businessEmail: true, phoneNumber: true, timeZone: true,
  otBasis: true,
};

async function loadCompany(companyId) {
  if (!companyId) throw new SetupGuideError(400, "Your account isn't linked to a company.");
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: COMPANY_SELECT });
  if (!company) throw new SetupGuideError(404, "Company not found.");
  return company;
}

// BB-120: steps a viewer can't open are left out of their checklist (and its
// progress). B. Buddy has no payroll access, so it doesn't see the payroll step.
const HIDDEN_FOR_SYSTEM_AGENT = new Set(["payroll"]);

function buildChecklist(company, facts, { isSystemAgent = false } = {}) {
  const state = readState(company.setupGuide);
  const skipped = new Set(state.skipped);
  const reviewed = new Set(state.reviewed);

  const applicable = STEPS.filter(
    (def) => (!def.appliesTo || def.appliesTo(facts)) && !(isSystemAgent && HIDDEN_FOR_SYSTEM_AGENT.has(def.key))
  );
  const steps = applicable.map((def) => {
    const r = def.check(facts);
    let status = "todo";
    if (def.kind === "review" ? reviewed.has(def.key) : r.done) status = def.kind === "review" ? "reviewed" : "done";
    else if (!def.required && def.kind === "auto" && skipped.has(def.key)) status = "skipped";
    return {
      key:         def.key,
      title:       def.title,
      description: def.description,
      required:    def.required,
      kind:        def.kind,
      page:        def.page,
      dependsOn:   def.dependsOn,
      status,
      progress:    r.target !== undefined ? { current: Math.min(r.current ?? 0, r.target), target: r.target } : null,
      detail:      status === "todo" ? r.detail ?? null : null,
      canSkip:     !def.required && def.kind === "auto",
      canReview:   def.kind === "review",
    };
  });

  const finished = (s) => s.status !== "todo";
  const byKey = new Map(steps.map((s) => [s.key, s]));
  for (const s of steps) s.blockedBy = s.dependsOn.filter((k) => byKey.has(k) && !finished(byKey.get(k)));

  const required = steps.filter((s) => s.required);
  const doneCount = steps.filter(finished).length;
  const nextStep = steps.find((s) => !finished(s) && !s.blockedBy.length) ?? steps.find((s) => !finished(s)) ?? null;

  return {
    companyId:  company.id,
    progress: {
      done:          doneCount,
      total:         steps.length,
      percent:       Math.round((doneCount / steps.length) * 100),
      requiredDone:  required.filter(finished).length,
      requiredTotal: required.length,
    },
    isComplete:  required.every(finished), // every required step done
    allFinished: steps.every(finished),    // every step done, reviewed or skipped
    nextStepKey: nextStep?.key ?? null,
    dismissed:   Boolean(state.dismissedAt),
    dismissedAt: state.dismissedAt,
    steps,
  };
}

async function getChecklist(companyId, viewer = {}) {
  const company = await loadCompany(companyId);
  const facts = await loadFacts(company);
  return buildChecklist(company, facts, viewer);
}

// ── Actions ─────────────────────────────────────────────────────────────────

const ACTIONS = ["skip", "unskip", "review", "unreview", "dismiss", "reopen"];

/**
 * @param {string} companyId
 * @param {"skip"|"unskip"|"review"|"unreview"|"dismiss"|"reopen"} action
 * @param {string} [key]  step key (not used by dismiss/reopen)
 * @returns the updated checklist
 */
async function updateGuide(companyId, action, key, viewer = {}) {
  if (!ACTIONS.includes(action)) throw new SetupGuideError(400, "Unknown action.");
  if (viewer.isSystemAgent && key && HIDDEN_FOR_SYSTEM_AGENT.has(key))
    throw new SetupGuideError(403, "This step isn't available to the B. Buddy account.");
  const company = await loadCompany(companyId);
  const state = readState(company.setupGuide);

  if (["skip", "unskip", "review", "unreview"].includes(action)) {
    const def = STEP_BY_KEY.get(key);
    if (!def) throw new SetupGuideError(404, `Unknown step: ${key}`);

    if (action === "skip" || action === "unskip") {
      if (def.required || def.kind !== "auto")
        throw new SetupGuideError(400, `"${def.title}" can't be skipped.`);
      state.skipped = action === "skip"
        ? [...new Set([...state.skipped, key])]
        : state.skipped.filter((k) => k !== key);
    } else {
      if (def.kind !== "review")
        throw new SetupGuideError(400, `"${def.title}" completes automatically and can't be marked reviewed.`);
      state.reviewed = action === "review"
        ? [...new Set([...state.reviewed, key])]
        : state.reviewed.filter((k) => k !== key);
    }
  } else {
    state.dismissedAt = action === "dismiss" ? new Date().toISOString() : null;
  }

  const updated = await prisma.company.update({
    where:  { id: company.id },
    data:   { setupGuide: state },
    select: COMPANY_SELECT,
  });
  const facts = await loadFacts(updated);
  return buildChecklist(updated, facts, viewer);
}

module.exports = { getChecklist, updateGuide, SetupGuideError, STEPS };
