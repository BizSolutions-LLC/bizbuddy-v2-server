// src/utils/leaveUtils.js
const { prisma } = require("@config/connection");
const moment     = require("moment-timezone");

/**
 * Calculates the number of deductible hours for a leave request.
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
 * @returns {number}         - Total deductible hours (2dp)
 */
async function calcRequestedHours(userId, startISO, endISO) {
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

  // Build a Set of holiday date strings (YYYY-MM-DD) in company timezone
  const holidaySet = new Set(
    holidays.map((h) => moment(h.date).tz(tz).format("YYYY-MM-DD"))
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

  // Build a Map: dateStr → actual shift hours for that day
  const shiftHoursMap = new Map();
  for (const us of userShifts) {
    if (!us.shift) continue;
    const dateStr = moment(us.assignedDate).tz(tz).format("YYYY-MM-DD");
    const s = us.shift.startTime;
    const e = us.shift.endTime;
    let hrs = (e.getTime() - s.getTime()) / 36e5;
    if (us.shift.crossesMidnight || hrs < 0) hrs += 24;
    shiftHoursMap.set(dateStr, (shiftHoursMap.get(dateStr) || 0) + hrs);
  }

  // If no shifts were found in the leave range, check whether this employee is
  // a shift worker at all. If they are, only scheduled days count (deduct 0 for
  // unscheduled days). If they have no shifts anywhere, treat them as salaried.
  let isShiftWorker = shiftHoursMap.size > 0;
  if (!isShiftWorker) {
    const anyShift = await prisma.userShift.findFirst({
      where: { userId, status: { not: "cancelled" } },
      select: { id: true },
    });
    isShiftWorker = !!anyShift;
  }

  // ── 3. Walk each calendar day and accumulate hours ─────────────────────────
  let totalHours = 0;
  const cursor = startDate.clone();

  while (cursor.isSameOrBefore(endDate, "day")) {
    const dateStr   = cursor.format("YYYY-MM-DD");
    const dayOfWeek = cursor.day(); // 0 = Sunday, 6 = Saturday

    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = holidaySet.has(dateStr);

    if (!isWeekend && !isHoliday) {
      if (isShiftWorker) {
        // Shift-assigned employee: only deduct hours for days with an actual scheduled shift
        if (shiftHoursMap.has(dateStr)) totalHours += shiftHoursMap.get(dateStr);
      } else {
        // Salaried/unassigned employee: fall back to company default shift hours
        totalHours += shiftHours;
      }
    }

    cursor.add(1, "day");
  }

  return +totalHours.toFixed(2);
}

function monthlyIncrement(policy, defaultShiftHours = 8) {
  const alloc  = Number(policy.annualAllocation);
  const perYear =
    policy.accrualUnit === "days" ? alloc * defaultShiftHours : alloc;
  return +(perYear / 12).toFixed(2);
}

module.exports = { calcRequestedHours, monthlyIncrement };
