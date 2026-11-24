const { prisma } = require('@config/connection');
const { notifyMissedClockIn } = require('@services/notificationService');
const moment = require('moment-timezone');
const {
  dateKeyInTz,
  combineAssignedDateWithTimeTz,
} = require('@services/timeLogComputeUtils');

const DEFAULT_TZ = 'America/Los_Angeles';

// BB-148: a shift is read in its own zone (Shift.timeZone), like the "Shift
// starting soon" reminder (clockInReminderWorker), then the company zone.
function shiftZone(shiftTz, companyTz) {
  if (shiftTz && moment.tz.zone(shiftTz)) return shiftTz;
  if (companyTz && moment.tz.zone(companyTz)) return companyTz;
  return DEFAULT_TZ;
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
      const companyTz = shiftZone(null, company.timeZone);
      const now = moment();
      const gracePeriod = company.clockInGracePeriod || 30; // minutes

      // The shift must have started in this window (5-minute job, 5-minute window).
      const checkStartTime = now.clone().subtract(gracePeriod + 5, 'minutes'); // Add 5 min buffer
      const checkEndTime = now.clone().subtract(gracePeriod, 'minutes');

      // BB-148: assignedDate is a calendar date (stored as UTC midnight). A shift
      // in another zone than the company's can sit on the company's yesterday or
      // tomorrow, so load those three dates and keep only the shifts whose start,
      // read in the shift's own zone, falls in the window below. (Was: today in the
      // company zone with the start read in the company zone, so a Manila 8:00 AM
      // shift in an LA company alerted at 8:30 AM LA = 00:30 the next day in Manila.)
      const todayKey = dateKeyInTz(now.toDate(), companyTz);
      const fromKey = moment.utc(todayKey).subtract(1, 'day').format('YYYY-MM-DD');
      const toKey = moment.utc(todayKey).add(1, 'day').format('YYYY-MM-DD');

      const shiftsToCheck = await prisma.userShift.findMany({
        where: {
          assignedDate: {
            gte: new Date(`${fromKey}T00:00:00.000Z`),
            lte: new Date(`${toKey}T23:59:59.999Z`),
          },
          status: { not: 'cancelled' }, // BB-148: a cancelled shift isn't "missed"
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
        const startValue = userShift.customStartTime || userShift.shift?.startTime;
        if (!startValue) continue;

        const tz = shiftZone(userShift.shift.timeZone, companyTz);

        // Build shift start datetime in the shift's zone
        const shiftStartTime = moment(
          combineAssignedDateWithTimeTz(userShift.assignedDate, startValue, tz)
        ).tz(tz);

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

            // BB-144: shift end, date and minutes late for the email (BB-148: shift zone).
            const endValue = userShift.customEndTime || userShift.shift.endTime;
            const shiftEndTime = endValue
              ? moment(combineAssignedDateWithTimeTz(userShift.assignedDate, endValue, tz)).tz(tz)
              : null;
            if (shiftEndTime && userShift.shift.crossesMidnight && shiftEndTime.isBefore(shiftStartTime)) {
              shiftEndTime.add(1, 'day');
            }

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
                  endTime: shiftEndTime?.isValid() ? shiftEndTime.format('h:mm A') : null,
                  shiftDate: shiftStartTime.format('ddd, MMM D'),
                  minutesLate: now.diff(shiftStartTime, 'minutes'),
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
