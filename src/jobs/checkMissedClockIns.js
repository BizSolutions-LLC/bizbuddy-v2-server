const { prisma } = require('@config/connection');
const { notifyMissedClockIn } = require('@services/notificationService');
const moment = require('moment-timezone');

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
 * Check for employees who missed their clock-in
 * Runs every 5 minutes
 */
async function checkMissedClockIns() {
  console.log('🔍 Checking for missed clock-ins...');

  try {
    // Get all companies with notification enabled
    const companies = await prisma.company.findMany({
      where: { notifyEmployeeMissedIn: true, isActive: true }, // BB-117: inactive companies get nothing
      select: {
        id: true,
        name: true,
        timeZone: true,
        clockInGracePeriod: true,
      },
    });

    for (const company of companies) {
      const timezone = company.timeZone || 'America/Los_Angeles';
      const now = moment().tz(timezone);
      const gracePeriod = company.clockInGracePeriod || 30; // minutes

      // Calculate the time window to check
      const checkStartTime = now.clone().subtract(gracePeriod + 5, 'minutes'); // Add 5 min buffer
      const checkEndTime = now.clone().subtract(gracePeriod, 'minutes');

      // Find all shifts that should have started in this window
      const shiftsToCheck = await prisma.userShift.findMany({
        where: {
          assignedDate: {
            gte: now.clone().startOf('day').toDate(),
            lte: now.clone().endOf('day').toDate(),
          },
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
          shift: true,
        },
      });

      for (const userShift of shiftsToCheck) {
        // Build shift start datetime
        const shiftStartTime = combineDateWithTime(
          userShift.assignedDate,
          userShift.customStartTime || userShift.shift.startTime,
          timezone 
        );

        // Check if shift start time falls within our check window
        if (shiftStartTime.isBetween(checkStartTime, checkEndTime, null, '[]')) {
          // Check if employee has clocked in
          const clockIn = await prisma.timeLog.findFirst({
            where: {
              userId: userShift.userId,
              timeIn: {
                gte: shiftStartTime.clone().subtract(30, 'minutes').toDate(),
                lte: now.toDate(),
              },
            },
            orderBy: { timeIn: 'desc' },
          });

          if (!clockIn) {
            // Skip if employee is on an approved leave covering today
            const onLeave = await prisma.leave.findFirst({
              where: {
                userId:    userShift.userId,
                status:    "approved",
                startDate: { lte: now.toDate() },
                endDate:   { gte: now.toDate() },
              },
            });
            if (onLeave) continue;

            // Employee missed clock-in!
            console.log(`⚠️  Missed clock-in: ${userShift.user.username} (${userShift.shift.shiftName})`);

            // BB-117: sent once per scheduled shift — the dedupe key on the inbox
            // row replaces the old "anything in the last 2 hours" lookup.
            await notifyMissedClockIn(
              {
                user: userShift.user,
                shiftDetails: {
                  userShiftId: userShift.id,
                  shiftId: userShift.shift.id,
                  shiftName: userShift.shift.shiftName,
                  scheduledStart: userShift.assignedDate,
                  startTime: shiftStartTime.format('h:mm A'),
                },
              },
              userShift.shift,
              company
            );
          }
        }
      }
    }

    console.log('✅ Missed clock-in check complete');
  } catch (error) {
    console.error('❌ Error checking missed clock-ins:', error);
  }
}

module.exports = checkMissedClockIns;