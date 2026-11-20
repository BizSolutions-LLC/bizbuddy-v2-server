// src/services/Features/taskReportFormAssignmentService.js
//
// BB-129 phase 2: which custom form goes to whom, and which form a punch gets.
//
// Rules (agreed 2026-11-18):
//   - Four scopes: all | department | employee | shift. One form per target;
//     assigning again replaces the form. Admin / superadmin only.
//   - A punch gets the most specific form: shift → employee → department → all.
//     No match → no questionnaire.
//   - Archived forms are skipped (the punch falls back to the next scope). Their
//     assignments are kept, so restoring the form brings them back.
//   - The punch's shift is the one its clock-in/out overlaps most
//     (matchShiftToWindow, same as cutoffs). Shift dates are read as UTC
//     calendar dates (@db.Date), like timeLogComputeService does. (Until the
//     BB-129 fix of 2026-11-20, resolveShiftForTimeLog used a company-zone day
//     range and picked the next day's shift for zones west of UTC.)

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { matchShiftToWindow } = require("@services/timeLogComputeUtils");

const SCOPES = ["shift", "employee", "department", "all"]; // most specific first
const ALL_TARGET = "*";

class TaskReportFormAssignmentError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const personName = (u) => {
  if (!u) return null;
  const name = `${u.profile?.firstName || ""} ${u.profile?.lastName || ""}`.trim();
  return name || u.email || null;
};
const shiftTime = (t) => moment.utc(t).format("h:mm A"); // @db.Time holds wall-clock time as UTC
const shiftLabel = (s) => (s ? `${s.shiftName} (${shiftTime(s.startTime)} – ${shiftTime(s.endTime)})` : null);

// ── Admin: manage assignments ─────────────────────────────────────────────────

/** GET /assignments — every assignment in the company with target + form names. */
async function list(actor) {
  const rows = await prisma.taskReportFormAssignment.findMany({
    where: { companyId: actor.companyId },
    include: { form: { select: { id: true, name: true, status: true } } },
    orderBy: { createdAt: "asc" },
  });

  const idsOf = (scope) => rows.filter((r) => r.scope === scope).map((r) => r.targetId);
  const [departments, users, shifts] = await Promise.all([
    prisma.department.findMany({ where: { id: { in: idsOf("department") } }, select: { id: true, name: true } }),
    prisma.user.findMany({
      where: { id: { in: idsOf("employee") } },
      select: { id: true, email: true, employeeId: true, profile: { select: { firstName: true, lastName: true } } },
    }),
    prisma.shift.findMany({
      where: { id: { in: idsOf("shift") } },
      select: { id: true, shiftName: true, startTime: true, endTime: true },
    }),
  ]);
  const names = {
    department: new Map(departments.map((d) => [d.id, d.name])),
    employee: new Map(users.map((u) => [u.id, personName(u)])),
    shift: new Map(shifts.map((s) => [s.id, shiftLabel(s)])),
  };

  return rows
    .map((r) => ({
      id: r.id,
      scope: r.scope,
      target:
        r.scope === "all"
          ? null
          : { id: r.targetId, name: names[r.scope]?.get(r.targetId) ?? null, missing: !names[r.scope]?.has(r.targetId) },
      form: r.form,
      formArchived: r.form.status === "archived",
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => SCOPES.indexOf(b.scope) - SCOPES.indexOf(a.scope)); // all → department → employee → shift
}

async function assertTarget(companyId, scope, targetId) {
  const notFound = () => new TaskReportFormAssignmentError(404, `That ${scope} was not found in your company.`, "TARGET_NOT_FOUND");
  if (scope === "department") {
    const d = await prisma.department.findFirst({ where: { id: targetId, companyId }, select: { id: true } });
    if (!d) throw notFound();
  } else if (scope === "employee") {
    const u = await prisma.user.findFirst({ where: { id: targetId, companyId, ...HUMAN_ONLY }, select: { id: true } });
    if (!u) throw notFound();
  } else if (scope === "shift") {
    const s = await prisma.shift.findFirst({ where: { id: targetId, companyId }, select: { id: true } });
    if (!s) throw notFound();
  }
}

/** PUT /assignments — body { scope, targetId?, formId }. Replaces the form if the target already has one. */
async function set(actor, body = {}) {
  const { scope, formId } = body;
  if (!SCOPES.includes(scope))
    throw new TaskReportFormAssignmentError(400, `scope must be one of: ${SCOPES.join(", ")}.`, "INVALID_ASSIGNMENT");

  let targetId = ALL_TARGET;
  if (scope !== "all") {
    if (typeof body.targetId !== "string" || !body.targetId.trim())
      throw new TaskReportFormAssignmentError(400, `Pick a ${scope} to assign the form to.`, "INVALID_ASSIGNMENT");
    targetId = body.targetId.trim();
    await assertTarget(actor.companyId, scope, targetId);
  }

  if (typeof formId !== "string" || !formId)
    throw new TaskReportFormAssignmentError(400, "Pick a form.", "INVALID_ASSIGNMENT");
  const form = await prisma.taskReportForm.findFirst({
    where: { id: formId, companyId: actor.companyId },
    select: { id: true, status: true },
  });
  if (!form) throw new TaskReportFormAssignmentError(404, "Form not found.", "FORM_NOT_FOUND");
  if (form.status === "archived")
    throw new TaskReportFormAssignmentError(409, "Restore this form before assigning it.", "FORM_ARCHIVED");

  const row = await prisma.taskReportFormAssignment.upsert({
    where: { companyId_scope_targetId: { companyId: actor.companyId, scope, targetId } },
    create: { companyId: actor.companyId, scope, targetId, formId, createdById: actor.id },
    update: { formId, createdById: actor.id },
  });
  return (await list(actor)).find((a) => a.id === row.id) || null;
}

/** DELETE /assignments/:id */
async function remove(actor, id) {
  const row = await prisma.taskReportFormAssignment.findFirst({
    where: { id: String(id), companyId: actor.companyId },
    select: { id: true },
  });
  if (!row) throw new TaskReportFormAssignmentError(404, "Assignment not found.", "ASSIGNMENT_NOT_FOUND");
  await prisma.taskReportFormAssignment.delete({ where: { id: row.id } });
  return { id: row.id };
}

// ── Resolution: which form does a punch get ───────────────────────────────────

/** Active-form assignments of a company, indexed by scope → targetId → form. */
async function loadAssignmentIndex(companyId) {
  const rows = await prisma.taskReportFormAssignment.findMany({
    where: { companyId, form: { status: "active" } },
    include: { form: { select: { id: true, name: true, description: true, questions: true } } },
  });
  const index = { shift: new Map(), employee: new Map(), department: new Map(), all: null };
  for (const r of rows) {
    if (r.scope === "all") index.all = r.form;
    else index[r.scope]?.set(r.targetId, r.form);
  }
  index.empty = rows.length === 0;
  return index;
}

/**
 * Builds a function punch → matched Shift (or null) for one user's punches,
 * with two queries in total (daily shifts + recurring schedules).
 */
async function buildShiftMatcher(user, punches, tz) {
  const dayOf = (p) => moment(p.timeIn).tz(tz).format("YYYY-MM-DD");
  const days = [...new Set(punches.map(dayOf))].sort();
  if (days.length === 0) return () => null;
  const first = days[0];
  const last = days[days.length - 1];

  const [userShifts, schedules] = await Promise.all([
    prisma.userShift.findMany({
      where: {
        userId: user.id,
        assignedDate: { gte: new Date(`${first}T00:00:00.000Z`), lte: new Date(`${last}T23:59:59.999Z`) },
        status: { not: "cancelled" },
      },
      include: { shift: true },
      orderBy: { shift: { startTime: "asc" } },
    }),
    prisma.shiftSchedule.findMany({
      where: {
        companyId: user.companyId,
        isActive: true,
        startDate: { lte: new Date(`${last}T00:00:00.000Z`) },
        endDate: { gte: new Date(`${first}T00:00:00.000Z`) },
        OR: [
          { assignmentType: "individual", targetId: user.id },
          { assignmentType: "all" },
          ...(user.departmentId ? [{ assignmentType: "department", targetId: user.departmentId }] : []),
        ],
      },
      include: { shift: true },
    }),
  ]);

  const byDay = new Map();
  for (const us of userShifts) {
    const key = moment.utc(us.assignedDate).format("YYYY-MM-DD");
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(us);
  }
  const PRIORITY = { individual: 0, department: 1, all: 2 };
  schedules.sort((a, b) => (PRIORITY[a.assignmentType] ?? 99) - (PRIORITY[b.assignmentType] ?? 99));

  return (punch) => {
    const ymd = dayOf(punch);
    let candidates = byDay.get(ymd) || [];
    if (candidates.length === 0) {
      // Recurring schedule fallback, same rule as timeLogComputeService.
      const dayStart = new Date(`${ymd}T00:00:00.000Z`);
      const dow = moment(ymd).day();
      const s = schedules.find(
        (x) => x.startDate <= dayStart && x.endDate >= dayStart && Array.isArray(x.daysOfWeek) && x.daysOfWeek.includes(dow)
      );
      if (s?.shift) candidates = [{ id: s.id, shift: s.shift }];
    }
    if (candidates.length === 0) return null;
    const us = matchShiftToWindow(candidates, punch.timeIn, punch.timeOut || punch.timeIn, tz);
    return us?.shift || null;
  };
}

/**
 * Resolves the form for each punch of ONE user.
 * user: { id, companyId, departmentId }. punches: [{ id, timeIn, timeOut }].
 * Returns Map timeLogId → { form, assignedVia, shift: { id, name } | null } | null.
 */
async function resolveForPunches(user, punches, tz, index = null) {
  const idx = index || (await loadAssignmentIndex(user.companyId));
  const out = new Map();
  if (punches.length === 0) return out;
  if (idx.empty) {
    for (const p of punches) out.set(p.id, null); // nothing assigned — skip the shift lookups
    return out;
  }
  const matchShift = await buildShiftMatcher(user, punches, tz);

  for (const p of punches) {
    const shift = matchShift(p);
    const shiftInfo = shift ? { id: shift.id, name: shift.shiftName } : null;
    let hit = null;
    if (shift && idx.shift.has(shift.id)) hit = { form: idx.shift.get(shift.id), assignedVia: "shift" };
    else if (idx.employee.has(user.id)) hit = { form: idx.employee.get(user.id), assignedVia: "employee" };
    else if (user.departmentId && idx.department.has(user.departmentId))
      hit = { form: idx.department.get(user.departmentId), assignedVia: "department" };
    else if (idx.all) hit = { form: idx.all, assignedVia: "all" };
    out.set(p.id, hit ? { ...hit, shift: shiftInfo } : null);
  }
  return out;
}

module.exports = {
  TaskReportFormAssignmentError,
  SCOPES,
  list,
  set,
  remove,
  loadAssignmentIndex,
  resolveForPunches,
};
