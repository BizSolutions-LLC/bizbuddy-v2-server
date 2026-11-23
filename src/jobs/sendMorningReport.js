const { prisma } = require('@config/connection');
const { HUMAN_ONLY } = require('@utils/systemAgent');
const { sendMorningReport } = require('@services/notificationService');
const { claimDueCompanies, listName, shiftTimeStr } = require('@services/attendanceReportSchedule');
const moment = require('moment-timezone');

/**
 * Send daily morning report to management
 *
 * BB-117: runs every 5 minutes; each company gets its report at its own
 * morningReportTime in its own time zone, once per day (attendanceReportSchedule).
 * Today's shifts are read by the company-zone date (assignedDate is stored as
 * UTC midnight of the calendar date), names are "Last, First".
 *
 * BB-144: one row per employee (not per shift). Counted: employees whose first
 * shift today has already started, minus anyone on approved leave today or on a
 * company holiday. Of those:
 *   - "Not clocked in": no clock-in from 30 min before that shift until now.
 *   - "Late": first clock-in after the shift start + company grace
 *     (gracePeriodMinutes, default 15, +59 s; same rule as the Overview pages,
 *     services/Analytics/attendanceAnalyticsService.js).
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

      const [todayShifts, rules, holiday] = await Promise.all([
        prisma.userShift.findMany({
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
        }),
        prisma.company.findUnique({ where: { id: company.id }, select: { gracePeriodMinutes: true } }),
        prisma.holiday.findFirst({ where: { companyId: company.id, date: { gte: dayStart, lte: dayEnd } }, select: { id: true } }),
      ]);
      const graceMs = ((rules?.gracePeriodMinutes ?? 15) * 60 + 59) * 1000;

      // Employee → their first shift today that has already started.
      const firstStarted = new Map();
      for (const userShift of todayShifts) {
        const startTime = shiftTimeStr(userShift.customStartTime || userShift.shift?.startTime);
        if (!startTime) continue;
        const start = moment.tz(`${company.dateKey} ${startTime}`, 'YYYY-MM-DD HH:mm:ss', timezone);
        if (!start.isValid() || !start.isBefore(now)) continue;
        const endTime = shiftTimeStr(userShift.customEndTime || userShift.shift?.endTime);
        const prev = firstStarted.get(userShift.userId);
        if (!prev || start.isBefore(prev.start)) {
          firstStarted.set(userShift.userId, { userShift, start, endTime });
        }
      }

      const userIds = [...firstStarted.keys()];
      const onLeave = new Set();
      if (userIds.length && !holiday) {
        const leaveDays = await prisma.leaveDay.findMany({
          where: {
            date: { gte: dayStart, lte: dayEnd },
            revertedAt: null,
            leave: { userId: { in: userIds }, status: 'approved' },
          },
          select: { leave: { select: { userId: true } } },
        });
        for (const l of leaveDays) onLeave.add(l.leave.userId);
      }

      let scheduledCount = 0;
      let clockedInCount = 0;
      const missing = [];
      const late = [];

      if (!holiday) {
        for (const [userId, { userShift, start }] of firstStarted) {
          if (onLeave.has(userId)) continue;
          scheduledCount++;

          const firstPunch = await prisma.timeLog.findFirst({
            where: {
              userId,
              timeIn: {
                gte: start.clone().subtract(30, 'minutes').toDate(),
                lte: now.toDate(),
              },
            },
            orderBy: { timeIn: 'asc' },
            select: { timeIn: true },
          });

          const name = listName(userShift.user);
          const shiftName = userShift.shift?.shiftName || 'Shift';

          if (!firstPunch) {
            missing.push({ name, detail: `${shiftName} · ${start.format('h:mm A')}`, status: 'Not in' });
            continue;
          }

          clockedInCount++;
          const inAt = moment(firstPunch.timeIn).tz(timezone);
          if (inAt.valueOf() > start.valueOf() + graceMs) {
            const minutesLate = Math.max(1, Math.round(inAt.diff(start, 'minutes', true)));
            late.push({ name, detail: `${shiftName} · in at ${inAt.format('h:mm A')}`, status: `Late ${minutesLate}m` });
          }
        }
      }

      const byName = (a, b) => a.name.localeCompare(b.name);
      missing.sort(byName);
      late.sort(byName);

      // Send report only if there's something to report
      if (scheduledCount > 0) {
        console.log(`📧 Morning report for ${company.name}: ${scheduledCount} scheduled, ${clockedInCount} in, ${late.length} late, ${missing.length} missing`);
        await sendMorningReport(
          company.id,
          { scheduledCount, clockedInCount, missing, late },
          { dateKey: company.dateKey },
        );
      } else {
        console.log(`✅ Morning report for ${company.name}: nothing to report`);
      }
    }
  } catch (error) {
    console.error('❌ Error sending morning reports:', error);
  }
}

module.exports = sendMorningReportJob;
