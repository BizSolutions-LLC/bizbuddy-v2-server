// src/services/shiftNotificationService.js

const { prisma } = require("@config/connection");
const { notifyUser } = require("./socketService");
const { prefixWithCompanyName } = require("./notificationService");

/**
 * Helper: Persist notification to DB and emit via Socket.io
 */
async function createNotification({
  userId,
  companyId,
  departmentId,
  notificationCode,
  title,
  message,
  payload = {},
}) {
  try {
    const [prefixedTitle, prefixedMessage] = await Promise.all([
      prefixWithCompanyName(companyId, title),
      prefixWithCompanyName(companyId, message),
    ]);

    const notification = await prisma.notificationLog.create({
      data: {
        userId,
        companyId,
        departmentId,
        notificationCode,
        title: prefixedTitle,
        message: prefixedMessage,
        payload,
      },
    });

    notifyUser(userId, {
      id: notification.id,
      type: notificationCode,
      title: prefixedTitle,
      message: prefixedMessage,
      payload,
      createdAt: notification.createdAt,
      seen: false,
    });

    return notification;
  } catch (error) {
    console.error("❌ Error creating shift notification:", error);
    throw error;
  }
}

/**
 * Notify employee about a direct shift assignment
 * Code: SCHEDULE_ASSIGNED
 */
async function notifyEmployeeShiftAssigned({
  user,
  shift,
  dates,
  assignedBy,
  companyId,
}) {
  const dateList =
    dates.length <= 3
      ? dates.map((d) => new Date(d).toLocaleDateString()).join(", ")
      : `${dates.length} dates`;

  await createNotification({
    userId: user.id,
    companyId,
    departmentId: user.departmentId || null,
    notificationCode: "SCHEDULE_ASSIGNED",
    title: "📅 New Shift Assignment",
    message: `You've been assigned to "${shift.shiftName}" for ${dateList}`,
    payload: {
      shiftId: shift.id,
      shiftName: shift.shiftName,
      startTime: shift.startTime,
      endTime: shift.endTime,
      dates,
      assignedBy,
    },
  });
}

/**
 * Notify employee about a recurring schedule assignment
 * Code: SCHEDULE_UPDATED
 */
async function notifyEmployeeScheduleCreated({
  user,
  shift,
  schedule,
  assignedBy,
  companyId,
  totalDates,
}) {
  const daysOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const selectedDays = schedule.daysOfWeek
    .map((day) => daysOfWeek[day])
    .join(", ");

  await createNotification({
    userId: user.id,
    companyId,
    departmentId: user.departmentId || null,
    notificationCode: "SCHEDULE_UPDATED",
    title: "📅 Recurring Shift Schedule",
    message: `You've been scheduled for "${shift.shiftName}" on ${selectedDays} (${totalDates} days total)`,
    payload: {
      shiftId: shift.id,
      shiftName: shift.shiftName,
      scheduleId: schedule.id,
      daysOfWeek: selectedDays,
      startDate: schedule.startDate,
      endDate: schedule.endDate,
      totalDates,
      assignedBy,
    },
  });
}

/**
 * Notify management about a bulk shift assignment
 * Code: SCHEDULE_ASSIGNED_MANAGEMENT
 */
async function notifyManagementShiftAssignment({
  companyId,
  shift,
  assignedCount,
  dates,
  assignmentType,
  assignedBy,
}) {
  const managementUsers = await prisma.user.findMany({
    where: {
      companyId,
      role: { in: ["admin", "superadmin", "supervisor"] },
      status: "active",
    },
    select: { id: true, departmentId: true },
  });

  const dateList =
    dates.length <= 3
      ? dates.map((d) => new Date(d).toLocaleDateString()).join(", ")
      : `${dates.length} dates`;

  const assignmentTypeLabel =
    {
      all: "all employees",
      department: "department",
      individual: `${assignedCount} employee(s)`,
    }[assignmentType] || "employees";

  await Promise.all(
    managementUsers.map((manager) =>
      createNotification({
        userId: manager.id,
        companyId,
        departmentId: manager.departmentId,
        notificationCode: "SCHEDULE_ASSIGNED_MANAGEMENT",
        title: "✅ Shift Assignment Completed",
        message: `"${shift.shiftName}" assigned to ${assignmentTypeLabel} for ${dateList} (${assignedCount} assignments created)`,
        payload: {
          shiftId: shift.id,
          shiftName: shift.shiftName,
          assignedCount,
          dates,
          assignmentType,
          assignedBy,
        },
      }),
    ),
  );
}

/**
 * Notify management when a recurring schedule is created
 * Code: SCHEDULE_UPDATED
 */
async function notifyManagementScheduleCreated({
  companyId,
  shift,
  schedule,
  targetCount,
  totalShifts,
  assignedBy,
}) {
  const managementUsers = await prisma.user.findMany({
    where: {
      companyId,
      role: { in: ["admin", "superadmin", "supervisor"] },
      status: "active",
    },
    select: { id: true, departmentId: true },
  });

  const daysOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const selectedDays = schedule.daysOfWeek
    .map((day) => daysOfWeek[day])
    .join(", ");

  await Promise.all(
    managementUsers.map((manager) =>
      createNotification({
        userId: manager.id,
        companyId,
        departmentId: manager.departmentId,
        notificationCode: "SCHEDULE_UPDATED",
        title: "✅ Schedule Created",
        message: `Recurring schedule for "${shift.shiftName}" (${selectedDays}) assigned to ${targetCount} employee(s) — ${totalShifts} shifts created`,
        payload: {
          shiftId: shift.id,
          shiftName: shift.shiftName,
          scheduleId: schedule.id,
          daysOfWeek: selectedDays,
          totalShifts,
          targetCount,
          assignedBy,
        },
      }),
    ),
  );
}

/**
 * Notify employee when their shift is replaced due to a conflict
 * Code: SCHEDULE_REPLACED
 */
async function notifyEmployeeShiftReplaced({
  user,
  oldShift,
  newShift,
  date,
  companyId,
}) {
  await createNotification({
    userId: user.id,
    companyId,
    departmentId: user.departmentId || null,
    notificationCode: "SCHEDULE_REPLACED",
    title: "⚠️ Shift Changed",
    message: `Your "${oldShift.shiftName}" on ${new Date(date).toLocaleDateString()} was replaced with "${newShift.shiftName}"`,
    payload: {
      oldShiftId: oldShift.id,
      oldShiftName: oldShift.shiftName,
      newShiftId: newShift.id,
      newShiftName: newShift.shiftName,
      date,
    },
  });
}

module.exports = {
  notifyEmployeeShiftAssigned,
  notifyEmployeeScheduleCreated,
  notifyManagementShiftAssignment,
  notifyManagementScheduleCreated,
  notifyEmployeeShiftReplaced,
};
