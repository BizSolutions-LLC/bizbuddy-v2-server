// src/utils/leaveUtils.js
const { prisma } = require("@config/connection");
const moment     = require("moment-timezone");

/**
 * Walks a leave date range and returns the deductible hours for each
 * individual day. This is the single source of truth for "how many hours
 * does day X of this leave cost" — calcRequestedHours (total) and the
 * per-day approval proration (leaveApprovalService) both build on this, so
 * they can never disagree.
 *
 * Deductible days are those that are:
 *   1. Within the startDate–endDate range (inclusive)
 *   2. Not a weekend (Saturday/Sunday)
 *   3. Not a company holiday (Holiday table, scoped to companyId)
 *   4. A working day for the employee — determined by:
 *        - If the employee has UserShift records in the range → only dates with
 *          at least one non-cancelled UserShift count
 *        - If no UserShifts exist in the range (SV/Manager/salaried staff) →
 *          all non-weekend, non-holiday dates count
 *
 * All date comparisons use the company's configured timezone (America/Los_Angeles
 * for California clients). Falls back to "America/Los_Angeles" if not set.
 *
 * @param {string} userId    - The employee requesting leave
 * @param {string} startISO  - Leave start date (ISO string or YYYY-MM-DD)
 * @param {string} endISO    - Leave end date (ISO string or YYYY-MM-DD)
 * @returns {Array<{date: string, hours: number}>} - One entry per deductible day, in order
 */
async function calcDailyHours(userId, startISO, endISO) {
  const user = await prisma.user.findUnique({
    where:   { id: userId },
    include: { company: true },
  });
  if (!user?.company) throw new Error("Company not found for user");

  const tz         = user.company.timeZone || "America/Los_Angeles";
  const shiftHours = Number(user.company.defaultShiftHours || 8);
  const companyId  = user.company.id;

  // Resolve start/end as calendar dates in the company timezone
  const startDate = moment.tz(startISO, tz).startOf("day");
  const endDate   = moment.tz(endISO,   tz).startOf("day");

  // ── 1. Fetch company holidays in the range ──────────────────────────────────
  const holidays = await prisma.holiday.findMany({
    where: {
      companyId,
      date: {
        gte: startDate.toDate(),
        lte: endDate.toDate(),
      },
    },
    select: { date: true },
  });

  // Build a Set of holiday date strings (YYYY-MM-DD). Holiday.date is a plain
  // @db.Date column (no time/timezone) — read the calendar date directly.
  // NEVER run it through moment().tz(): that reinterprets the UTC-midnight
  // storage instant as a real moment and rolls it back a day in negative-UTC
  // timezones like America/Los_Angeles.
  const holidaySet = new Set(
    holidays.map((h) => h.date.toISOString().split("T")[0])
  );

  // ── 2. Fetch UserShifts with actual shift duration ──────────────────────────
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

  // A day counts as "scheduled" only if it has an actual plotted shift within
  // the requested range. If nothing is plotted in-range at all, fall back to
  // the company default for every eligible day below — checking for a shift
  // anywhere in the employee's history (past or future) doesn't tell us
  // anything about whether *this* range was scheduled.
  const isShiftWorker = shiftHoursMap.size > 0;

  // ── 3. Walk each calendar day and collect deductible hours ─────────────────
  const days = [];
  const cursor = startDate.clone();

  while (cursor.isSameOrBefore(endDate, "day")) {
    const dateStr   = cursor.format("YYYY-MM-DD");
    const dayOfWeek = cursor.day(); // 0 = Sunday, 6 = Saturday

    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = holidaySet.has(dateStr);

    if (!isWeekend && !isHoliday) {
      if (isShiftWorker) {
        // Shift-assigned employee: only deduct hours for days with an actual scheduled shift
        if (shiftHoursMap.has(dateStr)) {
          days.push({ date: dateStr, hours: +shiftHoursMap.get(dateStr).toFixed(2) });
        }
      } else {
        // Salaried/unassigned employee: fall back to company default shift hours
        days.push({ date: dateStr, hours: +shiftHours.toFixed(2) });
      }
    }

    cursor.add(1, "day");
  }

  return days;
}

/**
 * Total deductible hours for a leave request — sum of calcDailyHours().
 * @returns {number} Total deductible hours (2dp)
 */
async function calcRequestedHours(userId, startISO, endISO) {
  const days = await calcDailyHours(userId, startISO, endISO);
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
