// src/services/Features/taskReportFormResponseService.js
//
// BB-129 phase 2: employees answering custom forms (one answer set per punch).
//
// Rules (agreed 2026-11-18):
//   - Only when Company.taskReportEnabled is on AND taskReportMode = "forms".
//     The two modes are exclusive: in "forms" mode free-form can't be written,
//     in "freeform" mode questionnaires can't be answered. Anything already
//     submitted stays readable either way.
//   - A punch's form is resolved by taskReportFormAssignmentService (shift →
//     employee → department → all) and frozen on the first save (snapshot), so
//     later form edits or re-assignments never change it.
//   - Answer window: Company.taskReportFormWindowHours after clock-out (default
//     336 h = 14 days). closesAt is fixed on the first save. After it, nothing
//     can be saved; a draft then reads as "incomplete" (computed, no job) and is
//     locked as it is.
//   - Submitting locks the answers. Required questions are checked on submit only.
//   - Drafts are private. Supervisors (department + direct reports) and admins
//     see submitted and incomplete answers, view only. No PDF yet.
//   - B. Buddy can't answer (routes use blockSystemAgent).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { inspectFacePhoto } = require("@utils/facePhoto");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const assignments = require("@services/Features/taskReportFormAssignmentService");

const DEFAULT_TZ = "America/Los_Angeles";
const MANAGER_ROLES = ["admin", "superadmin"];
const MAX_RANGE_DAYS = 93;
const MAX_SHORT = 500;
const MAX_PARAGRAPH = 5000;

class TaskReportFormResponseError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const err = (status, message, code) => new TaskReportFormResponseError(status, message, code);

const zoneOf = (company) => (company?.timeZone && moment.tz.zone(company.timeZone) ? company.timeZone : DEFAULT_TZ);
const ymdInZone = (date, tz) => moment(date).tz(tz).format("YYYY-MM-DD");
const ymdOf = (date) => moment.utc(date).format("YYYY-MM-DD"); // @db.Date → "YYYY-MM-DD"
const dbDate = (ymd) => new Date(`${ymd}T00:00:00.000Z`);
const formsOn = (company) => Boolean(company.taskReportEnabled) && company.taskReportMode === "forms";
const effectiveStatus = (r, now = new Date()) =>
  r.status === "draft" && new Date(r.closesAt) < now ? "incomplete" : r.status;

const personName = (u) => {
  const name = `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim();
  return name || u?.email || "Unknown";
};

async function loadCompany(companyId) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true, name: true, timeZone: true,
      taskReportEnabled: true, taskReportMode: true, taskReportFormWindowHours: true,
    },
  });
  if (!company) throw err(404, "Company not found.");
  return company;
}

const windowMs = (company) => (company.taskReportFormWindowHours ?? 336) * 3600000;

async function loadUser(userId) {
  return prisma.user.findUnique({ where: { id: userId }, select: { id: true, companyId: true, departmentId: true } });
}

function parseRange(query, tz) {
  const parse = (v) => {
    const m = moment.tz(String(v || ""), "YYYY-MM-DD", true, tz);
    if (!m.isValid()) throw err(400, "Dates must be YYYY-MM-DD.", "INVALID_QUERY");
    return m.format("YYYY-MM-DD");
  };
  const to = query.to ? parse(query.to) : moment.tz(tz).format("YYYY-MM-DD");
  const from = query.from ? parse(query.from) : moment.tz(to, tz).subtract(30, "days").format("YYYY-MM-DD");
  if (from > to) throw err(400, "from must be on or before to.", "INVALID_QUERY");
  if (moment(to).diff(moment(from), "days") > MAX_RANGE_DAYS)
    throw err(400, `The range can be at most ${MAX_RANGE_DAYS} days.`, "INVALID_QUERY");
  return { from, to };
}

const snapshotOf = (form) => ({
  id: form.id,
  name: form.name,
  description: form.description ?? null,
  questions: Array.isArray(form.questions) ? form.questions : [],
});

// ── Answer validation ─────────────────────────────────────────────────────────

const isEmpty = (v) =>
  v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);

function cleanAnswer(q, v, n) {
  const fail = (msg) => {
    throw err(400, `Question ${n} ("${q.label}"): ${msg}`, "INVALID_ANSWER");
  };
  const options = Array.isArray(q.options) ? q.options : [];
  switch (q.type) {
    case "short_text":
    case "paragraph": {
      if (typeof v !== "string") fail("must be text.");
      const text = v.trim();
      const max = q.type === "short_text" ? MAX_SHORT : MAX_PARAGRAPH;
      if (text.length > max) fail(`at most ${max} characters.`);
      return text;
    }
    case "single_choice":
    case "dropdown":
      if (typeof v !== "string" || !options.includes(v)) fail("pick one of the listed options.");
      return v;
    case "checkboxes": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !options.includes(x)))
        fail("pick from the listed options.");
      return options.filter((o) => v.includes(o)); // de-duplicated, in form order
    }
    case "yes_no":
      if (typeof v !== "boolean") fail("must be yes or no.");
      return v;
    case "number": {
      const num = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
      if (!Number.isFinite(num)) fail("must be a number.");
      return num;
    }
    case "date":
      if (typeof v !== "string" || !moment(v, "YYYY-MM-DD", true).isValid()) fail("must be a date (YYYY-MM-DD).");
      return v;
    case "time":
      if (typeof v !== "string" || !moment(v, "HH:mm", true).isValid()) fail("must be a time (HH:mm, 24-hour).");
      return v;
    default:
      fail("unknown question type.");
  }
  return null;
}

/** Returns { questionId: value } for the snapshot's questions; unknown ids are dropped. */
function cleanAnswers(questions, answers, { submit }) {
  if (answers !== undefined && answers !== null && (typeof answers !== "object" || Array.isArray(answers)))
    throw err(400, "answers must be an object of { questionId: value }.", "INVALID_ANSWER");
  const input = answers || {};
  const out = {};
  questions.forEach((q, i) => {
    const v = input[q.id];
    if (isEmpty(v)) {
      if (submit && q.required) throw err(400, `Question ${i + 1} ("${q.label}") is required.`, "REQUIRED_ANSWER");
      return;
    }
    out[q.id] = cleanAnswer(q, v, i + 1);
  });
  return out;
}

const answeredCount = (answers) => Object.keys(answers && typeof answers === "object" ? answers : {}).length;

// ── Shapes ────────────────────────────────────────────────────────────────────

function shapeResponse(r, now = new Date()) {
  const form = r.form || {};
  const questions = Array.isArray(form.questions) ? form.questions : [];
  return {
    id: r.id,
    timeLogId: r.timeLogId,
    punchDate: ymdOf(r.punchDate),
    status: effectiveStatus(r, now),
    form: { id: form.id ?? r.formId, name: form.name ?? null, description: form.description ?? null, questions },
    answers: r.answers || {},
    answeredCount: answeredCount(r.answers),
    questionCount: questions.length,
    assignedVia: r.assignedVia,
    shiftName: r.shiftName,
    closesAt: r.closesAt,
    submittedAt: r.submittedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const punchShape = (p) => ({ timeLogId: p.id, timeIn: p.timeIn, timeOut: p.timeOut });

// ── Employee ──────────────────────────────────────────────────────────────────

async function loadOwnPunch(actor, timeLogId) {
  const punch = await prisma.timeLog.findUnique({
    where: { id: String(timeLogId) },
    select: { id: true, userId: true, timeIn: true, timeOut: true, taskReportFormResponse: true },
  });
  if (!punch || punch.userId !== actor.id) throw err(404, "Punch not found.", "PUNCH_NOT_FOUND");
  if (!punch.timeOut) throw err(409, "Clock out first. The questionnaire opens after clock-out.", "STILL_CLOCKED_IN");
  return punch;
}

/** GET /me/pending — closed punches still inside the answer window with an unsubmitted questionnaire. */
async function pending(actor) {
  const company = await loadCompany(actor.companyId);
  const tz = zoneOf(company);
  const base = { enabled: formsOn(company), windowHours: company.taskReportFormWindowHours, timeZone: tz, items: [] };
  if (!base.enabled) return base;

  const now = new Date();
  const punches = await prisma.timeLog.findMany({
    where: { userId: actor.id, timeOut: { not: null, gte: new Date(now.getTime() - windowMs(company)) } },
    select: { id: true, timeIn: true, timeOut: true, taskReportFormResponse: true },
    orderBy: { timeOut: "desc" },
  });

  const open = punches.filter((p) => !p.taskReportFormResponse);
  const user = await loadUser(actor.id);
  const resolved = await assignments.resolveForPunches(user, open, tz);

  for (const p of punches) {
    const r = p.taskReportFormResponse;
    if (r) {
      if (effectiveStatus(r, now) !== "draft") continue; // submitted or closed
      base.items.push({
        ...punchShape(p),
        closesAt: r.closesAt,
        form: { id: r.form?.id ?? r.formId, name: r.form?.name ?? null },
        shiftName: r.shiftName,
        assignedVia: r.assignedVia,
        response: { id: r.id, status: "draft", answeredCount: answeredCount(r.answers) },
      });
      continue;
    }
    const hit = resolved.get(p.id);
    if (!hit) continue;
    base.items.push({
      ...punchShape(p),
      closesAt: new Date(p.timeOut.getTime() + windowMs(company)),
      form: { id: hit.form.id, name: hit.form.name },
      shiftName: hit.shift?.name ?? null,
      assignedVia: hit.assignedVia,
      response: null,
    });
  }
  return base;
}

/** GET /me/punch/:timeLogId — the questionnaire for one punch (saved answers, or the form it would get). */
async function openForPunch(actor, timeLogId) {
  const company = await loadCompany(actor.companyId);
  const tz = zoneOf(company);
  const punch = await loadOwnPunch(actor, timeLogId);
  const now = new Date();
  const enabled = formsOn(company);

  const r = punch.taskReportFormResponse;
  if (r) {
    const shaped = shapeResponse(r, now);
    return {
      enabled, timeZone: tz, punch: punchShape(punch),
      canEdit: enabled && shaped.status === "draft",
      response: shaped,
      form: shaped.form,
      shiftName: r.shiftName,
      closesAt: r.closesAt,
    };
  }

  if (!enabled) throw err(403, "Questionnaires are turned off for your company.", "TASK_REPORT_FORMS_OFF");
  const user = await loadUser(actor.id);
  const hit = (await assignments.resolveForPunches(user, [punch], tz)).get(punch.id);
  if (!hit) throw err(404, "There is no questionnaire for this punch.", "NO_FORM");
  const closesAt = new Date(punch.timeOut.getTime() + windowMs(company));
  return {
    enabled, timeZone: tz, punch: punchShape(punch),
    canEdit: now <= closesAt,
    response: null,
    form: snapshotOf(hit.form),
    shiftName: hit.shift?.name ?? null,
    assignedVia: hit.assignedVia,
    closesAt,
  };
}

function requireFacePhoto(file) {
  const inspected = inspectFacePhoto(file);
  if (!inspected.ok) throw err(400, inspected.message, "FACE_PHOTO_REQUIRED");
  return inspected;
}

function photoData(file, inspected) {
  if (!file || !inspected) return {};
  return {
    facePhotoFileName: inspected.name,
    facePhotoMimeType: inspected.mime,
    facePhotoBytes: file.buffer,
  };
}

function parseAnswersField(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw err(400, "answers must be an object of { questionId: value }.", "INVALID_ANSWER");
  }
}

/** PUT /me/punch/:timeLogId — body { answers, submit }. Saves a draft or submits (locks). */
async function saveForPunch(actor, timeLogId, body = {}, file) {
  const company = await loadCompany(actor.companyId);
  if (!formsOn(company)) throw err(403, "Questionnaires are turned off for your company.", "TASK_REPORT_FORMS_OFF");
  const tz = zoneOf(company);
  const punch = await loadOwnPunch(actor, timeLogId);
  const now = new Date();
  const submit = body.submit === true || body.submit === "true";
  const inspected = submit || file ? requireFacePhoto(file) : null;
  const photo = photoData(file, inspected);

  const answersInput = typeof body.answers === "string" ? parseAnswersField(body.answers) : body.answers;
  const existing = punch.taskReportFormResponse;
  if (existing) {
    if (existing.status === "submitted") throw err(409, "This questionnaire is already submitted and locked.", "RESPONSE_LOCKED");
    if (new Date(existing.closesAt) < now) throw err(409, "The time to answer this questionnaire has passed.", "RESPONSE_CLOSED");
    const questions = Array.isArray(existing.form?.questions) ? existing.form.questions : [];
    const answers = cleanAnswers(questions, answersInput, { submit });
    const updated = await prisma.taskReportFormResponse.update({
      where: { id: existing.id },
      data: { answers, ...photo, ...(submit && { status: "submitted", submittedAt: now }) },
    });
    return shapeResponse(updated, now);
  }

  const closesAt = new Date(punch.timeOut.getTime() + windowMs(company));
  if (closesAt < now) throw err(409, "The time to answer this questionnaire has passed.", "RESPONSE_CLOSED");
  const user = await loadUser(actor.id);
  const hit = (await assignments.resolveForPunches(user, [punch], tz)).get(punch.id);
  if (!hit) throw err(404, "There is no questionnaire for this punch.", "NO_FORM");

  const form = snapshotOf(hit.form);
  const answers = cleanAnswers(form.questions, answersInput, { submit });
  try {
    const created = await prisma.taskReportFormResponse.create({
      data: {
        companyId: actor.companyId,
        userId: actor.id,
        timeLogId: punch.id,
        punchDate: dbDate(ymdInZone(punch.timeIn, tz)),
        formId: form.id,
        form,
        assignedVia: hit.assignedVia,
        shiftId: hit.shift?.id ?? null,
        shiftName: hit.shift?.name ?? null,
        answers,
        status: submit ? "submitted" : "draft",
        closesAt,
        submittedAt: submit ? now : null,
        ...photo,
      },
    });
    return shapeResponse(created, now);
  } catch (e) {
    // Two saves raced (double click / two devices): the other one created it first.
    if (e?.code === "P2002") throw err(409, "This questionnaire was just saved elsewhere. Reload and try again.", "RESPONSE_CONFLICT");
    throw e;
  }
}

/** GET /me/responses?from&to — own answers in a range (drafts included), by punch date. */
async function listMine(actor, query = {}) {
  const company = await loadCompany(actor.companyId);
  const tz = zoneOf(company);
  const { from, to } = parseRange(query, tz);
  const now = new Date();
  const rows = await prisma.taskReportFormResponse.findMany({
    where: { userId: actor.id, punchDate: { gte: dbDate(from), lte: dbDate(to) } },
    include: { timeLog: { select: { timeIn: true, timeOut: true } } },
    orderBy: [{ punchDate: "desc" }, { createdAt: "desc" }],
  });
  return {
    enabled: formsOn(company),
    timeZone: tz,
    from,
    to,
    responses: rows.map((r) => {
      const s = shapeResponse(r, now);
      delete s.answers;
      return { ...s, form: { id: s.form.id, name: s.form.name }, punch: { timeIn: r.timeLog?.timeIn, timeOut: r.timeLog?.timeOut } };
    }),
  };
}

// ── Viewing one (owner, supervisor, admin) ───────────────────────────────────

async function supervisorCanSee(actor, user) {
  if (MANAGER_ROLES.includes(actor.role)) return true;
  if (actor.role !== "supervisor") return false;
  if (user.employmentDetail?.supervisorId === actor.id) return true;
  const me = await prisma.user.findUnique({ where: { id: actor.id }, select: { departmentId: true } }); // req.user has no departmentId
  return Boolean(me?.departmentId && user.departmentId === me.departmentId);
}

/** GET /responses/:id — owner sees any status; supervisors/admins only submitted or incomplete, in scope. */
async function getOne(actor, id) {
  const company = await loadCompany(actor.companyId);
  const tz = zoneOf(company);
  const r = await prisma.taskReportFormResponse.findUnique({
    where: { id: String(id) },
    include: {
      timeLog: { select: { timeIn: true, timeOut: true } },
      user: {
        select: {
          id: true, email: true, employeeId: true, departmentId: true,
          profile: { select: { firstName: true, lastName: true } },
          department: { select: { name: true } },
          employmentDetail: { select: { jobTitle: true, supervisorId: true } },
        },
      },
    },
  });
  const notFound = err(404, "Questionnaire not found.", "RESPONSE_NOT_FOUND");
  if (!r || r.companyId !== actor.companyId) throw notFound;

  const now = new Date();
  const shaped = shapeResponse(r, now);
  const isOwner = r.userId === actor.id;
  if (!isOwner) {
    if (shaped.status === "draft") throw notFound;
    if (!(await supervisorCanSee(actor, r.user))) throw notFound;
  }
  return {
    ...shaped,
    timeZone: tz,
    isOwner,
    canEdit: isOwner && formsOn(company) && shaped.status === "draft",
    punch: { timeIn: r.timeLog?.timeIn, timeOut: r.timeLog?.timeOut },
    employee: {
      id: r.user.id,
      name: personName(r.user),
      employeeId: r.user.employeeId ?? null,
      jobTitle: r.user.employmentDetail?.jobTitle ?? null,
      department: r.user.department?.name ?? null,
    },
  };
}

/** For the PDF: same access as getOne, and the questionnaire must be submitted. */
async function loadForPdf(actor, id) {
  const view = await getOne(actor, id);
  if (view.status !== "submitted")
    throw err(409, "Only a submitted questionnaire has a PDF.", "NOT_SUBMITTED");
  const company = await loadCompany(actor.companyId);
  return {
    company: { id: company.id, name: company.name, timeZone: view.timeZone },
    employee: view.employee,
    response: view,
  };
}

function pdfFileName(view) {
  const safe = (s) => String(s || "").replace(/[^a-z0-9-]+/gi, "_").replace(/^_+|_+$/g, "");
  const r = view.response;
  return `BizBuddy_${safe(r.form.name) || "Questionnaire"}_${safe(view.employee.name) || "Employee"}_${r.punchDate}.pdf`;
}

// ── Employee Report page rows (called by dailyTaskReportService.listTeam) ────

/**
 * Submitted + incomplete questionnaires for the team list, already in the
 * Employee Report row shape with kind "form". userWhere = the caller's scope.
 */
async function listTeamRows(actor, { from, to, userId, departmentId }, userWhere) {
  const now = new Date();
  const rows = await prisma.taskReportFormResponse.findMany({
    where: {
      companyId: actor.companyId,
      punchDate: { gte: dbDate(from), lte: dbDate(to) },
      OR: [{ status: "submitted" }, { status: "draft", closesAt: { lt: now } }],
      ...(userId && { userId: String(userId) }),
      user: { ...HUMAN_ONLY, ...userWhere, ...(departmentId && { departmentId: String(departmentId) }) },
    },
    include: {
      timeLog: { select: { timeIn: true, timeOut: true } },
      user: {
        select: {
          id: true, email: true, employeeId: true,
          profile: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ punchDate: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((r) => {
    const s = shapeResponse(r, now);
    return {
      id: r.id,
      kind: "form",
      reportDate: s.punchDate,
      status: s.status, // "submitted" | "incomplete"
      formName: s.form.name,
      shiftName: r.shiftName,
      answeredCount: s.answeredCount,
      questionCount: s.questionCount,
      timeLogId: r.timeLogId,
      punch: { timeIn: r.timeLog?.timeIn, timeOut: r.timeLog?.timeOut },
      submittedAt: r.submittedAt,
      closesAt: r.closesAt,
      employee: {
        id: r.user.id,
        name: personName(r.user),
        employeeId: r.user.employeeId ?? null,
        department: r.user.department?.name ?? null,
      },
    };
  });
}

// ── Clock-out prompt ──────────────────────────────────────────────────────────

/**
 * For the clock-out response: { timeLogId, form: { id, name }, shiftName,
 * closesAt } when this punch has a questionnaire, else null. Never throws.
 */
async function clockOutPrompt(userId, timeLog) {
  try {
    const user = await loadUser(userId);
    if (!user?.companyId || !timeLog?.timeOut) return null;
    const company = await loadCompany(user.companyId);
    if (!formsOn(company)) return null;
    const tz = zoneOf(company);
    const hit = (await assignments.resolveForPunches(user, [timeLog], tz)).get(timeLog.id);
    if (!hit) return null;
    return {
      timeLogId: timeLog.id,
      form: { id: hit.form.id, name: hit.form.name },
      shiftName: hit.shift?.name ?? null,
      closesAt: new Date(new Date(timeLog.timeOut).getTime() + windowMs(company)),
    };
  } catch (e) {
    console.error(`[BB-129 forms] clockOutPrompt failed for ${timeLog?.id}:`, e.message);
    return null;
  }
}

async function loadOpenPunch(actor) {
  const punch = await prisma.timeLog.findFirst({
    where: { userId: actor.id, timeOut: null, status: true },
    orderBy: { timeIn: "desc" },
  });
  if (!punch) throw err(404, "You are not clocked in.", "NO_OPEN_PUNCH");
  return punch;
}

/** GET /me/open — questionnaire for the still-open punch, or required: false. */
async function openForActivePunch(actor) {
  const company = await loadCompany(actor.companyId);
  const punch = await loadOpenPunch(actor);
  if (!formsOn(company)) return { required: false, timeLogId: punch.id };
  const user = await loadUser(actor.id);
  const tz = zoneOf(company);
  const hit = (await assignments.resolveForPunches(user, [punch], tz)).get(punch.id);
  if (!hit) return { required: false, timeLogId: punch.id };
  return {
    required: true,
    timeLogId: punch.id,
    assignedVia: hit.assignedVia,
    shift: hit.shift ? { id: hit.shift.id, name: hit.shift.name } : null,
    form: snapshotOf(hit.form),
  };
}

/**
 * Decide whether this clock-out must include a submitted questionnaire.
 * Returns { apply: false } or { apply: true, response }. Throws on invalid input.
 * Does not write.
 */
async function prepareClockOutTaskReport(actor, activeLog, { isMultipart, answersRaw, file }) {
  const company = await loadCompany(actor.companyId);
  if (!formsOn(company)) return { apply: false };
  const user = await loadUser(actor.id);
  const tz = zoneOf(company);
  const hit = (await assignments.resolveForPunches(user, [activeLog], tz)).get(activeLog.id);
  if (!hit) return { apply: false };
  if (!isMultipart || answersRaw == null || answersRaw === "") {
    throw err(400, "Finish the end-of-shift form, including the face photo, before clocking out.", "TASK_REPORT_FORMS_REQUIRED");
  }
  const answers = parseAnswersField(answersRaw);
  const inspected = requireFacePhoto(file);
  const form = snapshotOf(hit.form);
  const cleaned = cleanAnswers(form.questions, answers, { submit: true });
  const now = new Date();
  return {
    apply: true,
    response: {
      companyId: actor.companyId,
      userId: actor.id,
      timeLogId: activeLog.id,
      punchDate: dbDate(ymdInZone(activeLog.timeIn, tz)),
      formId: form.id,
      form,
      assignedVia: hit.assignedVia,
      shiftId: hit.shift?.id ?? null,
      shiftName: hit.shift?.name ?? null,
      answers: cleaned,
      status: "submitted",
      closesAt: now,
      submittedAt: now,
      ...photoData(file, inspected),
    },
  };
}

module.exports = {
  TaskReportFormResponseError,
  pending,
  openForPunch,
  saveForPunch,
  listMine,
  getOne,
  loadForPdf,
  pdfFileName,
  listTeamRows,
  clockOutPrompt,
  openForActivePunch,
  prepareClockOutTaskReport,
};
