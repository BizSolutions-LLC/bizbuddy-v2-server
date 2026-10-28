// src/workers/clockOutReminderWorker.js
const cron = require("node-cron");
const { prisma } = require("@config/connection");
const { getIO } = require("@config/socket");
const { getMessaging } = require("@config/firebase");
const moment = require("moment-timezone");
const {
  dateKeyFromDbDate,
  dateKeyInTz,
  combineAssignedDateWithTimeTz,
} = require("@services/timeLogComputeUtils");

function normalizeTimezone(preferredTz, fallbackTz) {
  const tz = preferredTz || fallbackTz || "America/Los_Angeles";
  if (moment.tz.zone(tz)) return tz;
  if (fallbackTz && moment.tz.zone(fallbackTz)) return fallbackTz;
  return "America/Los_Angeles";
}

async function processClockOutReminders() {
  const now = new Date();

  // Fetch all active time logs (users currently clocked in)
  const activeLogs = await prisma.timeLog.findMany({
    // BB-107: no reminders for inactive accounts
    where: { status: true, user: { status: "active" } },
    include: { user: { select: { deviceToken: true } } },
  });
  if (!activeLogs.length) return;

  const io = getIO();
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

  for (const log of activeLogs) {
    try {
      // Find the shift assignment for this timelog without relying on server-local midnight.
      const windowStart = new Date(log.timeIn.getTime() - 36 * 60 * 60 * 1000);
      const windowEnd = new Date(log.timeIn.getTime() + 36 * 60 * 60 * 1000);
      const candidates = await prisma.userShift.findMany({
        where: {
          userId: log.userId,
          assignedDate: { gte: windowStart, lte: windowEnd },
        },
        include: { shift: true },
      });

      let userShift = null;
      if (candidates.length) {
        // Prefer same "date" as timeIn in the effective timezone.
        for (const us of candidates) {
          const companyTz = await getCompanyTimezone(us.shift?.companyId);
          const tz = normalizeTimezone(us.shift?.timeZone, companyTz);
          if (
            dateKeyFromDbDate(us.assignedDate) === dateKeyInTz(log.timeIn, tz)
          ) {
            userShift = us;
            break;
          }
        }
        // Fallback: closest assignedDate.
        if (!userShift) {
          candidates.sort(
            (a, b) =>
              Math.abs(
                new Date(a.assignedDate).getTime() - log.timeIn.getTime(),
              ) -
              Math.abs(
                new Date(b.assignedDate).getTime() - log.timeIn.getTime(),
              ),
          );
          userShift = candidates[0];
        }
      }

      if (!userShift?.shift) continue;

      const companyTz = await getCompanyTimezone(userShift.shift.companyId);
      const tz = normalizeTimezone(userShift.shift.timeZone, companyTz);
      const shiftStart = combineAssignedDateWithTimeTz(
        userShift.assignedDate,
        userShift.shift.startTime,
        tz,
      );
      let shiftEnd = combineAssignedDateWithTimeTz(
        userShift.assignedDate,
        userShift.shift.endTime,
        tz,
      );

      // Handle shifts that cross midnight (end on the next calendar day)
      if (userShift.shift.crossesMidnight && shiftEnd <= shiftStart) {
        shiftEnd = new Date(shiftEnd.getTime() + 24 * 60 * 60 * 1000);
      }

      const minutesToEnd = (shiftEnd.getTime() - now.getTime()) / 60000;
      if (minutesToEnd <= 0) continue; // already past end

      // Trigger reminder if we are roughly 10 minutes before end.
      // Use a small window so a once-per-minute cron won't miss it.
      if (minutesToEnd <= 10 && minutesToEnd > 9) {
        const marker = `clockoutReminder:${log.id}`;
        const existing = await prisma.userActivity.findFirst({
          where: { userId: log.userId, activityDescription: marker },
        });
        if (existing) continue; // already reminded for this active timelog

        io.to(log.userId).emit("clockOutReminder", {
          timeLogId: log.id,
          userId: log.userId,
          shiftEnd: shiftEnd.toISOString(),
          minutesRemaining: Math.round(minutesToEnd),
          message:
            "Your shift ends in 10 minutes. Please remember to clock out.",
        });

        // Send Firebase Cloud Messaging push if available
        const messaging = getMessaging();
        const token = log.user?.deviceToken;
        if (messaging && token) {
          try {
            await messaging.send({
              token,
              notification: {
                title: "Shift ending soon",
                body: "Your shift ends in 10 minutes. Please remember to clock out.",
              },
              data: {
                timeLogId: String(log.id),
                userId: String(log.userId),
                shiftEnd: shiftEnd.toISOString(),
                minutesRemaining: String(Math.round(minutesToEnd)),
                type: "clockOutReminder",
                targetScreen: "timekeeping-punch",
                targetRoute: "/(tabs)/(shifts)/timekeeping-punch",
              },
            });
          } catch (pushErr) {
            console.error("[ClockOutReminder] FCM send error", log.id, pushErr);
          }
        }

        await prisma.userActivity.create({
          data: {
            userId: log.userId,
            activityDescription: marker,
          },
        });
      }
    } catch (err) {
      console.error("[ClockOutReminder] Error processing log", log.id, err);
    }
  }
}

function scheduleClockOutReminders() {
  // Run every minute
  cron.schedule("* * * * *", async () => {
    try {
      await processClockOutReminders();
    } catch (err) {
      console.error("[ClockOutReminder] Worker error:", err);
    }
  });
}

module.exports = { scheduleClockOutReminders };
