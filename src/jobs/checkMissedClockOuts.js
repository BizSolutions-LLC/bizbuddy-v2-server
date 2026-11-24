const { prisma } = require('@config/connection');
const { notifyMissedClockOut } = require('@services/notificationService');
const moment = require('moment-timezone');
const {
  dateKeyFromDbDate,
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
 * BB-148: the shift a punch belongs to. A punch belongs to the shift assigned
 * on its clock-in date in that shift's own zone (a Manila 8:00 AM punch is the
 * previous day in LA). Several shifts that day: the one starting closest to the
 * clock-in. Returns { userShift, tz } or null.
 */
async function shiftOfPunch(timeLog, companyTz) {
  const companyKey = moment(timeLog.timeIn).tz(companyTz).format('YYYY-MM-DD');
  const fromKey = moment.utc(companyKey).subtract(1, 'day').format('YYYY-MM-DD');
  const toKey = moment.utc(companyKey).add(1, 'day').format('YYYY-MM-DD');

  const candidates = await prisma.userShift.findMany({
    where: {
      userId: timeLog.userId,
      status: { not: 'cancelled' },
      assignedDate: {
        gte: new Date(`${fromKey}T00:00:00.000Z`),
        lte: new Date(`${toKey}T23:59:59.999Z`),
      },
    },
    include: { shift: true },
  });

  let best = null;
  for (const userShift of candidates) {
    if (!userShift.shift) continue;
    const tz = shiftZone(userShift.shift.timeZone, companyTz);
    if (dateKeyFromDbDate(userShift.assignedDate) !== dateKeyInTz(timeLog.timeIn, tz)) continue;

    const startValue = userShift.customStartTime || userShift.shift.startTime;
    const gap = startValue
      ? Math.abs(combineAssignedDateWithTimeTz(userShift.assignedDate, startValue, tz).getTime() - new Date(timeLog.timeIn).getTime())
      : Number.MAX_SAFE_INTEGER;
    if (!best || gap < best.gap) best = { userShift, tz, gap };
  }
  return best ? { userShift: best.userShift, tz: best.tz } : null;
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
      const timezone = shiftZone(null, company.timeZone);
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

        // Find the shift for this time log (BB-148: in the shift's own zone).
        const match = await shiftOfPunch(timeLog, timezone);

        if (match) {
          const { userShift, tz } = match;

          // Calculate expected clock-out time in the shift's zone
          let shiftEndTime = moment(
            combineAssignedDateWithTimeTz(
              userShift.assignedDate,
              userShift.customEndTime || userShift.shift.endTime,
              tz
            )
          ).tz(tz);

          // Handle shifts that cross midnight
          if (userShift.shift.crossesMidnight && shiftEndTime.isBefore(clockInTime)) {
            shiftEndTime = shiftEndTime.add(1, 'day');
          }

          const minutesPastShiftEnd = now.diff(shiftEndTime, 'minutes');

          // If past grace period, notify
          if (minutesPastShiftEnd >= gracePeriod) {
            console.log(`⚠️  Missed clock-out: ${timeLog.user.username}`);

            // BB-144: the shift shown in the email.
            const startValue = userShift.customStartTime || userShift.shift.startTime;
            const shiftStartTime = startValue
              ? moment(combineAssignedDateWithTimeTz(userShift.assignedDate, startValue, tz)).tz(tz)
              : null;

            // BB-117: sent once per punch (dedupe key on the inbox row).
            await notifyMissedClockOut(
              { user: timeLog.user },
              {
                id: timeLog.id,
                timeIn: timeLog.timeIn,
                expectedClockOut: shiftEndTime.toDate(),
                hoursWorked: (timeSinceClockIn / 60).toFixed(2),
                shift: {
                  name: userShift.shift.shiftName,
                  start: shiftStartTime?.isValid() ? shiftStartTime.format('h:mm A') : null,
                  end: shiftEndTime.format('h:mm A'),
                },
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