// src/workers/clockInReminderWorker.js
const cron = require("node-cron");
const { prisma } = require("@config/connection");
const { getIO } = require("@config/socket");
const { createNotification } = require("@services/notificationService");
const moment = require("moment-timezone");
const { evaluateClockInReminder } = require("@services/timeLogComputeUtils");

function normalizeTimezone(preferredTz, fallbackTz) {
  const tz = preferredTz || fallbackTz || "America/Los_Angeles";
  if (moment.tz.zone(tz)) return tz;
  if (fallbackTz && moment.tz.zone(fallbackTz)) return fallbackTz;
  return "America/Los_Angeles";
}

async function processClockInReminders() {
  const now = new Date();

  // Query a broad window to avoid relying on server-local midnight (companies can have different timezones).
  const windowStart = new Date(now.getTime() - 36 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 36 * 60 * 60 * 1000);

  // Fetch candidate user shifts with users (for deviceToken)
  const todaysUserShifts = await prisma.userShift.findMany({
    // BB-107: no reminders for inactive accounts; BB-117: nor inactive companies
    where: {
      assignedDate: { gte: windowStart, lte: windowEnd },
      user: { status: "active", company: { isActive: true } },
    },
    include: {
      shift: { select: { startTime: true, timeZone: true, companyId: true } },
      user: { select: { id: true, companyId: true, departmentId: true } },
    },
  });
  if (!todaysUserShifts.length) return;

  const io = getIO();

  // Preload active logs for users to avoid per-row queries
  const userIds = [...new Set(todaysUserShifts.map((u) => u.userId))];
  const activeLogs = await prisma.timeLog.findMany({
    where: { userId: { in: userIds }, status: true },
    select: { userId: true },
  });
  const activeSet = new Set(activeLogs.map((l) => l.userId));

  // Cache company timezones to avoid repeated DB lookups
  const companyTzCache = new Map();
  async function getCompanyTimezone(companyId) {
    if (!companyId) return "America/Los_Angeles";
    if (companyTzCache.has(companyId)) return companyTzCache.get(companyId);
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { timeZone: true },
    });
    const tz = company?.timeZone || "America/Los_Angeles";
    companyTzCache.set(companyId, tz);
    return tz;
  }

  for (const us of todaysUserShifts) {
    try {
      // Skip if already clocked in
      if (activeSet.has(us.userId)) continue;

      const companyTz = await getCompanyTimezone(us.shift?.companyId);
      const tz = normalizeTimezone(us.shift?.timeZone, companyTz);

      const evaluation = evaluateClockInReminder({
        assignedDate: us.assignedDate,
        startTime: us.shift.startTime,
        tz,
        now,
      });
      if (!evaluation.shouldRemind) continue;

      const { shiftStart, minutesRemaining } = evaluation;

      // Sent before BB-117 (the old UserActivity marker): don't send it again.
      // Read-only, for the shifts that were already reminded around the deploy.
      const legacyMarker = await prisma.userActivity.findFirst({
        where: { userId: us.userId, activityDescription: `clockinReminder:${us.id}` },
        select: { id: true },
      });
      if (legacyMarker) continue;

      // BB-117: the reminder is now an inbox entry (CLOCK_IN_REMINDER) and goes
      // through the shared sender: same push format and tap route as every other
      // notification, once per scheduled shift (dedupeKey replaces the marker).
      const message = "Your shift starts in 30 minutes. Please remember to clock in.";
      const created = await createNotification({
        userId: us.userId,
        companyId: us.user.companyId || us.shift?.companyId,
        departmentId: us.user.departmentId || null,
        notificationCode: "CLOCK_IN_REMINDER",
        title: "Shift starting soon",
        message,
        payload: { userShiftId: us.id, shiftStart: shiftStart.toISOString(), minutesRemaining },
        dedupeKey: `CLOCK_IN_REMINDER:${us.userId}:${us.id}`,
      });
      if (!created) continue;

      // Kept for the app's existing live listener.
      io.to(us.userId).emit("clockInReminder", {
        userId: us.userId,
        userShiftId: us.id,
        shiftStart: shiftStart.toISOString(),
        minutesRemaining,
        message,
      });
    } catch (err) {
      console.error("[ClockInReminder] Error for userShift", us.id, err);
    }
  }
}

function scheduleClockInReminders() {
  // Run every minute
  cron.schedule("* * * * *", async () => {
    try {
      await processClockInReminders();
    } catch (err) {
      console.error("[ClockInReminder] Worker error:", err);
    }
  });
}

module.exports = { scheduleClockInReminders };
