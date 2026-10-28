// src/workers/clockInReminderWorker.js
const cron = require("node-cron");
const { prisma } = require("@config/connection");
const { getIO } = require("@config/socket");
const { getMessaging } = require("@config/firebase");
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
    // BB-107: no reminders for inactive accounts
    where: { assignedDate: { gte: windowStart, lte: windowEnd }, user: { status: "active" } },
    include: {
      shift: { select: { startTime: true, timeZone: true, companyId: true } },
      user: { select: { id: true, deviceToken: true } },
    },
  });
  if (!todaysUserShifts.length) return;

  const io = getIO();
  const messaging = getMessaging();

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
      const marker = `clockinReminder:${us.id}`; // dedupe by userShift id
      const existing = await prisma.userActivity.findFirst({
        where: { userId: us.userId, activityDescription: marker },
      });
      if (existing) continue;

      io.to(us.userId).emit("clockInReminder", {
        userId: us.userId,
        userShiftId: us.id,
        shiftStart: shiftStart.toISOString(),
        minutesRemaining,
        message:
          "Your shift starts in 30 minutes. Please remember to clock in.",
      });

      // Send FCM push if possible
      const token = us.user?.deviceToken;
      if (messaging && token) {
        try {
          await messaging.send({
            token,
            notification: {
              title: "Shift starting soon",
              body: "Your shift starts in 30 minutes. Please remember to clock in.",
            },
            data: {
              userShiftId: String(us.id),
              userId: String(us.userId),
              shiftStart: shiftStart.toISOString(),
              minutesRemaining: String(minutesRemaining),
              type: "clockInReminder",
              targetScreen: "timekeeping-punch",
              targetRoute: "/(tabs)/(shifts)/timekeeping-punch",
            },
          });
        } catch (pushErr) {
          console.error("[ClockInReminder] FCM send error", us.id, pushErr);
        }
      }

      await prisma.userActivity.create({
        data: { userId: us.userId, activityDescription: marker },
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
