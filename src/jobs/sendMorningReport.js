const { prisma } = require('@config/connection');
const { HUMAN_ONLY } = require('@utils/systemAgent');
const { sendMorningReport } = require('@services/notificationService');
const { claimDueCompanies, listName, shiftTimeStr } = require('@services/attendanceReportSchedule');
const moment = require('moment-timezone');

/**
 * Send daily morning report to management
 * Lists employees who missed clock-in and who's currently clocked in
 *
 * BB-117: runs every 5 minutes; each company gets its report at its own
 * morningReportTime in its own time zone, once per day (attendanceReportSchedule).
 * Today's shifts are read by the company-zone date (assignedDate is stored as
 * UTC midnight of the calendar date), names are "Last, First".
 */
async function sendMorningReportJob() {
  try {
    const companies = await claimDueCompanies('morning', { notifyAdminMissedClocks: true });
    if (!companies.length) return;

    for (const company of companies) {
      const timezone = company.timeZone;
      const now = company.now;

      // assignedDate holds the calendar date at UTC midnight: match the company's date.
      const dayStart = new Date(`${company.dateKey}T00:00:00.000Z`);
      const dayEnd = new Date(`${company.dateKey}T23:59:59.999Z`);

      const todayShifts = await prisma.userShift.findMany({
        where: {
          assignedDate: { gte: dayStart, lte: dayEnd },
          status: { not: 'cancelled' },
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
          shift: true,
        },
      });

      const missedClockIns = [];
      const currentlyClockedIn = [];

      for (const userShift of todayShifts) {
        const startTime = shiftTimeStr(userShift.customStartTime || userShift.shift?.startTime);
        if (!startTime) continue;
        const shiftStartTime = moment.tz(`${company.dateKey} ${startTime}`, 'YYYY-MM-DD HH:mm:ss', timezone);
        if (!shiftStartTime.isValid() || !shiftStartTime.isBefore(now)) continue;

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

        const employeeName = listName(userShift.user);
        const department = userShift.user.department?.name || 'N/A';

        if (!clockIn) {
          missedClockIns.push({
            employeeName,
            department,
            scheduledTime: shiftStartTime.format('h:mm A'),
            minutesLate: now.diff(shiftStartTime, 'minutes'),
          });
        } else if (!clockIn.timeOut) {
          currentlyClockedIn.push({
            employeeName,
            department,
            clockInTime: moment(clockIn.timeIn).tz(timezone).format('h:mm A'),
            hoursWorked: now.diff(moment(clockIn.timeIn), 'hours', true).toFixed(1),
          });
        }
      }

      const byName = (a, b) => a.employeeName.localeCompare(b.employeeName);
      missedClockIns.sort(byName);
      currentlyClockedIn.sort(byName);

      // Send report only if there's something to report
      if (missedClockIns.length > 0 || currentlyClockedIn.length > 0) {
        console.log(`📧 Morning report for ${company.name}: ${missedClockIns.length} missed, ${currentlyClockedIn.length} clocked in`);
        await sendMorningReport(company.id, missedClockIns, currentlyClockedIn, { dateKey: company.dateKey });
      } else {
        console.log(`✅ Morning report for ${company.name}: nothing to report`);
      }
    }
  } catch (error) {
    console.error('❌ Error sending morning reports:', error);
  }
}

module.exports = sendMorningReportJob;
