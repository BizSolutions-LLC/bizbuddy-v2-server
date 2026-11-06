// src/services/Features/importTargets.js
// Shared by the pre-filled CSV templates: Upload Schedule (BB-103) and Import Punch
// Logs (BB-108). Who is uploading (with their department loaded from the DB), which
// employees a template covers, and the inclusive date range it spans.

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { normalizeDate } = require("@utils/csvScheduleParser");

class ImportError extends Error {
  constructor(status, message, debug) {
    super(message);
    this.status = status;
    // Extra context for the server log only — never sent to the client.
    this.debug = debug;
  }
}

const dayNum = (ymd) => Date.parse(`${ymd}T00:00:00Z`) / 86400000;
const ymdOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const splitIds = (v) =>
  (Array.isArray(v) ? v.join(",") : v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const USER_SELECT = {
  id: true,
  employeeId: true,
  email: true,
  status: true,
  departmentId: true,
  profile: { select: { firstName: true, lastName: true } },
  employmentDetail: { select: { supervisorId: true } },
};

// A supervisor's team — the same rule as GET /employee/team (BB-080) and leave
// approvals: their own department, or a direct report (EmploymentDetail.supervisorId)
// in any department. Admins and superadmins aren't limited.
function teamWhere(actor) {
  if (!actor.scoped) return {};
  return {
    OR: [
      ...(actor.departmentId ? [{ departmentId: actor.departmentId }] : []),
      { employmentDetail: { supervisorId: actor.id } },
    ],
  };
}

// Same rule for a loaded user (needs departmentId + employmentDetail.supervisorId).
function inTeam(actor, user) {
  if (!actor.scoped) return true;
  return (
    (!!actor.departmentId && user.departmentId === actor.departmentId) ||
    user.employmentDetail?.supervisorId === actor.id
  );
}

// "Last, First", falling back to the email.
function displayName(u) {
  const first = u.profile?.firstName?.trim() || "";
  const last = u.profile?.lastName?.trim() || "";
  if (first && last) return `${last}, ${first}`;
  return first || last || u.email;
}

// The uploader, with their department loaded from the DB — req.user only carries
// id/email/role/companyId. Supervisors are limited to their own department.
async function loadActor({ companyId, actingUserId, actingRole }) {
  const u = await prisma.user.findUnique({ where: { id: actingUserId }, select: { departmentId: true } });
  return {
    id: actingUserId,
    companyId,
    role: actingRole,
    departmentId: u?.departmentId ?? null,
    scoped: actingRole === "supervisor",
  };
}

// Inclusive date range, at most maxDays days.
function parseDateRange(startRaw, endRaw, maxDays) {
  const startDate = normalizeDate(startRaw);
  const endDate = normalizeDate(endRaw);
  if (!startDate || !endDate) throw new ImportError(400, "startDate and endDate are required (YYYY-MM-DD).");
  const days = dayNum(endDate) - dayNum(startDate) + 1;
  if (days < 1) throw new ImportError(400, "endDate must be on or after startDate.");
  if (days > maxDays) throw new ImportError(400, `The date range can be at most ${maxDays} days (got ${days}).`);
  return {
    startDate,
    endDate,
    dates: Array.from({ length: days }, (_, i) => ymdOf(dayNum(startDate) + i)),
  };
}

// Template target: everyone in scope (a supervisor's team, or the whole company),
// one department, or specific people. Active employees only. `action` words the
// supervisor-scope error, e.g. "upload schedules".
async function resolveTargetEmployees(actor, { userIds, departmentId }, { action = "do this" } = {}) {
  if (actor.scoped) {
    if (departmentId && departmentId !== actor.departmentId)
      throw new ImportError(403, `You can only ${action} for your own department.`);
  } else if (departmentId) {
    const dept = await prisma.department.findFirst({ where: { id: departmentId, companyId: actor.companyId }, select: { id: true } });
    if (!dept) throw new ImportError(403, "Department not found in your company.");
  }

  const deptFilter = departmentId || null;
  const users = await prisma.user.findMany({
    where: {
      ...HUMAN_ONLY,
      companyId: actor.companyId,
      status: "active",
      ...(deptFilter ? { departmentId: deptFilter } : {}),
      ...teamWhere(actor),
      ...(userIds.length ? { id: { in: userIds } } : {}),
    },
    select: USER_SELECT,
  });
  if (userIds.length && users.length !== new Set(userIds).size) {
    const found = new Set(users.map((u) => u.id));
    const rejected = [...new Set(userIds)].filter((id) => !found.has(id));
    // Why each rejected id was refused (log only).
    const rows = await prisma.user.findMany({
      where: { id: { in: rejected } },
      select: {
        id: true,
        status: true,
        companyId: true,
        departmentId: true,
        isSystemAgent: true,
        employmentDetail: { select: { supervisorId: true } },
      },
    });
    const reasons = rejected.map((id) => {
      const u = rows.find((r) => r.id === id);
      if (!u) return `${id}: no such user id`;
      if (u.companyId !== actor.companyId) return `${id}: other company`;
      if (u.isSystemAgent) return `${id}: B. Buddy`;
      if (u.status !== "active") return `${id}: ${u.status}`;
      if (deptFilter && u.departmentId !== deptFilter) return `${id}: outside department ${deptFilter}`;
      if (!inTeam(actor, u)) return `${id}: not in this supervisor's team`;
      return `${id}: unknown`;
    });
    throw new ImportError(
      403,
      `${rejected.length} of ${new Set(userIds).size} selected employees are inactive or outside your scope.`,
      { rejected: reasons }
    );
  }

  return users.sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

module.exports = {
  ImportError,
  USER_SELECT,
  teamWhere,
  inTeam,
  dayNum,
  ymdOf,
  splitIds,
  displayName,
  loadActor,
  parseDateRange,
  resolveTargetEmployees,
};
