// jobs/generateUpcomingUserShifts.js

const cron = require("node-cron");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

function normalizeDate(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function generateUpcomingUserShifts() {
  try {
    const now = new Date();
    const normalizedNow = normalizeDate(now);
    const windowLengthDays = 30;
    const windowStart = normalizedNow;
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + windowLengthDays);

    const schedules = await prisma.shiftSchedule.findMany({
      where: {
        startDate: { lte: windowEnd },
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      include: { shift: true },
    });

    for (const schedule of schedules) {
      const scheduleStart = normalizeDate(schedule.startDate);
      let scheduleEnd = schedule.endDate ? normalizeDate(schedule.endDate) : null;
      if (scheduleEnd && scheduleEnd <= scheduleStart) {
        scheduleEnd = null;
      }
      if (scheduleEnd && scheduleEnd < normalizedNow) {
        console.warn(`Skipping schedule ${schedule.id} because its endDate is in the past.`);
        continue;
      }
      const windowEffectiveStart = scheduleStart > normalizedNow ? scheduleStart : normalizedNow;
      let effectiveWindowEnd = windowEnd;
      if (scheduleEnd) {
        effectiveWindowEnd = scheduleEnd < windowEnd ? scheduleEnd : windowEnd;
      }

      if (windowEffectiveStart > effectiveWindowEnd) {
        console.warn(`Skipping schedule ${schedule.id} because effective window is invalid.`);
        continue;
      }
      const byDayPart = schedule.recurrencePattern.split(";").find((part) => part.startsWith("BYDAY="));
      let daysArray = [];
      if (byDayPart) {
        daysArray = byDayPart.replace("BYDAY=", "").split(",");
      }
      const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
      const validDays = daysArray.map((day) => dayMap[day]).filter((d) => d !== undefined);
      const occurrenceDates = [];
      let currentDate = new Date(windowEffectiveStart);
      while (currentDate <= effectiveWindowEnd) {
        if (validDays.includes(currentDate.getDay())) {
          occurrenceDates.push(new Date(currentDate));
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }

      let users = [];
      if (schedule.assignedToAll) {
        users = await prisma.user.findMany({
          // BB-107: inactive accounts get no new shifts (and so no reminders)
          where: { ...HUMAN_ONLY, companyId: schedule.companyId, status: "active" },
        });
      } else if (schedule.assignedUserId) {
        const user = await prisma.user.findUnique({ where: { id: schedule.assignedUserId } });
        if (user && user.status === "active") users.push(user);
      }

      const userShiftData = [];
      for (const date of occurrenceDates) {
        for (const user of users) {
          const exists = await prisma.userShift.findFirst({
            where: {
              userId: user.id,
              shiftId: schedule.shiftId,
              assignedDate: date,
            },
          });
          if (!exists) {
            userShiftData.push({
              userId: user.id,
              shiftId: schedule.shiftId,
              assignedDate: date,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        }
      }

      if (userShiftData.length > 0) {
        await prisma.userShift.createMany({ data: userShiftData });
      }
    }
    console.log("Background job: Upcoming user shifts generated.");
  } catch (error) {
    console.error("Background job error:", error);
  }
}

cron.schedule("0 0 * * *", () => {
  generateUpcomingUserShifts();
});

module.exports = { generateUpcomingUserShifts };
