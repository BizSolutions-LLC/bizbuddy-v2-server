// src/services/Features/dailyTaskReportService.js
//
// BB-129: clock-out documentation — the Daily Task Report (trial mode).
//
// Rules (agreed 2026-11-16):
//   - One report per employee per day. The day is the company-zone calendar
//     date of the punches (a punch belongs to the day of its clock-in).
//   - Optional for employees. Only allowed when Company.taskReportEnabled is on
//     and the employee has at least one punch that day. Past days are allowed.
//   - No edit deadline (trial). The owner may edit a report at any time; once
//     submitted, every later save re-submits it (submittedAt = now).
//   - Drafts are private to the employee. Supervisors/admins see submitted
//     reports only, view-only. The PDF exists only for submitted reports.
//   - Web only for now: the mobile app doesn't call these endpoints. The server
//     can't tell web from mobile, so nothing here enforces that.
//
// Times: all shown in the company's time zone (BB-119 rule).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { resolveShiftForTimeLog } = require("@services/timeLogComputeService");
const formResponses = require("@services/Features/taskReportFormResponseService"); // BB-129 phase 2

const DEFAULT_TZ = "America/Los_Angeles";
const MANAGER_ROLES = ["admin", "superadmin"];
const MAX_TASKS = 50;
const MAX_TITLE = 200;
const MAX_NOTE = 1000;
const MAX_RANGE_DAYS = 93;

class TaskReportError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const zoneOf = (company) => (company?.timeZone && moment.tz.zone(company.timeZone) ? company.timeZone : DEFAULT_TZ);
const ymdOf = (date) => moment.utc(date).format("YYYY-MM-DD"); // @db.Date → "YYYY-MM-DD"
const dbDate = (ymd) => new Date(`${ymd}T00:00:00.000Z`);
const shiftTime = (t) => moment.utc(t).format("h:mm A"); // @db.Time holds wall-clock time as UTC

const personName = (u) => {
  const name = `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim();
  return name || u?.email || "Unknown";
};

function parseDate(value, tz) {
  const m = moment.tz(String(value || ""), "YYYY-MM-DD", true, tz);
  if (!m.isValid()) throw new TaskReportError(400, "Date must be YYYY-MM-DD.");
  if (m.isAfter(moment.tz(tz).endOf("day"))) throw new TaskReportError(400, "You can't document a future day.");
  return m.format("YYYY-MM-DD");
}

function parseRange(query, tz) {
  const to = query.to ? parseDate(query.to, tz) : moment.tz(tz).format("YYYY-MM-DD");
  const from = query.from ? parseDate(query.from, tz) : moment.tz(to, tz).subtract(30, "days").format("YYYY-MM-DD");
  if (from > to) throw new TaskReportError(400, "from must be on or before to.");
  if (moment(to).diff(moment(from), "days") > MAX_RANGE_DAYS)
    throw new TaskReportError(400, `The range can be at most ${MAX_RANGE_DAYS} days.`);
  return { from, to };
}

/** Validates and cleans the task list. Returns [{ title, note }]. */
function cleanTasks(tasks, { submit }) {
  if (!Array.isArray(tasks)) throw new TaskReportError(400, "tasks must be a list.");
  if (tasks.length > MAX_TASKS) throw new TaskReportError(400, `A report can have at most ${MAX_TASKS} tasks.`);
  const cleaned = tasks.map((t, i) => {
    const title = typeof t?.title === "string" ? t.title.trim() : "";
    const note = typeof t?.note === "string" ? t.note.trim() : "";
    if (!title) throw new TaskReportError(400, `Task ${i + 1} needs a title.`);
    if (title.length > MAX_TITLE) throw new TaskReportError(400, `Task ${i + 1}: the title can be at most ${MAX_TITLE} characters.`);
    if (note.length > MAX_NOTE) throw new TaskReportError(400, `Task ${i + 1}: the note can be at most ${MAX_NOTE} characters.`);
    return { title, note: note || null };
  });
  if (submit && !cleaned.length) throw new TaskReportError(400, "Add at least one task before submitting.");
  return cleaned;
}

async function loadCompany(companyId) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, timeZone: true, taskReportEnabled: true, taskReportMode: true },
  });
  if (!company) throw new TaskReportError(404, "Company not found.");
  return company;
}

/** The day's punches (clock-in on that company-zone date), oldest first. */
async function punchesForDay(userId, ymd, tz) {
  const start = moment.tz(ymd, "YYYY-MM-DD", tz).startOf("day").toDate();
  const end = moment.tz(ymd, "YYYY-MM-DD", tz).endOf("day").toDate();
  return prisma.timeLog.findMany({
    where: { userId, timeIn: { gte: start, lte: end } },
    select: { id: true, timeIn: true, timeOut: true, punchType: true },
    orderBy: { timeIn: "asc" },
  });
}

/** Raw first clock-in / last clock-out of the day, plus the shift label. */
async function attendanceForDay(userId, ymd, tz) {
  const punches = await punchesForDay(userId, ymd, tz);
  if (!punches.length) return { punchCount: 0, clockIn: null, clockOut: null, stillClockedIn: false, shift: null };

  const first = punches[0];
  const stillClockedIn = punches.some((p) => !p.timeOut);
  const outs = punches.filter((p) => p.timeOut).map((p) => p.timeOut.getTime());
  const clockOut = outs.length ? new Date(Math.max(...outs)) : null;

  let shift = null;
  try {
    const us = await resolveShiftForTimeLog(userId, first.timeIn, first.timeOut || new Date(), tz);
    const startT = us?.customStartTime || us?.shift?.startTime;
    const endT = us?.customEndTime || us?.shift?.endTime;
    if (startT && endT) shift = { name: us.shift?.shiftName || null, start: shiftTime(startT), end: shiftTime(endT) };
  } catch {
    shift = null; // the shift label is decoration only — never fail the report over it
  }

  return { punchCount: punches.length, clockIn: first.timeIn, clockOut, stillClockedIn, shift };
}

function shape(report) {
  if (!report) return null;
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  return {
    id: report.id,
    userId: report.userId,
    reportDate: ymdOf(report.reportDate),
    status: report.status,
    tasks,
    taskCount: tasks.length,
    submittedAt: report.submittedAt,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

// ── Employee (own reports) ───────────────────────────────────────────────────

/** GET /me?from&to — the employee's own reports in a range (drafts included). */
async function listMine(actor, query) {
  const company = await loadCompany(actor.companyId);
  const tz = zoneOf(company);
  const { from, to } = parseRange(query, tz);
  const rows = await prisma.dailyTaskReport.findMany({
    where: { userId: actor.id, reportDate: { gte: dbDate(from), lte: dbDate(to) } },
    orderBy: { reportDate: "desc" },
  });
  return {
    enabled: company.taskReportEnabled,
    timeZone: tz,
    from,
    to,
    reports: rows.map((r) => {
      const s = shape(r);
      delete s.tasks; // the list only needs status + count; open one day for its tasks
      return s;
    }),
  };
}

/** GET /me/:date — the employee's own report for one day (null if none) + attendance. */
async function getMine(actor, date) {
  const company = await loadCompany(actor.companyId);
  const tz = zoneOf(company);
  const ymd = parseDate(date, tz);
  const [report, attendance] = await Promise.all([
    prisma.dailyTaskReport.findUnique({ where: { userId_reportDate: { userId: actor.id, reportDate: dbDate(ymd) } } }),
    attendanceForDay(actor.id, ymd, tz),
  ]);
  return {
    enabled: company.taskReportEnabled,
    mode: company.taskReportMode, // BB-129 phase 2: "forms" = free-form is read-only
    timeZone: tz,
    reportDate: ymd,
    canEdit: company.taskReportEnabled && company.taskReportMode !== "forms" && attendance.punchCount > 0,
    attendance,
    report: shape(report),
  };
}

/** PUT /me/:date — create or update the employee's own report. body { tasks, submit } */
async function saveMine(actor, date, body = {}) {
  const company = await loadCompany(actor.companyId);
  if (!company.taskReportEnabled)
    throw new TaskReportError(403, "Clock-out documentation is turned off for your company.", "TASK_REPORT_DISABLED");
  // BB-129 phase 2: the modes are exclusive — in "forms" mode only questionnaires are written.
  if (company.taskReportMode === "forms")
    throw new TaskReportError(403, "Your company uses questionnaires instead of the daily task report.", "TASK_REPORT_MODE_FORMS");
  const tz = zoneOf(company);
  const ymd = parseDate(date, tz);

  const punches = await punchesForDay(actor.id, ymd, tz);
  if (!punches.length) throw new TaskReportError(400, "You have no punch on this day to document.", "NO_PUNCH");

  const existing = await prisma.dailyTaskReport.findUnique({
    where: { userId_reportDate: { userId: actor.id, reportDate: dbDate(ymd) } },
  });
  // Once submitted, a report stays submitted: every later save re-submits it.
  const submit = Boolean(body.submit) || existing?.status === "submitted";
  const tasks = cleanTasks(body.tasks, { submit });
  const now = new Date();

  const report = await prisma.dailyTaskReport.upsert({
    where: { userId_reportDate: { userId: actor.id, reportDate: dbDate(ymd) } },
    create: {
      companyId: actor.companyId,
      userId: actor.id,
      reportDate: dbDate(ymd),
      tasks,
      status: submit ? "submitted" : "draft",
      submittedAt: submit ? now : null,
    },
    update: {
      tasks,
      status: submit ? "submitted" : "draft",
      ...(submit && { submittedAt: now }),
    },
  });
  return shape(report);
}

// ── Supervisor / admin (view only, submitted reports) ───────────────────────

/** Prisma `where` on User for the people this actor may view. Throws for employees. */
async function teamUserWhere(actor) {
  if (MANAGER_ROLES.includes(actor.role)) return { companyId: actor.companyId };
  if (actor.role === "supervisor") {
    // req.user has no departmentId — load it.
    const me = await prisma.user.findUnique({ where: { id: actor.id }, select: { departmentId: true } });
    return {
      companyId: actor.companyId,
      OR: [{ employmentDetail: { supervisorId: actor.id } }, ...(me?.departmentId ? [{ departmentId: me.departmentId }] : [])],
    };
  }
  throw new TaskReportError(403, "Only supervisors and admins can view team reports.");
}

/**
 * GET /team?from&to&userId&departmentId&include=forms — submitted reports in scope.
 * Every row has kind "freeform". With include=forms (BB-129 phase 2) the list also
 * has questionnaire rows (kind "form": submitted + incomplete), newest first.
 * Without it the response is unchanged, so the current client keeps working.
 */
async function listTeam(actor, query) {
  const company = await loadCompany(actor.companyId);
  const tz = zoneOf(company);
  const { from, to } = parseRange(query, tz);
  const userWhere = await teamUserWhere(actor);

  const rows = await prisma.dailyTaskReport.findMany({
    where: {
      companyId: actor.companyId,
      status: "submitted",
      reportDate: { gte: dbDate(from), lte: dbDate(to) },
      ...(query.userId && { userId: String(query.userId) }),
      user: {
        ...HUMAN_ONLY,
        ...userWhere,
        ...(query.departmentId && { departmentId: String(query.departmentId) }),
      },
    },
    include: {
      user: {
        select: {
          id: true, email: true, employeeId: true,
          profile: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ reportDate: "desc" }, { submittedAt: "desc" }],
  });

  const freeform = rows.map((r) => {
      const s = shape(r);
      delete s.tasks;
      return {
        ...s,
        kind: "freeform",
        employee: {
          id: r.user.id,
          name: personName(r.user),
          employeeId: r.user.employeeId ?? null,
          department: r.user.department?.name ?? null,
        },
      };
    });

  const includeForms = String(query.include || "").split(",").map((x) => x.trim()).includes("forms");
  let reports = freeform;
  if (includeForms) {
    const forms = await formResponses.listTeamRows(
      actor,
      { from, to, userId: query.userId, departmentId: query.departmentId },
      userWhere
    );
    const at = (row) => new Date(row.submittedAt || row.closesAt || 0).getTime();
    reports = [...freeform, ...forms].sort((a, b) =>
      a.reportDate === b.reportDate ? at(b) - at(a) : a.reportDate < b.reportDate ? 1 : -1
    );
  }

  return {
    enabled: company.taskReportEnabled,
    mode: company.taskReportMode,
    timeZone: tz,
    from,
    to,
    reports,
  };
}

/**
 * Loads one report with everything the view/PDF needs, checking access:
 * the owner sees it in any status; supervisors/admins only once submitted
 * and only for people in their scope. Out-of-scope → 404 (don't leak ids).
 */
async function loadForView(actor, { id, ownDate } = {}) {
  const company = await loadCompany(actor.companyId);
  const tz = zoneOf(company);

  const where = ownDate
    ? { userId_reportDate: { userId: actor.id, reportDate: dbDate(parseDate(ownDate, tz)) } }
    : { id: String(id) };
  const report = await prisma.dailyTaskReport.findUnique({
    where,
    include: {
      user: {
        select: {
          id: true, email: true, companyId: true, departmentId: true, isSystemAgent: true,
          profile: { select: { firstName: true, lastName: true } },
          department: { select: { name: true } },
          employmentDetail: { select: { jobTitle: true, supervisorId: true } },
        },
      },
    },
  });
  const notFound = new TaskReportError(404, "Report not found.");
  if (!report || report.companyId !== actor.companyId) throw notFound;

  const isOwner = report.userId === actor.id;
  if (!isOwner) {
    if (report.status !== "submitted") throw notFound;
    if (!MANAGER_ROLES.includes(actor.role)) {
      if (actor.role !== "supervisor") throw notFound;
      const me = await prisma.user.findUnique({ where: { id: actor.id }, select: { departmentId: true } });
      const inScope =
        report.user.employmentDetail?.supervisorId === actor.id ||
        (me?.departmentId && report.user.departmentId === me.departmentId);
      if (!inScope) throw notFound;
    }
  }

  const ymd = ymdOf(report.reportDate);
  const attendance = await attendanceForDay(report.userId, ymd, tz);
  return {
    company: { id: company.id, name: company.name, timeZone: tz },
    employee: {
      id: report.user.id,
      name: personName(report.user),
      jobTitle: report.user.employmentDetail?.jobTitle ?? null,
      department: report.user.department?.name ?? null,
    },
    attendance,
    report: shape(report),
    isOwner,
  };
}

/** For the PDF: the report must be submitted, whoever asks. */
async function loadForPdf(actor, opts) {
  const view = await loadForView(actor, opts);
  if (view.report.status !== "submitted")
    throw new TaskReportError(409, "Submit the report first. The PDF is made from the submitted report.", "NOT_SUBMITTED");
  return view;
}

function pdfFileName(view) {
  const safe = (s) => String(s || "").replace(/[^a-z0-9-]+/gi, "_").replace(/^_+|_+$/g, "");
  return `BizBuddy_DailyTaskReport_${safe(view.employee.name) || "Employee"}_${view.report.reportDate}.pdf`;
}

module.exports = {
  TaskReportError,
  listMine,
  getMine,
  saveMine,
  listTeam,
  loadForView,
  loadForPdf,
  pdfFileName,
};
