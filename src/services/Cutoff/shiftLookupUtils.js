// src/services/Cutoff/shiftLookupUtils.js
//
// Shared day-shift auto-lookup, used by every cutoff approval strategy that
// needs to know an employee's assigned shift for a given date (e.g. to
// compare an actual punch against the grace period). Extracted out of
// daycareCutoffStrategy.js (which is frozen to DayCare-only changes) so
// other strategies (B&C, future company types) can reuse it without
// duplicating the UserShift/ShiftSchedule resolution logic.

const { prisma } = require("@config/connection");
const moment      = require("moment-timezone");

function combineDateTime(date, time, shiftTimezone = "America/Los_Angeles") {
  const dateStr = (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? date
    : moment.tz(date, shiftTimezone).format("YYYY-MM-DD");

  let timeStr;
  if (typeof time === "string") {
    timeStr = time;
  } else if (time instanceof Date) {
    const h = String(time.getUTCHours()).padStart(2, "0");
    const m = String(time.getUTCMinutes()).padStart(2, "0");
    const s = String(time.getUTCSeconds()).padStart(2, "0");
    timeStr = `${h}:${m}:${s}`;
  } else {
    timeStr = "00:00:00";
  }
  return moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm:ss", shiftTimezone).toDate();
}

async function fetchScheduleForDate(userId, dateOnly, userDepartmentId, companyId, localDateStr) {
  const SHIFT_SELECT = {
    id: true, shiftName: true, startTime: true,
    endTime: true, crossesMidnight: true, timeZone: true,
  };

  // UserShift — highest priority (explicit daily assignment)
  const userShift = await prisma.userShift.findFirst({
    where: {
      userId,
      assignedDate: {
        gte: dateOnly,
        lt:  new Date(dateOnly.getTime() + 24 * 60 * 60 * 1000),
      },
      status: { not: "cancelled" },
    },
    include: { shift: { select: SHIFT_SELECT } },
  });
  if (userShift) return userShift;

  // ShiftSchedule fallback — individual > department > all
  const orConditions = [
    { assignmentType: "individual", targetId: userId },
    { assignmentType: "all" },
  ];
  if (userDepartmentId) {
    orConditions.push({ assignmentType: "department", targetId: userDepartmentId });
  }

  const schedules = await prisma.shiftSchedule.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      OR:        orConditions,
      startDate: { lte: dateOnly },
      endDate:   { gte: dateOnly },
      isActive:  true,
    },
    include: { shift: { select: SHIFT_SELECT } },
  });

  if (!schedules.length) return null;

  const PRIORITY = { individual: 0, department: 1, all: 2 };
  schedules.sort((a, b) => (PRIORITY[a.assignmentType] ?? 99) - (PRIORITY[b.assignmentType] ?? 99));

  const dayOfWeek = localDateStr ? moment(localDateStr).day() : dateOnly.getDay();

  for (const schedule of schedules) {
    const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
    if (days.includes(dayOfWeek)) {
      return { id: schedule.id, shift: schedule.shift, customStartTime: null, customEndTime: null };
    }
  }

  // Adjacent-day fallback — handles timezone offset edge cases
  for (const offset of [1, -1]) {
    const adjDay = localDateStr
      ? moment(localDateStr).add(offset, "day").day()
      : (dayOfWeek + offset + 7) % 7;
    for (const schedule of schedules) {
      const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
      if (days.includes(adjDay)) {
        return {
          id: schedule.id, shift: schedule.shift, customStartTime: null, customEndTime: null,
          _adjDate: moment(localDateStr || dateOnly).add(offset, "day").format("YYYY-MM-DD"),
        };
      }
    }
  }

  return null;
}

module.exports = { combineDateTime, fetchScheduleForDate };
