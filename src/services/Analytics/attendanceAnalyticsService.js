// src/services/Analytics/attendanceAnalyticsService.js
//
// BB-133: shared rules for the Overview pages (/api/analytics/employee and
// /api/analytics/admin-dashboard). One place decides what a "day", "late",
// "absent" and "overtime" mean, so both pages agree with each other and with
// Punch Logs / cutoffs.
//
// Rules (agreed 2026-11-18):
//   - Company time zone for every day boundary, time of day and label. The day
//     of a punch = company-zone date of its clock-in.
//   - The range end is clamped to today (company zone): future days never count.
//   - Hours = TimeLog.netWorkedHours (breaks/lunch already deducted, same as
//     Punch Logs); a closed punch not yet computed falls back to clock-out −
//     clock-in; an open punch counts 0.
//   - Scheduled = UserShift rows that aren't cancelled. A shift whose end is at
//     or before its start ends the next day (overnight).
//   - Late = first clock-in after the day's first shift start + company grace
//     (gracePeriodMinutes, default 15, +59 s like timeLogComputeService).
//   - Early out = last clock-out before the day's last shift end − company
//     earlyClockOutGraceMinutes (default 20). Not judged while a punch is open.
//   - Absent = scheduled day with no punch that is already over (past day, or
//     today after the shift ended), not an approved leave day (LeaveDay, not
//     reverted) and not a company holiday.
//   - Approved overtime = CutoffOtBlock rows with status "approved" (what Punch
//     Logs and payroll use). They exist only once a cutoff is reviewed.
//     "Hours beyond schedule" (worked − scheduled, scheduled days only) is
//     returned separately.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");

const DEFAULT_TZ = "America/Los_Angeles";
const YMD = "YYYY-MM-DD";

class AnalyticsRangeError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const zoneOf = (tz) => (tz && moment.tz.zone(tz) ? tz : DEFAULT_TZ);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const utcDay = (ymd, end = false) => new Date(`${ymd}T${end ? "23:59:59.999" : "00:00:00.000"}Z`); // for @db.Date columns
const dbYmd = (d) => moment.utc(d).format(YMD); // @db.Date → "YYYY-MM-DD"

// ── Range ─────────────────────────────────────────────────────────────────────

const LAST_N = { last_7_days: 7, last_14_days: 14, last_28_days: 28, last_30_days: 30 };

/**
 * period: this_month (default) | last_month | last_7_days | last_14_days |
 * last_28_days | last_30_days | custom (startDate, endDate as YYYY-MM-DD).
 * Returns company-zone dates; `to` is clamped to today, `periodEnd` is not.
 */
function resolveRange({ period = "this_month", startDate, endDate } = {}, tz, { maxCustomDays = 180 } = {}) {
  const zone = zoneOf(tz);
  const today = moment.tz(zone).format(YMD);
  let from;
  let periodEnd;
  let label;

  if (LAST_N[period]) {
    periodEnd = today;
    from = moment.tz(today, YMD, zone).subtract(LAST_N[period] - 1, "days").format(YMD);
    label = `Last ${LAST_N[period]} days`;
  } else if (period === "last_month") {
    const m = moment.tz(zone).subtract(1, "month");
    from = m.clone().startOf("month").format(YMD);
    periodEnd = m.clone().endOf("month").format(YMD);
    label = m.format("MMMM YYYY");
  } else if (period === "custom") {
    const parse = (v, name) => {
      const m = moment.tz(String(v || "").slice(0, 10), YMD, true, zone);
      if (!m.isValid()) throw new AnalyticsRangeError(`${name} must be a date (YYYY-MM-DD).`);
      return m.format(YMD);
    };
    if (!startDate || !endDate) throw new AnalyticsRangeError("startDate and endDate required for custom period");
    from = parse(startDate, "startDate");
    periodEnd = parse(endDate, "endDate");
    if (from > periodEnd) throw new AnalyticsRangeError("startDate must be before endDate");
    if (moment(periodEnd).diff(moment(from), "days") + 1 > maxCustomDays)
      throw new AnalyticsRangeError(`Date range cannot exceed ${maxCustomDays} days`);
    label = `${moment(from).format("MMM D, YYYY")} - ${moment(periodEnd).format("MMM D, YYYY")}`;
  } else {
    period = "this_month";
    const m = moment.tz(zone);
    from = m.clone().startOf("month").format(YMD);
    periodEnd = m.clone().endOf("month").format(YMD);
    label = m.format("MMMM YYYY");
  }

  const to = periodEnd > today ? today : periodEnd;
  const empty = from > to; // the whole range is in the future
  const days = [];
  if (!empty) {
    for (let d = moment.utc(from, YMD); d.format(YMD) <= to; d.add(1, "day")) days.push(d.format(YMD));
  }
  return {
    timeZone: zone,
    period,
    label,
    from,
    to: empty ? from : to,
    periodEnd,
    today,
    empty,
    days,
    startUtc: moment.tz(from, YMD, zone).startOf("day").toDate(),
    endUtc: moment.tz(empty ? from : to, YMD, zone).endOf("day").toDate(),
  };
}

/** The dateRange block every Overview response carries. */
const dateRangeOf = (range) => ({
  start: range.from,
  end: range.to,
  periodEnd: range.periodEnd,
  label: range.label,
  period: range.period,
});

// ── Per-day attendance ────────────────────────────────────────────────────────

const hms = (t) => moment.utc(t).format("HH:mm:ss"); // @db.Time holds wall-clock time as UTC

function shiftWindow(ymd, shift, tz) {
  const start = moment.tz(`${ymd} ${hms(shift.startTime)}`, "YYYY-MM-DD HH:mm:ss", tz);
  let end = moment.tz(`${ymd} ${hms(shift.endTime)}`, "YYYY-MM-DD HH:mm:ss", tz);
  if (shift.crossesMidnight || !end.isAfter(start)) end = end.add(1, "day");
  return { start: start.toDate(), end: end.toDate() };
}

function punchHours(p) {
  if (p.netWorkedHours !== null && p.netWorkedHours !== undefined) return Number(p.netWorkedHours);
  if (!p.timeOut) return 0;
  return Math.max(0, (new Date(p.timeOut) - new Date(p.timeIn)) / 36e5);
}

/**
 * Builds per-user, per-day attendance for a range.
 * @param {{ company: { id, timeZone, gracePeriodMinutes, earlyClockOutGraceMinutes }, userIds: string[], range }} opts
 * @returns {Promise<Map<string, Map<string, object>>>} userId → (ymd → day)
 *
 * Day: { date, hours, scheduledHours, approvedOvertime, beyondSchedule,
 *        status: "on_time"|"late"|"unscheduled"|"absent"|"leave"|"holiday"|"scheduled",
 *        late, earlyOut, absent, onLeave, holiday, worked, scheduled,
 *        firstIn, lastOut ("HH:mm" company zone), openPunch, punchCount }
 * Days with nothing to show (no punch, shift, leave, holiday or OT) are left out.
 */
async function buildAttendance({ company, userIds, range }) {
  const out = new Map(userIds.map((id) => [id, new Map()]));
  if (range.empty || userIds.length === 0) return out;

  const tz = range.timeZone;
  const graceMs = ((company.gracePeriodMinutes ?? 15) * 60 + 59) * 1000;
  const earlyGraceMs = (company.earlyClockOutGraceMinutes ?? 20) * 60000;
  const dbFrom = utcDay(range.from);
  const dbTo = utcDay(range.to, true);

  const [punches, userShifts, leaveDays, holidays, otBlocks] = await Promise.all([
    prisma.timeLog.findMany({
      where: { userId: { in: userIds }, timeIn: { gte: range.startUtc, lte: range.endUtc } },
      select: { id: true, userId: true, timeIn: true, timeOut: true, netWorkedHours: true },
      orderBy: { timeIn: "asc" },
    }),
    prisma.userShift.findMany({
      where: { userId: { in: userIds }, assignedDate: { gte: dbFrom, lte: dbTo }, status: { not: "cancelled" } },
      select: {
        userId: true,
        assignedDate: true,
        shift: { select: { id: true, startTime: true, endTime: true, crossesMidnight: true } },
      },
    }),
    prisma.leaveDay.findMany({
      where: {
        date: { gte: dbFrom, lte: dbTo },
        revertedAt: null,
        leave: { userId: { in: userIds }, status: "approved" },
      },
      select: { date: true, leave: { select: { userId: true } } },
    }),
    prisma.holiday.findMany({
      where: { companyId: company.id, date: { gte: dbFrom, lte: dbTo } },
      select: { date: true, name: true },
    }),
    prisma.cutoffOtBlock.findMany({
      where: { userId: { in: userIds }, date: { gte: dbFrom, lte: dbTo }, status: "approved" },
      select: { userId: true, date: true, otHours: true },
    }),
  ]);

  const holidayByDay = new Map(holidays.map((h) => [dbYmd(h.date), h.name]));
  const key = (uid, ymd) => `${uid}|${ymd}`;
  const group = (rows, getKey) => {
    const m = new Map();
    for (const r of rows) {
      const k = getKey(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const punchesBy = group(punches, (p) => key(p.userId, moment(p.timeIn).tz(tz).format(YMD)));
  const shiftsBy = group(userShifts, (s) => key(s.userId, dbYmd(s.assignedDate)));
  const leaveSet = new Set(leaveDays.map((l) => key(l.leave.userId, dbYmd(l.date))));
  const otBy = new Map();
  for (const b of otBlocks) {
    const k = key(b.userId, dbYmd(b.date));
    otBy.set(k, (otBy.get(k) || 0) + Number(b.otHours));
  }

  const now = new Date();
  const hhmm = (d) => (d ? moment(d).tz(tz).format("HH:mm") : null);

  for (const uid of userIds) {
    const days = out.get(uid);
    for (const ymd of range.days) {
      const k = key(uid, ymd);
      const dayPunches = punchesBy.get(k) || [];
      const dayShifts = (shiftsBy.get(k) || []).filter((s) => s.shift?.startTime && s.shift?.endTime);
      const onLeave = leaveSet.has(k);
      const holiday = holidayByDay.has(ymd);
      const approvedOvertime = round2(otBy.get(k) || 0);
      if (!dayPunches.length && !dayShifts.length && !onLeave && !holiday && !approvedOvertime) continue;

      const hours = dayPunches.reduce((n, p) => n + punchHours(p), 0);
      const windows = dayShifts.map((s) => shiftWindow(ymd, s.shift, tz));
      const scheduledHours = windows.reduce((n, w) => n + (w.end - w.start) / 36e5, 0);
      const shiftStart = windows.length ? new Date(Math.min(...windows.map((w) => w.start.getTime()))) : null;
      const shiftEnd = windows.length ? new Date(Math.max(...windows.map((w) => w.end.getTime()))) : null;

      const worked = dayPunches.length > 0;
      const openPunch = dayPunches.some((p) => !p.timeOut);
      const firstIn = worked ? new Date(Math.min(...dayPunches.map((p) => new Date(p.timeIn).getTime()))) : null;
      const outs = dayPunches.filter((p) => p.timeOut).map((p) => new Date(p.timeOut).getTime());
      const lastOut = outs.length ? new Date(Math.max(...outs)) : null;

      const scheduled = windows.length > 0;
      const late = Boolean(worked && shiftStart && firstIn.getTime() > shiftStart.getTime() + graceMs);
      const earlyOut = Boolean(
        worked && shiftEnd && !openPunch && lastOut && lastOut.getTime() < shiftEnd.getTime() - earlyGraceMs
      );
      const dayOver = ymd < range.today || (shiftEnd && shiftEnd < now);
      const absent = Boolean(scheduled && !worked && !onLeave && !holiday && dayOver);

      let status;
      if (worked) status = scheduled ? (late ? "late" : "on_time") : "unscheduled";
      else if (onLeave) status = "leave";
      else if (holiday) status = "holiday";
      else if (absent) status = "absent";
      else if (scheduled) status = "scheduled"; // today, shift not over yet
      else status = "unscheduled";

      days.set(ymd, {
        date: ymd,
        hours: round2(hours),
        scheduledHours: round2(scheduledHours),
        approvedOvertime,
        beyondSchedule: scheduled ? round2(Math.max(0, hours - scheduledHours)) : 0,
        status,
        late,
        earlyOut,
        absent,
        onLeave,
        holiday,
        worked,
        scheduled,
        firstIn: hhmm(firstIn),
        lastOut: openPunch ? null : hhmm(lastOut),
        openPunch,
        punchCount: dayPunches.length,
      });
    }
  }
  return out;
}

/** Company fields the rules above need. */
async function loadCompanyRules(companyId) {
  return prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, timeZone: true, gracePeriodMinutes: true, earlyClockOutGraceMinutes: true },
  });
}

module.exports = {
  AnalyticsRangeError,
  resolveRange,
  dateRangeOf,
  buildAttendance,
  loadCompanyRules,
  round2,
};
