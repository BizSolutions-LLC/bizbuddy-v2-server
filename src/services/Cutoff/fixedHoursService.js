// src/services/Cutoff/fixedHoursService.js
//
// BB-089: fixed-hours employees (e.g. some SV staff). An employee is on fixed
// hours when BOTH their own User.fixedHoursEnabled and their department's
// fixedHoursEnabled master switch are on. They are paid the department's flat
// fixedHoursPerCutoff (default 80) per cutoff regardless of their clock-ins:
//   - one CutoffFixedHours row per member per cutoff, created already
//     "approved" — admins can edit its hours (e.g. partial cutoff);
//   - their pending punches on SCHEDULED days are auto-excluded with
//     FIXED_HOURS_NOTE so they stay visible for attendance but never block
//     lock/finalize or count for pay — the flat hours cover scheduled duty,
//     including running past the shift end;
//   - punches on OFF days (no UserShift that date) stay pending with
//     OFF_DAY_NOTE for the admin to approve or exclude; approved off-day hours
//     are paid as OT (cutoffOtService, no threshold). A member with no
//     schedule at all in the cutoff falls back to Sat/Sun as off days, so a
//     missing schedule can't turn every punch into an OT request;
//   - the fixed hours include paid leave: regular = max(0, hours − paid leave).
//
// Only open cutoffs are reconciled — locked/processed cutoffs keep whatever
// rows they had. Membership is the user's *current* department (there is no
// department history), same as every other cutoff department scope.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");

const FIXED_HOURS_NOTE = "Fixed-hours department (BB-089) — not counted for pay";
const OFF_DAY_NOTE     = "Off-day work (BB-089) — paid as OT if approved";

const dateStr = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/**
 * TimeLog ids of `userIds`' punches in this cutoff that fall on an off day —
 * a company-timezone date with no non-cancelled UserShift, or a Sat/Sun for
 * users with no schedule anywhere in the cutoff (see header).
 * @returns {Promise<Set<string>>}
 */
async function getOffDayTimeLogIds(cutoffPeriod, userIds) {
  if (!userIds.length) return new Set();

  const company = await prisma.company.findUnique({
    where:  { id: cutoffPeriod.companyId },
    select: { timeZone: true },
  });
  const tz = company?.timeZone || "America/Los_Angeles";

  const [approvals, shifts] = await Promise.all([
    prisma.timeLogApproval.findMany({
      where:  { cutoffPeriodId: cutoffPeriod.id, timeLog: { userId: { in: userIds } } },
      select: { timeLogId: true, timeLog: { select: { userId: true, timeIn: true } } },
    }),
    prisma.userShift.findMany({
      where: {
        userId:       { in: userIds },
        assignedDate: {
          gte: new Date(`${dateStr(cutoffPeriod.periodStart)}T00:00:00.000Z`),
          lte: new Date(`${dateStr(cutoffPeriod.periodEnd)}T00:00:00.000Z`),
        },
        status: { not: "cancelled" },
      },
      select: { userId: true, assignedDate: true },
    }),
  ]);

  const scheduled = new Map(); // userId -> Set<YYYY-MM-DD>
  for (const s of shifts) {
    if (!scheduled.has(s.userId)) scheduled.set(s.userId, new Set());
    scheduled.get(s.userId).add(dateStr(s.assignedDate));
  }

  const offDay = new Set();
  for (const a of approvals) {
    const local = moment.tz(a.timeLog.timeIn, tz);
    const days  = scheduled.get(a.timeLog.userId);
    // No schedule plotted in this cutoff (common for SVs) — fall back to
    // weekends: the flat hours assume Mon–Fri × 8h.
    const isOff = days ? !days.has(local.format("YYYY-MM-DD")) : [0, 6].includes(local.day());
    if (isOff) offDay.add(a.timeLogId);
  }
  return offDay;
}

function n(v) {
  return v == null ? 0 : parseFloat(v.toString());
}

/**
 * Active users in this cutoff's scope who are on fixed hours themselves and
 * whose department's master switch is on.
 * @returns {Promise<Map<string, number>>} userId -> department fixedHoursPerCutoff
 */
async function getFixedHoursMembers(cutoffPeriod) {
  const users = await prisma.user.findMany({
    where: {
      companyId: cutoffPeriod.companyId,
      status:    "active",
      fixedHoursEnabled: true,
      ...(cutoffPeriod.departmentId ? { departmentId: cutoffPeriod.departmentId } : {}),
      department: { fixedHoursEnabled: true },
    },
    select: { id: true, department: { select: { fixedHoursPerCutoff: true } } },
  });
  return new Map(users.map((u) => [u.id, n(u.department.fixedHoursPerCutoff)]));
}

/**
 * Brings an open cutoff in line with the current department settings:
 * creates missing fixed-hours rows, auto-excludes members' pending
 * scheduled-day punches, keeps their off-day punches pending (OFF_DAY_NOTE),
 * and reverses all of it for users who are no longer members. Safe to call on
 * every review load / lock / finalize.
 * @returns {Promise<Set<string>>} userIds currently on fixed hours for this cutoff
 */
async function applyFixedHoursForCutoff(cutoffPeriod) {
  const { id: cutoffPeriodId } = cutoffPeriod;

  if (cutoffPeriod.status !== "open") {
    const rows = await prisma.cutoffFixedHours.findMany({
      where:  { cutoffPeriodId },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  const members   = await getFixedHoursMembers(cutoffPeriod);
  const memberIds = [...members.keys()];

  if (memberIds.length > 0) {
    await prisma.cutoffFixedHours.createMany({
      data: memberIds.map((userId) => ({
        cutoffPeriodId,
        userId,
        hours:  members.get(userId),
        status: "approved",
      })),
      skipDuplicates: true,
    });

    const offDayIds = [...await getOffDayTimeLogIds(cutoffPeriod, memberIds)];

    const excluded = await prisma.timeLogApproval.updateMany({
      where: {
        cutoffPeriodId,
        status:    "pending",
        timeLogId: { notIn: offDayIds },
        timeLog:   { userId: { in: memberIds } },
      },
      data: { status: "excluded", notes: FIXED_HOURS_NOTE },
    });
    // Off-day punches go to the admin: undo an earlier auto-exclude (e.g. a
    // shift was removed, or excluded before off-day work was supported), and
    // mark the pending ones.
    const reopened = await prisma.timeLogApproval.updateMany({
      where: { cutoffPeriodId, status: "excluded", notes: FIXED_HOURS_NOTE, timeLogId: { in: offDayIds } },
      data:  { status: "pending", notes: OFF_DAY_NOTE },
    });
    await prisma.timeLogApproval.updateMany({
      where: { cutoffPeriodId, status: "pending", notes: null, timeLogId: { in: offDayIds } },
      data:  { notes: OFF_DAY_NOTE },
    });
    if (excluded.count > 0 || reopened.count > 0) {
      console.log(`[BB-089] Cutoff ${cutoffPeriodId} — auto-excluded ${excluded.count} scheduled-day punch(es), reopened ${reopened.count} off-day punch(es) for approval`);
    }
  }

  // Employee or department switched off, or user moved departments — undo only what we did.
  const removed = await prisma.cutoffFixedHours.deleteMany({
    where: { cutoffPeriodId, userId: { notIn: memberIds } },
  });
  const restored = await prisma.timeLogApproval.updateMany({
    where: {
      cutoffPeriodId,
      status:  "excluded",
      notes:   FIXED_HOURS_NOTE,
      timeLog: { userId: { notIn: memberIds } },
    },
    data: { status: "pending", notes: null },
  });
  await prisma.timeLogApproval.updateMany({
    where: { cutoffPeriodId, status: "pending", notes: OFF_DAY_NOTE, timeLog: { userId: { notIn: memberIds } } },
    data:  { notes: null },
  });
  if (removed.count > 0 || restored.count > 0) {
    console.log(`[BB-089] Reverted fixed hours in cutoff ${cutoffPeriodId} — ${removed.count} row(s) removed, ${restored.count} punch(es) back to pending`);
  }

  return new Set(memberIds);
}

/**
 * Paid, approved LeaveDay hours per user within [periodStart, periodEnd] —
 * same filter as payrollExportService's ptoHours.
 * @returns {Promise<Map<string, number>>}
 */
async function getPaidLeaveHoursByUser(userIds, periodStart, periodEnd) {
  if (userIds.length === 0) return new Map();
  const leaveDays = await prisma.leaveDay.findMany({
    where: {
      date:   { gte: periodStart, lte: periodEnd },
      isPaid: true,
      leave:  { status: "approved", userId: { in: userIds } },
    },
    select: { hours: true, leave: { select: { userId: true } } },
  });
  const byUser = new Map();
  for (const ld of leaveDays) {
    byUser.set(ld.leave.userId, (byUser.get(ld.leave.userId) ?? 0) + n(ld.hours));
  }
  return byUser;
}

/** Fixed hours include paid leave: the rest is regular. */
function splitFixedHours(hours, leaveHours) {
  return {
    hours:        parseFloat(n(hours).toFixed(2)),
    leaveHours:   parseFloat(leaveHours.toFixed(2)),
    regularHours: parseFloat(Math.max(0, n(hours) - leaveHours).toFixed(2)),
  };
}

/**
 * Fixed-hours rows for a cutoff, with the regular/leave split — the shape
 * returned to the review page and the cutoff summary.
 */
async function getFixedHoursForCutoff(cutoffPeriod) {
  const rows = await prisma.cutoffFixedHours.findMany({
    where:   { cutoffPeriodId: cutoffPeriod.id },
    include: {
      user:   { select: { id: true, email: true, username: true, departmentId: true, profile: true } },
      editor: { select: { id: true, profile: { select: { firstName: true, lastName: true } } } },
    },
  });
  const leaveByUser = await getPaidLeaveHoursByUser(
    rows.map((r) => r.userId),
    cutoffPeriod.periodStart,
    cutoffPeriod.periodEnd
  );
  return rows
    .map((r) => ({
      id:       r.id,
      userId:   r.userId,
      user:     r.user,
      status:   r.status,
      ...splitFixedHours(r.hours, leaveByUser.get(r.userId) ?? 0),
      editedBy: r.editor,
      editedAt: r.editedAt,
      notes:    r.notes,
    }))
    .sort((a, b) => (a.user.profile?.lastName || "").localeCompare(b.user.profile?.lastName || ""));
}

/**
 * Admin override of one fixed-hours row (open cutoffs only).
 * @returns {Promise<{ status: number, message: string, data?: object }>}
 */
async function updateFixedHours(cutoffPeriod, fixedHoursId, { hours, notes, userId }) {
  if (cutoffPeriod.status !== "open") {
    return { status: 400, message: `Cannot edit fixed hours on a ${cutoffPeriod.status} cutoff period.` };
  }

  const value = Number(hours);
  if (hours === undefined || hours === null || hours === "" || !Number.isFinite(value) || value < 0 || value > 999) {
    return { status: 400, message: "hours must be a number between 0 and 999." };
  }

  const row = await prisma.cutoffFixedHours.findUnique({ where: { id: fixedHoursId } });
  if (!row || row.cutoffPeriodId !== cutoffPeriod.id) {
    return { status: 404, message: "Fixed hours record not found in this cutoff period." };
  }

  const updated = await prisma.cutoffFixedHours.update({
    where: { id: fixedHoursId },
    data: {
      hours:    value.toFixed(2),
      editedBy: userId,
      editedAt: new Date(),
      ...(notes !== undefined && { notes: notes || null }),
    },
  });

  const leaveByUser = await getPaidLeaveHoursByUser([updated.userId], cutoffPeriod.periodStart, cutoffPeriod.periodEnd);
  return {
    status:  200,
    message: "Fixed hours updated.",
    data: {
      ...updated,
      ...splitFixedHours(updated.hours, leaveByUser.get(updated.userId) ?? 0),
    },
  };
}

module.exports = {
  FIXED_HOURS_NOTE,
  OFF_DAY_NOTE,
  getOffDayTimeLogIds,
  applyFixedHoursForCutoff,
  getFixedHoursForCutoff,
  updateFixedHours,
  splitFixedHours,
};
