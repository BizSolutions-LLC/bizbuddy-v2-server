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
 * @returns {Array<{date: string, hours: number}>} - One entry per deductible day, in order
 */
async function calcDailyHours(userId, startISO, endISO, options = {}) {
  const { requestedStartTime, requestedEndTime } = options;
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
      assignedDate: true,
      shift: { select: { startTime: true, endTime: true, crossesMidnight: true } },
    },
  });

  // Build a Map: dateStr → actual shift hours for that day. assignedDate is a
  // plain @db.Date column (like Holiday.date above) — read it directly, never
  // through moment().tz(), which would roll it back a day in Pacific time.
  const shiftHoursMap = new Map();
  for (const us of userShifts) {
    if (!us.shift) continue;
    const dateStr = us.assignedDate.toISOString().split("T")[0];
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

    if (shiftHoursMap.has(dateStr)) {
      // Actual plotted shift for this day — always wins, regardless of
      // weekday/weekend/holiday.
      days.push({ date: dateStr, hours: +shiftHoursMap.get(dateStr).toFixed(2) });
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

function monthlyIncrement(policy, defaultShiftHours = 8) {
  const alloc  = Number(policy.annualAllocation);
  const perYear =
    policy.accrualUnit === "days" ? alloc * defaultShiftHours : alloc;
  return +(perYear / 12).toFixed(2);
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
function leaveVisibilityWhere(companyId, role, departmentId, relationField = "User") {
  if (role === "supervisor") {
    return departmentId
      ? { [relationField]: { companyId, departmentId } }
      : { [relationField]: { companyId, id: "" } }; // matches no one
  }
  return { [relationField]: { companyId } };
}

module.exports = { calcDailyHours, calcRequestedHours, monthlyIncrement, leaveVisibilityWhere };
