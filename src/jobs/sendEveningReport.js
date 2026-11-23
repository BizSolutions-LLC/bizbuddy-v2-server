const { prisma } = require('@config/connection');
const { HUMAN_ONLY } = require('@utils/systemAgent');
const { sendEveningReport } = require('@services/notificationService');
const { claimDueCompanies, listName, shiftTimeStr, calendarDate } = require('@services/attendanceReportSchedule');
const { resolveRange, buildAttendance, loadCompanyRules, round2 } = require('@services/Analytics/attendanceAnalyticsService');
const moment = require('moment-timezone');

/**
 * Send daily evening report to management
 *
 * BB-144: the report has
 *   - Still clocked in: every open punch ("Overdue" once its shift has ended).
 *   - Automatic clock-outs to confirm: punches closed by the system today.
 *   - No-shows, worked count, hours today and hours beyond the schedule: the
 *     Overview rules (services/Analytics/attendanceAnalyticsService.js): company
 *     zone, net hours, leave days and holidays are not no-shows, a shift counts
 *     as missed only once it has ended. Hours beyond the schedule are not
 *     approved overtime yet, so the email marks them "(est.)".
 * Sent when there is something to look at: an open punch, an automatic
 * clock-out or a no-show.
 */
async function buildEveningReport({ id: companyId, timeZone: timezone, now, dateKey }) {
  // ── Still clocked in ─────────────────────────────────────────────────────
  const openLogs = await prisma.timeLog.findMany({
    where: {
      timeOut: null,
      user: {
        ...HUMAN_ONLY,
        companyId,
        status: 'active',
      },
    },
    include: {
      user: { include: { profile: true } },
    },
  });

  const open = [];
  let overdueCount = 0;
  for (const timeLog of openLogs) {
    const clockInTime = moment(timeLog.timeIn).tz(timezone);
    const sinceStr = clockInTime.format('YYYY-MM-DD') === dateKey
      ? clockInTime.format('h:mm A')
      : clockInTime.format('ddd, MMM D h:mm A');

    // Their shift: assignedDate is the calendar date at UTC midnight, so match the
    // company-zone date of the clock-in (as checkMissedClockOuts does).
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

    let shiftEndTime = null;
    const endTime = userShift ? shiftTimeStr(userShift.customEndTime || userShift.shift?.endTime) : null;
    if (endTime) {
      shiftEndTime = moment.tz(`${calendarDate(userShift.assignedDate)} ${endTime}`, 'YYYY-MM-DD HH:mm:ss', timezone);
      if (!shiftEndTime.isValid()) shiftEndTime = null;
      else if (userShift.shift?.crossesMidnight && shiftEndTime.isBefore(clockInTime)) shiftEndTime.add(1, 'day');
    }

    const name = listName(timeLog.user);
    if (shiftEndTime && now.isAfter(shiftEndTime)) {
      overdueCount++;
      const mins = now.diff(shiftEndTime, 'minutes');
      const overdue = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
      open.push({ name, detail: `In since ${sinceStr} · shift ended ${shiftEndTime.format('h:mm A')}`, status: `Overdue ${overdue}` });
    } else if (shiftEndTime) {
      open.push({ name, detail: `In since ${sinceStr} · shift ends ${shiftEndTime.format('h:mm A')}`, status: 'Still in' });
    } else {
      open.push({ name, detail: `In since ${sinceStr}`, status: 'Still in' });
    }
  }

  // ── Automatic clock-outs today ───────────────────────────────────────────
  const dayStartUtc = moment.tz(dateKey, 'YYYY-MM-DD', timezone).startOf('day').toDate();
  const autoLogs = await prisma.timeLog.findMany({
    where: {
      autoClockOut: true,
      autoClockOutAt: { gte: dayStartUtc, lte: now.toDate() },
      user: { ...HUMAN_ONLY, companyId, status: 'active' },
    },
    include: { user: { include: { profile: true } } },
  });
  const autoOut = autoLogs.map((log) => {
    const outStr = log.timeOut ? moment(log.timeOut).tz(timezone).format('h:mm A') : '—';
    return {
      name: listName(log.user),
      detail: `In ${moment(log.timeIn).tz(timezone).format('h:mm A')} · auto out ${outStr}`,
      status: `Auto ${outStr}`,
    };
  });

  // ── Worked, hours, no-shows (Overview rules) ─────────────────────────────
  const people = await prisma.user.findMany({
    where: { ...HUMAN_ONLY, companyId, status: 'active' },
    select: { id: true, username: true, email: true, profile: { select: { firstName: true, lastName: true } } },
  });
  const company = await loadCompanyRules(companyId);
  const range = resolveRange({ period: 'custom', startDate: dateKey, endDate: dateKey }, timezone);
  const attendance = await buildAttendance({ company, userIds: people.map((p) => p.id), range });

  let workedCount = 0;
  let hoursToday = 0;
  let overtimeHours = 0;
  const absentIds = [];
  for (const [userId, days] of attendance) {
    const day = days.get(dateKey);
    if (!day) continue;
    if (day.worked) workedCount++;
    hoursToday += day.hours;
    overtimeHours += day.beyondSchedule;
    if (day.absent) absentIds.push(userId);
  }

  const absent = [];
  if (absentIds.length) {
    const shifts = await prisma.userShift.findMany({
      where: {
        userId: { in: absentIds },
        status: { not: 'cancelled' },
        assignedDate: { gte: new Date(`${dateKey}T00:00:00.000Z`), lte: new Date(`${dateKey}T23:59:59.999Z`) },
      },
      include: { shift: true },
    });
    const byUser = new Map(people.map((p) => [p.id, p]));
    for (const userId of absentIds) {
      const mine = shifts
        .filter((s) => s.userId === userId)
        .map((s) => {
          const start = shiftTimeStr(s.customStartTime || s.shift?.startTime);
          const startStr = start ? moment.tz(`${dateKey} ${start}`, 'YYYY-MM-DD HH:mm:ss', timezone).format('h:mm A') : null;
          return { label: [s.shift?.shiftName, startStr].filter(Boolean).join(' · '), start: start || '' };
        })
        .sort((a, b) => a.start.localeCompare(b.start));
      absent.push({ name: listName(byUser.get(userId)), detail: mine.map((m) => m.label).join(', ') || 'Scheduled', status: 'No-show' });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  open.sort(byName);
  autoOut.sort(byName);
  absent.sort(byName);

  return {
    workedCount,
    hoursToday: round2(hoursToday),
    overtimeHours: round2(overtimeHours),
    open,
    autoOut,
    absent,
    overdueCount,
  };
}

async function sendEveningReportJob() {
  try {
    // BB-117: runs every 5 minutes; each company gets its report at its own
    // eveningReportTime in its own time zone, once per day.
    const companies = await claimDueCompanies('evening', { notifyAdminMissedClocks: true });
    if (!companies.length) return;

    for (const company of companies) {
      const report = await buildEveningReport(company);

      if (report.open.length || report.autoOut.length || report.absent.length) {
        console.log(`📧 Sending evening report for ${company.name}`);
        await sendEveningReport(company.id, report, { dateKey: company.dateKey });
      } else {
        console.log(`✅ Evening report for ${company.name}: nothing to report`);
      }
    }

  } catch (error) {
    console.error('❌ Error sending evening reports:', error);
  }
}

module.exports = sendEveningReportJob;
module.exports.buildEveningReport = buildEveningReport;
