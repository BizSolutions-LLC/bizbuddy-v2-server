// src/utils/leaveUtils.js
const { prisma } = require("@config/connection");
const moment     = require("moment-timezone");

/**
 * Minutes-since-midnight from a time-of-day value, UTC. Mirrors
 * shiftScheduleController.js's toMinutes() — time columns (Shift.startTime/
 * endTime, Leave.requestedStartTime/requestedEndTime) are all stored as
 * @db.Time anchored to epoch date 1970-01-01, e.g. "1970-01-01T08:00:00.000Z".
 */
function _timeToMinutes(t) {
  const d = new Date(t);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Walks a leave date range and returns the deductible hours for each
 * individual day. This is the single source of truth for "how many hours
 * does day X of this leave cost" — calcRequestedHours (total) and the
 * per-day approval proration (leaveApprovalService) both build on this, so
 * they can never disagree.
 *
 * Every calendar day within the startDate–endDate range (inclusive) is
 * deductible — there is no weekend or company-holiday exclusion. Each day's
 * hours come from whichever applies:
 *   - An actual non-cancelled UserShift plotted for that date → real shift
 *     hours, regardless of what day of the week it falls on.
 *   - No shift plotted for that date → the employee-entered daily time
 *     window (capped at Company.defaultShiftHours) if the request included
 *     one, else the flat defaultShiftHours. Applies uniformly whether the
 *     day is a weekday, a weekend, or a company holiday — none of those are
 *     distinguished from an ordinary unplotted workday anymore.
 *
 * All date comparisons use the company's configured timezone (America/Los_Angeles
 * for California clients). Falls back to "America/Los_Angeles" if not set.
 *
 * @param {string} userId    - The employee requesting leave
 * @param {string} startISO  - Leave start date (ISO string or YYYY-MM-DD)
 * @param {string} endISO    - Leave end date (ISO string or YYYY-MM-DD)
 * @param {object} [options]
 * @param {Date|string} [options.requestedStartTime] - Employee-entered daily time window
 *   (BB-048), used as the no-shift-day fallback — the flat defaultShiftHours
 *   fallback becomes time-diff-based, capped at defaultShiftHours, when both
 *   times are given. A time-of-day value on any base date; only the UTC
 *   hour/minute are read (matches how Shift.startTime/endTime are stored).
 * @param {Date|string} [options.requestedEndTime]
 * @param {string[]} [options.excludeShiftIds] - BB-054: UserShift ids to leave out of the
 *   shift-hours sum (an employee deselecting one shift on a multi-shift day). A day whose
 *   shifts are entirely excluded still counts as a "real shift day" (0h, no fallback) —
 *   only a day with no plotted UserShift at all uses the fallback branch below.
 * @param {boolean} [options.includeWeekends] - BB-054: default true. When false, an unplotted
 *   Saturday/Sunday contributes 0h instead of the fallback. A weekend day with an actual
 *   plotted shift is unaffected either way.
 * @returns {Array<{date: string, hours: number}>} - One entry per deductible day, in order
 */
async function calcDailyHours(userId, startISO, endISO, options = {}) {
  const { requestedStartTime, requestedEndTime, excludeShiftIds, includeWeekends = true } = options;
  const excludeSet = new Set(excludeShiftIds || []);
  const user = await prisma.user.findUnique({
    where:   { id: userId },
    include: { company: true },
  });
  if (!user?.company) throw new Error("Company not found for user");

  const tz         = user.company.timeZone || "America/Los_Angeles";
  const shiftHours = Number(user.company.defaultShiftHours || 8);

  // Resolve start/end as calendar dates in the company timezone
  const startDate = moment.tz(startISO, tz).startOf("day");
  const endDate   = moment.tz(endISO,   tz).startOf("day");

  // ── 1. Fetch UserShifts with actual shift duration ──────────────────────────
  const userShifts = await prisma.userShift.findMany({
    where: {
      userId,
      assignedDate: {
        gte: startDate.toDate(),
        lte: endDate.clone().endOf("day").toDate(),
      },
      status: { not: "cancelled" },
    },
    select: {
      id:           true,
      assignedDate: true,
      shift: { select: { startTime: true, endTime: true, crossesMidnight: true } },
    },
  });

  // Two maps: datesWithShift tracks every date with at least one real plotted
  // shift (excluded or not), so an all-excluded day still counts as "a real
  // shift day, 0h" rather than falling through to the fallback branch below.
  // shiftHoursMap sums only the non-excluded shifts' hours. assignedDate is a
  // plain @db.Date column (like Holiday.date above) — read it directly, never
  // through moment().tz(), which would roll it back a day in Pacific time.
  const datesWithShift = new Set();
  const shiftHoursMap = new Map();
  for (const us of userShifts) {
    if (!us.shift) continue;
    const dateStr = us.assignedDate.toISOString().split("T")[0];
    datesWithShift.add(dateStr);
    if (excludeSet.has(us.id)) continue;
    const s = us.shift.startTime;
    const e = us.shift.endTime;
    let hrs = (e.getTime() - s.getTime()) / 36e5;
    if (us.shift.crossesMidnight || hrs < 0) hrs += 24;
    shiftHoursMap.set(dateStr, (shiftHoursMap.get(dateStr) || 0) + hrs);
  }

  // BB-048 (part 2, widened to weekends/holidays): every day without an
  // actual plotted shift falls back to a computed value — the employee-
  // entered time window, capped at defaultShiftHours, if one was given,
  // else the flat default. This applies to every calendar day in the range,
  // including weekends and company holidays — there is no longer a concept
  // of an "excluded" day; a real shift always wins where one exists, and
  // every other day (weekday, weekend, or holiday alike) is priced via the
  // fallback.
  let requestedHrs = null;
  if (requestedStartTime && requestedEndTime) {
    const startMin = _timeToMinutes(requestedStartTime);
    const endMin   = _timeToMinutes(requestedEndTime);
    let diff = (endMin - startMin) / 60;
    if (diff < 0) diff += 24;
    requestedHrs = Math.min(diff, shiftHours);
  }

  // ── 2. Walk each calendar day and collect deductible hours ─────────────────
  const days = [];
  const cursor = startDate.clone();

  while (cursor.isSameOrBefore(endDate, "day")) {
    const dateStr = cursor.format("YYYY-MM-DD");

    if (datesWithShift.has(dateStr)) {
      // Actual plotted shift(s) for this day — always wins, regardless of
      // weekday/weekend/holiday. Sum already excludes any deselected shifts
      // (BB-054); a day with every shift deselected correctly lands here at
      // 0h rather than falling through to the fallback branch below.
      days.push({ date: dateStr, hours: +((shiftHoursMap.get(dateStr) || 0).toFixed(2)) });
    } else if (includeWeekends === false && (cursor.day() === 0 || cursor.day() === 6)) {
      // BB-054: unplotted weekend day, employee excluded weekends — 0h,
      // no fallback. A weekend day with a real shift never reaches here.
      days.push({ date: dateStr, hours: 0 });
    } else {
      // No shift plotted for this day — fall back to the requested time
      // window if given, else the flat company default. Applies the same
      // whether the day is an unplotted workday, a weekend, or a holiday.
      const fallbackHrs = requestedHrs !== null ? requestedHrs : shiftHours;
      days.push({ date: dateStr, hours: +fallbackHrs.toFixed(2) });
    }

    cursor.add(1, "day");
  }

  return days;
}

/**
 * Total deductible hours for a leave request — sum of calcDailyHours().
 * @returns {number} Total deductible hours (2dp)
 */
async function calcRequestedHours(userId, startISO, endISO, options = {}) {
  const days = await calcDailyHours(userId, startISO, endISO, options);
  return +days.reduce((sum, d) => sum + d.hours, 0).toFixed(2);
}

/**
 * BB-124: the employee's punches that overlap the time a leave would cover.
 *
 * Each day's leave window follows the same branches as calcDailyHours, so we
 * only compare against time that is actually charged:
 *   - a day with plotted shift(s): one window per shift NOT deselected
 *     (excludeShiftIds), read in the shift's own zone (BB-122 rule);
 *     crossesMidnight shifts run into the next day. The entered
 *     fromTime/toTime is ignored on these days, as it is for the hours.
 *   - an unplotted Sat/Sun with includeWeekends=false: no window (0h).
 *   - any other day: the entered time window (company zone) if given, else
 *     the whole calendar day.
 *
 * Display: the *Local strings are written in the zone the day's leave time
 * belongs to (the shift's zone on shift days, else the company zone), with
 * `timeZone` + `zoneLabel` on each item. A company whose zone differs from
 * its shifts' zone (BizSolutions LLC: company Los Angeles, shifts Manila)
 * would otherwise see the times a calendar day off from the leave date.
 *
 * Punches:
 *   - every TimeLog of the employee (TimeLog.status only means "still clocked
 *     in"); an open punch (no timeOut) counts as running until now.
 *   - a punch whose cutoff approvals exist and are ALL "excluded" pays 0h and
 *     is ignored (user decision 2026-11-23).
 * Overlap is strict: a punch ending 12:30 and a leave starting 12:30 is fine.
 *
 * @returns {Promise<Array>} one entry per (day, punch) pair, in date order.
 *   Empty = no overlap.
 */
async function findLeavePunchOverlaps(userId, startISO, endISO, options = {}) {
  const { now = new Date() } = options;

  // ── 1. Leave windows per day (shared with the leave details, see leaveDayWindows) ──
  const windows = await leaveDayWindows(userId, startISO, endISO, options);
  if (!windows.length) return [];

  // ── 2. Punches touching the overall span ───────────────────────────────────
  const spanFrom = new Date(Math.min(...windows.map((w) => w.from.getTime())));
  const spanTo   = new Date(Math.max(...windows.map((w) => w.to.getTime())));
  const punches = await prisma.timeLog.findMany({
    where: {
      userId,
      timeIn: { lt: spanTo },
      OR: [{ timeOut: null }, { timeOut: { gt: spanFrom } }],
    },
    select: { id: true, timeIn: true, timeOut: true, approvals: { select: { status: true } } },
    orderBy: { timeIn: "asc" },
  });
  const counted = punches.filter((p) =>
    !(p.approvals.length > 0 && p.approvals.every((a) => a.status === "excluded"))
  );

  // ── 3. Overlaps ─────────────────────────────────────────────────────────────
  const fmt = (d, zone) => moment(d).tz(zone).format("YYYY-MM-DD h:mm A");
  const out = [];
  for (const w of windows) {
    for (const p of counted) {
      const pEnd = p.timeOut || now;
      if (p.timeIn < w.to && pEnd > w.from) {
        out.push({
          date:           w.date,
          timeLogId:      p.id,
          punchIn:        p.timeIn,
          punchOut:       p.timeOut,
          stillClockedIn: !p.timeOut,
          leaveFrom:      w.from,
          leaveTo:        w.to,
          timeZone:       w.zone,
          zoneLabel:      zoneLabel(w.zone),
          punchInLocal:   fmt(p.timeIn, w.zone),
          punchOutLocal:  p.timeOut ? fmt(p.timeOut, w.zone) : null,
          leaveFromLocal: fmt(w.from, w.zone),
          leaveToLocal:   fmt(w.to, w.zone),
        });
      }
    }
  }
  return out;
}

/**
 * BB-124 follow-up: the time windows a leave charges, per day — the single source for the BB-124
 * overlap block and the leave details (request details + approval preview).
 * Same rules as calcDailyHours, which prices them:
 *   - a day with plotted shifts: each shift NOT deselected (excludeShiftIds),
 *     read in the shift's own zone (Shift.timeZone → company zone);
 *     a day whose shifts are all deselected has no window (0h);
 *   - an unplotted Sat/Sun when includeWeekends is false: no window (0h);
 *   - any other day: the entered time window (company zone) if given, else
 *     the whole calendar day.
 * LeaveDay stores only date / hours / paid, so this is read live from today's
 * shift assignments: if a day's shifts change after approval, the windows follow.
 *
 * @returns {Promise<Array<{ date, from: Date, to: Date, zone, zoneLabel, kind: "shift"|"requested"|"whole_day",
 *   shiftName: string|null, startLocal: "h:mm A", endLocal: "h:mm A", hours }>>} in date order
 */
async function leaveDayWindows(userId, startISO, endISO, options = {}) {
  const { requestedStartTime, requestedEndTime, excludeShiftIds, includeWeekends = true } = options;
  const excludeSet = new Set(excludeShiftIds || []);

  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { company: { select: { timeZone: true } } },
  });
  const tz = user?.company?.timeZone || "America/Los_Angeles";

  const startDate = moment.tz(startISO, tz).startOf("day");
  const endDate   = moment.tz(endISO,   tz).startOf("day");

  const userShifts = await prisma.userShift.findMany({
    where: {
      userId,
      assignedDate: { gte: startDate.toDate(), lte: endDate.clone().endOf("day").toDate() },
      status: { not: "cancelled" },
    },
    select: {
      id:           true,
      assignedDate: true,
      shift: { select: { shiftName: true, startTime: true, endTime: true, crossesMidnight: true, timeZone: true } },
    },
  });

  // Same day grouping as calcDailyHours: assignedDate is a plain @db.Date.
  const shiftsByDate = new Map();
  for (const us of userShifts) {
    if (!us.shift) continue;
    const dateStr = us.assignedDate.toISOString().split("T")[0];
    if (!shiftsByDate.has(dateStr)) shiftsByDate.set(dateStr, []);
    shiftsByDate.get(dateStr).push(us);
  }

  // Time columns are @db.Time anchored to 1970-01-01 UTC — read UTC h:m:s.
  const hhmmss = (t) => {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  const at = (dateStr, t, zone) => moment.tz(`${dateStr} ${hhmmss(t)}`, "YYYY-MM-DD HH:mm:ss", zone);
  const item = (date, from, to, zone, kind, shiftName) => ({
    date,
    from:       from.toDate(),
    to:         to.toDate(),
    zone,
    zoneLabel:  zoneLabel(zone),
    kind,
    shiftName:  shiftName || null,
    startLocal: from.clone().tz(zone).format("h:mm A"),
    endLocal:   to.clone().tz(zone).format("h:mm A"),
    hours:      +((to - from) / 36e5).toFixed(2),
  });

  const windows = [];
  const cursor = startDate.clone();
  while (cursor.isSameOrBefore(endDate, "day")) {
    const dateStr   = cursor.format("YYYY-MM-DD");
    const dayShifts = shiftsByDate.get(dateStr);

    if (dayShifts) {
      const charged = dayShifts
        .filter((us) => !excludeSet.has(us.id))
        .map((us) => {
          const zone = us.shift.timeZone && moment.tz.zone(us.shift.timeZone) ? us.shift.timeZone : tz;
          const from = at(dateStr, us.shift.startTime, zone);
          let to     = at(dateStr, us.shift.endTime, zone);
          if (us.shift.crossesMidnight || !to.isAfter(from)) to = to.add(1, "day");
          return item(dateStr, from, to, zone, "shift", us.shift.shiftName);
        })
        .sort((a, b) => a.from - b.from);
      windows.push(...charged);
    } else if (includeWeekends === false && (cursor.day() === 0 || cursor.day() === 6)) {
      // 0h day — nothing charged, nothing to overlap.
    } else if (requestedStartTime && requestedEndTime) {
      const from = at(dateStr, requestedStartTime, tz);
      let to     = at(dateStr, requestedEndTime, tz);
      if (!to.isAfter(from)) to = to.add(1, "day");
      windows.push(item(dateStr, from, to, tz, "requested"));
    } else {
      windows.push(item(dateStr, cursor.clone().startOf("day"), cursor.clone().add(1, "day").startOf("day"), tz, "whole_day"));
    }
    cursor.add(1, "day");
  }
  return windows;
}

/**
 * Leave day rows (preview or LeaveDay) + their windows → each row gets
 * `windows: [{ kind, shiftName, start, end, timeZone, zoneLabel, hours }]`
 * (start/end "h:mm A" in that window's zone). A day with no window gets [].
 */
function attachLeaveWindows(rows, windows) {
  const byDate = new Map();
  for (const w of windows) {
    if (!byDate.has(w.date)) byDate.set(w.date, []);
    byDate.get(w.date).push({
      kind:      w.kind,
      shiftName: w.shiftName,
      start:     w.startLocal,
      end:       w.endLocal,
      timeZone:  w.zone,
      zoneLabel: w.zoneLabel,
      hours:     w.hours,
    });
  }
  return rows.map((r) => ({ ...r, windows: byDate.get(String(r.date).slice(0, 10)) || [] }));
}

/**
 * BB-124: one readable sentence for a findLeavePunchOverlaps() result.
 */
// "Asia/Manila" → "Manila", "America/Los_Angeles" → "Los Angeles".
function zoneLabel(zone) {
  return String(zone || "").split("/").pop().replace(/_/g, " ");
}

function describeLeavePunchOverlaps(overlaps) {
  // Drop the date prefix when it is the leave day itself.
  const t = (local, date) => (local && local.startsWith(`${date} `) ? local.slice(date.length + 1) : local);
  const parts = overlaps.map((o) =>
    o.stillClockedIn
      ? `${o.date}: you are clocked in since ${t(o.punchInLocal, o.date)} (${o.zoneLabel} time)`
      : `${o.date}: punch ${t(o.punchInLocal, o.date)} – ${t(o.punchOutLocal, o.date)}, ` +
        `leave ${t(o.leaveFromLocal, o.date)} – ${t(o.leaveToLocal, o.date)} (${o.zoneLabel} time)`
  );
  return `This leave overlaps time you already punched (${parts.join("; ")}). ` +
    "Clock out first, choose times outside the punch, or ask your supervisor to correct the punch.";
}

/**
 * Prisma `where` fragment scoping which employees' Leave rows a management
 * user (admin/superadmin/supervisor) may view. Admins/superadmins see the
 * whole company; supervisors are restricted to their own department. A
 * supervisor with no department sees nothing (there's no department to
 * scope them to) rather than silently falling back to company-wide.
 *
 * Shared by leaveController (list/pending views), dashboardController
 * (sidebar pending-count), and leaveBalanceController (company-wide ledger
 * feed) so the visibility rule can't drift between them.
 *
 * @param {string} relationField - name of the relation to the User model on
 *   the model being queried. Defaults to "User" (Leave's relation field);
 *   pass "user" for LeaveTransaction, whose relation field is lowercase.
 */
// BB-072: a supervisor sees a leave if the requester is in their department,
// OR the supervisor is the requester's individually assigned direct supervisor
// (employmentDetail.supervisorId) — regardless of department. No department and
// no direct reports means the OR list only has the (never-matching) supervisorId
// clause, same net effect as the old "matches no one" fallback.
function leaveVisibilityWhere(companyId, role, actingUserId, departmentId, relationField = "User") {
  if (role === "supervisor") {
    const orConditions = [{ employmentDetail: { supervisorId: actingUserId } }];
    if (departmentId) orConditions.push({ departmentId });
    return { [relationField]: { companyId, OR: orConditions } };
  }
  return { [relationField]: { companyId } };
}

module.exports = {
  calcDailyHours,
  calcRequestedHours,
  leaveVisibilityWhere,
  findLeavePunchOverlaps,
  describeLeavePunchOverlaps,
  leaveDayWindows,
  attachLeaveWindows,
};
