const { prisma } = require('@config/connection');
const { HUMAN_ONLY } = require('@utils/systemAgent');
const { sendEveningReport } = require('@services/notificationService');
const { claimDueCompanies, listName, shiftTimeStr, calendarDate } = require('@services/attendanceReportSchedule');
const moment = require('moment-timezone');

/**
 * Send daily evening report to management
 * Lists employees who haven't clocked out and who's still clocked in
 */
async function sendEveningReportJob() {
  try {
    // BB-117: runs every 5 minutes; each company gets its report at its own
    // eveningReportTime in its own time zone, once per day.
    const companies = await claimDueCompanies('evening', { notifyAdminMissedClocks: true });
    if (!companies.length) return;

    for (const company of companies) {
      const timezone = company.timeZone;
      const now = company.now;

      // Find all active time logs (still clocked in)
      const stillClockedIn = await prisma.timeLog.findMany({
        where: {
          timeOut: null,
          user: {
            ...HUMAN_ONLY,
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

      const missedClockOuts = [];
      const activeEmployees = [];

      for (const timeLog of stillClockedIn) {
        const clockInTime = moment(timeLog.timeIn).tz(timezone);
        const hoursWorked = now.diff(clockInTime, 'hours', true).toFixed(1);

        // Find their shift. BB-117: assignedDate is the calendar date at UTC midnight,
        // so match the company-zone date of the clock-in (as checkMissedClockOuts does).
        const localDateStr = clockInTime.format('YYYY-MM-DD');
        const userShift = await prisma.userShift.findFirst({
          where: {
            userId: timeLog.userId,
            status: { not: 'cancelled' },
            assignedDate: {
              gte: new Date(`${localDateStr}T00:00:00.000Z`),
              lte: new Date(`${localDateStr}T23:59:59.999Z`),
            },
          },
          include: { shift: true },
        });

        const employeeData = {
          employeeName: listName(timeLog.user),
          department: timeLog.user.department?.name || 'N/A',
          clockInTime: clockInTime.format('h:mm A'),
          hoursWorked,
        };

        if (userShift) {
          // ✅ Fix 1: Guard against null/undefined endTime
          const endTime = shiftTimeStr(userShift.customEndTime || userShift.shift?.endTime);

          if (!endTime) {
            // No end time defined — treat as active, no expectedClockOut
            activeEmployees.push(employeeData);
            continue;
          }

          // ✅ Fix 2: Use moment-timezone to get correct local date (not UTC)
          // BB-117: assignedDate is already the calendar date (UTC midnight); converting it
          // to a negative-offset zone moved it to the day before.
          const assignedDateStr = calendarDate(userShift.assignedDate);
          const shiftEndTime = moment.tz(
            `${assignedDateStr} ${endTime}`,
            'YYYY-MM-DD HH:mm:ss',
            timezone
          );

          if (!shiftEndTime.isValid()) {
            // ✅ Fix 3: Extra safety net — if still invalid for any reason
            activeEmployees.push(employeeData);
            continue;
          }

          if (userShift.shift.crossesMidnight && shiftEndTime.isBefore(clockInTime)) {
            shiftEndTime.add(1, 'day');
          }

          if (now.isAfter(shiftEndTime)) {
            // Should have clocked out by now
            const minutesOverdue = now.diff(shiftEndTime, 'minutes');
            missedClockOuts.push({
              ...employeeData,
              expectedClockOut: shiftEndTime.format('h:mm A'),
              minutesOverdue,
            });
          } else {
            // Still within shift time
            activeEmployees.push({
              ...employeeData,
              expectedClockOut: shiftEndTime.format('h:mm A'),
            });
          }
        } else {
          // No shift found but still clocked in — no expectedClockOut
          activeEmployees.push(employeeData);
        }
      }

      const byName = (a, b) => a.employeeName.localeCompare(b.employeeName);
      missedClockOuts.sort(byName);
      activeEmployees.sort(byName);

      // Send report
      if (missedClockOuts.length > 0 || activeEmployees.length > 0) {
        console.log(`📧 Sending evening report for ${company.name}`);
        await sendEveningReport(company.id, missedClockOuts, activeEmployees, { dateKey: company.dateKey });
      } else {
        console.log(`✅ All employees clocked out for ${company.name}`);
      }
    }

  } catch (error) {
    console.error('❌ Error sending evening reports:', error);
  }
}

module.exports = sendEveningReportJob;