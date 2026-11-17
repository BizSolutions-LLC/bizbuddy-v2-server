// src/services/Features/taskReportFormService.js
//
// BB-129 phase 1: custom clock-out documentation forms (Google Forms style).
//
// Rules (agreed 2026-11-17):
//   - Admins (admin / superadmin) build forms for their own company. Supervisors
//     and employees have no access in phase 1.
//   - Phase 1 is form building only: create, edit, duplicate, archive, restore,
//     delete. Nobody answers forms yet; per-shift assignment, answering, review
//     and PDF come in later phases.
//   - Company.taskReportMode ("freeform" | "forms") is stored by the settings
//     endpoint. Forms can be built whatever the mode is (admins prepare them in
//     advance); the free-form Daily Task Report keeps working in both modes
//     until answering forms ships.
//   - Form names are unique per company among active forms (case-insensitive),
//     so they can be picked by name later.
//   - Archived forms are read-only: restore one before editing it.
//   - Delete is blocked once a form has answers (phase 2): archive it instead.
//     Deleting a form also removes its assignments.
//
// Question shape (stored in TaskReportForm.questions):
//   { id, type, label, helpText, required, options }
//   - id: stable per question (kept from the client when valid, otherwise
//     generated) so later answers can point at it.
//   - options: only for single_choice / checkboxes / dropdown; [] otherwise.

const crypto = require("crypto");
const { prisma } = require("@config/connection");
const assignmentService = require("@services/Features/taskReportFormAssignmentService");

const QUESTION_TYPES = [
  "short_text",
  "paragraph",
  "single_choice",
  "checkboxes",
  "dropdown",
  "yes_no",
  "number",
  "date",
  "time",
];
const CHOICE_TYPES = ["single_choice", "checkboxes", "dropdown"];
const STATUSES = ["active", "archived"];

const MAX_NAME = 120;
const MAX_DESCRIPTION = 1000;
const MAX_QUESTIONS = 100;
const MAX_LABEL = 300;
const MAX_HELP = 500;
const MAX_OPTIONS = 50;
const MAX_OPTION = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

class TaskReportFormError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message, code = "INVALID_FORM") => new TaskReportFormError(400, message, code);

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

const personName = (u) => {
  if (!u) return null;
  const name = `${u.profile?.firstName || ""} ${u.profile?.lastName || ""}`.trim();
  return name || u.email || null;
};

// ── Validation ────────────────────────────────────────────────────────────────

function cleanName(value) {
  const name = cleanText(value);
  if (!name) throw bad("Form name is required.");
  if (name.length > MAX_NAME) throw bad(`Form name can be at most ${MAX_NAME} characters.`);
  return name;
}

function cleanDescription(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw bad("Description must be text.");
  const description = value.trim();
  if (description.length > MAX_DESCRIPTION) throw bad(`Description can be at most ${MAX_DESCRIPTION} characters.`);
  return description || null;
}

function cleanQuestions(questions) {
  if (!Array.isArray(questions)) throw bad("questions must be a list.");
  if (questions.length === 0) throw bad("A form needs at least one question.");
  if (questions.length > MAX_QUESTIONS) throw bad(`A form can have at most ${MAX_QUESTIONS} questions.`);

  const usedIds = new Set();
  return questions.map((q, i) => {
    const n = i + 1;
    if (!q || typeof q !== "object") throw bad(`Question ${n} is not valid.`);

    const type = q.type;
    if (!QUESTION_TYPES.includes(type))
      throw bad(`Question ${n}: type must be one of ${QUESTION_TYPES.join(", ")}.`);

    const label = cleanText(q.label);
    if (!label) throw bad(`Question ${n}: the question text is required.`);
    if (label.length > MAX_LABEL) throw bad(`Question ${n}: the question text can be at most ${MAX_LABEL} characters.`);

    let helpText = null;
    if (q.helpText !== undefined && q.helpText !== null) {
      if (typeof q.helpText !== "string") throw bad(`Question ${n}: help text must be text.`);
      helpText = q.helpText.trim() || null;
      if (helpText && helpText.length > MAX_HELP) throw bad(`Question ${n}: help text can be at most ${MAX_HELP} characters.`);
    }

    let options = [];
    if (CHOICE_TYPES.includes(type)) {
      if (!Array.isArray(q.options) || q.options.length === 0)
        throw bad(`Question ${n}: add at least one option.`);
      if (q.options.length > MAX_OPTIONS) throw bad(`Question ${n}: at most ${MAX_OPTIONS} options.`);
      const seen = new Set();
      options = q.options.map((o, j) => {
        const option = cleanText(o);
        if (!option) throw bad(`Question ${n}: option ${j + 1} is empty.`);
        if (option.length > MAX_OPTION) throw bad(`Question ${n}: option ${j + 1} can be at most ${MAX_OPTION} characters.`);
        const key = option.toLowerCase();
        if (seen.has(key)) throw bad(`Question ${n}: option "${option}" is listed twice.`);
        seen.add(key);
        return option;
      });
    }

    let id = typeof q.id === "string" && ID_PATTERN.test(q.id) && !usedIds.has(q.id) ? q.id : null;
    while (!id || usedIds.has(id)) id = `q_${crypto.randomBytes(6).toString("hex")}`;
    usedIds.add(id);

    return { id, type, label, helpText, required: q.required === true, options };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function assertNameFree(companyId, name, exceptId = null) {
  const clash = await prisma.taskReportForm.findFirst({
    where: {
      companyId,
      status: "active",
      name: { equals: name, mode: "insensitive" },
      ...(exceptId && { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (clash) throw new TaskReportFormError(409, `An active form named "${name}" already exists.`, "FORM_NAME_TAKEN");
}

async function loadOwn(actor, id) {
  const form = await prisma.taskReportForm.findFirst({ where: { id, companyId: actor.companyId } });
  if (!form) throw new TaskReportFormError(404, "Form not found.", "FORM_NOT_FOUND");
  return form;
}

async function peopleById(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
  });
  return new Map(users.map((u) => [u.id, personName(u)]));
}

function shape(form, people, { withQuestions }) {
  const questions = Array.isArray(form.questions) ? form.questions : [];
  return {
    id: form.id,
    name: form.name,
    description: form.description,
    status: form.status,
    questionCount: questions.length,
    requiredCount: questions.filter((q) => q.required).length,
    ...(withQuestions && { questions }),
    archivedAt: form.archivedAt,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
    createdBy: form.createdById ? { id: form.createdById, name: people.get(form.createdById) || null } : null,
    updatedBy: form.updatedById ? { id: form.updatedById, name: people.get(form.updatedById) || null } : null,
  };
}

async function shapeOne(form) {
  const people = await peopleById([form.createdById, form.updatedById]);
  return shape(form, people, { withQuestions: true });
}

// "Copy of X", then "Copy of X (2)", … until the name is free among active forms.
async function copyName(companyId, base) {
  const stem = `Copy of ${base}`.slice(0, MAX_NAME);
  for (let i = 1; i <= 50; i += 1) {
    const suffix = i === 1 ? "" : ` (${i})`;
    const candidate = `${stem.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    const clash = await prisma.taskReportForm.findFirst({
      where: { companyId, status: "active", name: { equals: candidate, mode: "insensitive" } },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new TaskReportFormError(409, "Pick a name for the copy.", "FORM_NAME_TAKEN");
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

/** GET / — ?status=active (default) | archived | all. Questions are left out; open one form for them. */
async function list(actor, query = {}) {
  const status = query.status || "active";
  if (status !== "all" && !STATUSES.includes(status))
    throw bad(`status must be one of: ${[...STATUSES, "all"].join(", ")}.`, "INVALID_QUERY");

  const forms = await prisma.taskReportForm.findMany({
    where: { companyId: actor.companyId, ...(status !== "all" && { status }) },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  const people = await peopleById(forms.flatMap((f) => [f.createdById, f.updatedById]));
  return forms.map((f) => shape(f, people, { withQuestions: false }));
}

/** GET /:id — includes where the form is assigned and how many answers it has (phase 2). */
async function getOne(actor, id) {
  const form = await loadOwn(actor, id);
  const [shaped, assigned, responseCount] = await Promise.all([
    shapeOne(form),
    assignmentService.list(actor),
    prisma.taskReportFormResponse.count({ where: { formId: form.id, companyId: actor.companyId } }),
  ]);
  return {
    ...shaped,
    assignments: assigned.filter((a) => a.form.id === form.id).map(({ form: _f, formArchived: _a, ...a }) => a),
    responseCount,
    canDelete: responseCount === 0,
  };
}

/** POST / — body { name, description?, questions } */
async function create(actor, body = {}) {
  const name = cleanName(body.name);
  const description = cleanDescription(body.description);
  const questions = cleanQuestions(body.questions);
  await assertNameFree(actor.companyId, name);

  const form = await prisma.taskReportForm.create({
    data: {
      companyId: actor.companyId,
      name,
      description,
      questions,
      createdById: actor.id,
      updatedById: actor.id,
    },
  });
  return shapeOne(form);
}

/** PATCH /:id — body { name?, description?, questions? }. Archived forms can't be edited. */
async function update(actor, id, body = {}) {
  const form = await loadOwn(actor, id);
  if (form.status === "archived")
    throw new TaskReportFormError(409, "Restore this form before editing it.", "FORM_ARCHIVED");

  const data = {};
  if (body.name !== undefined) {
    data.name = cleanName(body.name);
    await assertNameFree(actor.companyId, data.name, form.id);
  }
  if (body.description !== undefined) data.description = cleanDescription(body.description);
  if (body.questions !== undefined) data.questions = cleanQuestions(body.questions);
  if (Object.keys(data).length === 0) throw bad("Nothing to update.", "NOTHING_TO_UPDATE");

  const updated = await prisma.taskReportForm.update({
    where: { id: form.id },
    data: { ...data, updatedById: actor.id },
  });
  return shapeOne(updated);
}

/** POST /:id/duplicate — body { name? }. Works for archived forms too; the copy is active. */
async function duplicate(actor, id, body = {}) {
  const form = await loadOwn(actor, id);
  let name;
  if (body.name !== undefined && body.name !== null && cleanText(body.name)) {
    name = cleanName(body.name);
    await assertNameFree(actor.companyId, name);
  } else {
    name = await copyName(actor.companyId, form.name);
  }

  const copy = await prisma.taskReportForm.create({
    data: {
      companyId: actor.companyId,
      name,
      description: form.description,
      questions: form.questions,
      createdById: actor.id,
      updatedById: actor.id,
    },
  });
  return shapeOne(copy);
}

/** POST /:id/archive */
async function archive(actor, id) {
  const form = await loadOwn(actor, id);
  if (form.status === "archived") return shapeOne(form);
  const updated = await prisma.taskReportForm.update({
    where: { id: form.id },
    data: { status: "archived", archivedAt: new Date(), updatedById: actor.id },
  });
  return shapeOne(updated);
}

/** POST /:id/restore — fails if an active form already uses the same name. */
async function restore(actor, id) {
  const form = await loadOwn(actor, id);
  if (form.status === "active") return shapeOne(form);
  await assertNameFree(actor.companyId, form.name, form.id);
  const updated = await prisma.taskReportForm.update({
    where: { id: form.id },
    data: { status: "active", archivedAt: null, updatedById: actor.id },
  });
  return shapeOne(updated);
}

/** DELETE /:id — only while the form has no answers; its assignments go with it. */
async function remove(actor, id) {
  const form = await loadOwn(actor, id);
  const answers = await prisma.taskReportFormResponse.count({ where: { formId: form.id, companyId: actor.companyId } });
  if (answers > 0)
    throw new TaskReportFormError(409, "This form has answers, so it can't be deleted. Archive it instead.", "FORM_HAS_RESPONSES");
  await prisma.taskReportForm.delete({ where: { id: form.id } });
  return { id: form.id };
}

module.exports = {
  TaskReportFormError,
  QUESTION_TYPES,
  list,
  getOne,
  create,
  update,
  duplicate,
  archive,
  restore,
  remove,
};
