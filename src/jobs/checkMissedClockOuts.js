const { prisma } = require('@config/connection');
const { notifyMissedClockOut } = require('@services/notificationService');
const moment = require('moment-timezone');

/**
 * Helper to combine date with time string in specific timezone
 */
function combineDateWithTime(date, timeValue, timezone) {
  // Convert time to string if it's a Time object
  let timeString;
  
  if (typeof timeValue === 'string') {
    timeString = timeValue;
  } else if (timeValue instanceof Date) {
    // If it's a Date object, extract time
    timeString = timeValue.toTimeString().split(' ')[0];
  } else if (timeValue && typeof timeValue === 'object') {
    // If it's a Time object with hours/minutes properties
    const hours = String(timeValue.hours || timeValue.hour || 0).padStart(2, '0');
    const minutes = String(timeValue.minutes || timeValue.minute || 0).padStart(2, '0');
    timeString = `${hours}:${minutes}:00`;
  } else {
    console.error('Invalid timeValue:', timeValue);
    timeString = '00:00:00';
  }

  const [hours, minutes, seconds = '00'] = timeString.split(':');
  const dateStr = moment(date).format('YYYY-MM-DD');
  
  return moment.tz(
    `${dateStr} ${hours}:${minutes}:${seconds}`,
    'YYYY-MM-DD HH:mm:ss',
    timezone
  );
}

/**
 * Check for employees who missed their clock-out
 * Runs every 5 minutes
 */
async function checkMissedClockOuts() {
  console.log('🔍 Checking for missed clock-outs...');

  try {
    // Get all companies with notification enabled
    const companies = await prisma.company.findMany({
      where: { notifyEmployeeMissedOut: true, isActive: true }, // BB-117: inactive companies get nothing
      select: {
        id: true,
        name: true,
        timeZone: true,
        clockOutGracePeriod: true,
      },
    });

    for (const company of companies) {
      const timezone = company.timeZone || 'America/Los_Angeles';
      const now = moment().tz(timezone);
      const gracePeriod = company.clockOutGracePeriod || 30;

      // Find active time logs (clocked in but not clocked out)
      const activeTimeLogs = await prisma.timeLog.findMany({
        where: {
          timeOut: null,
          user: {
            companyId: company.id,
            status: 'active',
          },
        },
        include: {
          user: {
            include: {
              profile: true,
              department: true,
            },
          },
        },
      });

      for (const timeLog of activeTimeLogs) {
        const clockInTime = moment(timeLog.timeIn).tz(timezone);
        const timeSinceClockIn = now.diff(clockInTime, 'minutes');

        // Find the shift for this time log.
        // assignedDate is stored as UTC midnight of the calendar date (2026-06-03T00:00:00Z).
        // startOf('day').toDate() in a negative-offset timezone (e.g. PDT = UTC-7) produces
        // 2026-06-03T07:00:00Z — which no longer matches the stored date and instead matches
        // the next day's assignment. Use the local date string to build a UTC-midnight range
        // that lines up with how assignedDate is stored, regardless of timezone offset.
        const localDateStr = clockInTime.format('YYYY-MM-DD');
        const dayStart = new Date(`${localDateStr}T00:00:00.000Z`);
        const dayEnd   = new Date(`${localDateStr}T23:59:59.999Z`);

        const userShift = await prisma.userShift.findFirst({
          where: {
            userId: timeLog.userId,
            status: { not: 'cancelled' },
            assignedDate: { gte: dayStart, lte: dayEnd },
          },
          include: { shift: true },
        });

        if (userShift) {
          // Calculate expected clock-out time WITH timezone
          let shiftEndTime = combineDateWithTime(
            userShift.assignedDate,
            userShift.customEndTime || userShift.shift.endTime,
            timezone  // ← Pass timezone to helper
          );

          // Handle shifts that cross midnight
          if (userShift.shift.crossesMidnight && shiftEndTime.isBefore(clockInTime)) {
            shiftEndTime = shiftEndTime.add(1, 'day');
          }

          const minutesPastShiftEnd = now.diff(shiftEndTime, 'minutes');

          // If past grace period, notify
          if (minutesPastShiftEnd >= gracePeriod) {
            console.log(`⚠️  Missed clock-out: ${timeLog.user.username}`);

            // BB-117: sent once per punch (dedupe key on the inbox row).
            await notifyMissedClockOut(
              { user: timeLog.user },
              {
                id: timeLog.id,
                timeIn: timeLog.timeIn,
                expectedClockOut: shiftEndTime.toDate(),
                hoursWorked: (timeSinceClockIn / 60).toFixed(2),
              },
              company
            );
          }
        } else {
          // No shift found, but they've been clocked in for more than 12 hours
          if (timeSinceClockIn >= 720) {
            console.log(`⚠️  Long clock-in without shift: ${timeLog.user.username}`);

            // BB-117: sent once per punch (dedupe key on the inbox row).
            await notifyMissedClockOut(
              { user: timeLog.user },
              {
                id: timeLog.id,
                timeIn: timeLog.timeIn,
                expectedClockOut: now.toDate(),
                hoursWorked: (timeSinceClockIn / 60).toFixed(2),
              },
              company
            );
          }
        }
      }
    }

    console.log('✅ Missed clock-out check complete');
  } catch (error) {
    console.error('❌ Error checking missed clock-outs:', error);
  }
}

module.exports = checkMissedClockOuts;