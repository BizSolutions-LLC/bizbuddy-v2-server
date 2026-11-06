// src/controllers/PayrollSystem/importClockHoursController.js
//
// DEPENDENCIES:
// - rrule: npm install rrule
// - This controller uses the 'rrule' package to parse RRULE recurrence patterns
//   from ShiftSchedule records.
//

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { RRule } = require("rrule");

// ============================================================
// CONSTANTS
// ============================================================

const GRACE_PERIOD_MINUTES = 15; // Configurable grace period
const SHIFT_MATCH_WINDOW_HOURS = 2; // Window to match TimeLog to Shift

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Calculate hours between two dates
 * @param {Date} start 
 * @param {Date} end 
 * @returns {number} Hours as decimal (e.g., 8.5)
 */
const calculateHoursBetween = (start, end) => {
  if (!start || !end) return 0;
  const diffMs = new Date(end) - new Date(start);
  if (diffMs < 0) return 0;
  return +(diffMs / (1000 * 60 * 60)).toFixed(2);
};

/**
 * Calculate minutes between two dates
 * @param {Date} start 
 * @param {Date} end 
 * @returns {number} Minutes
 */
const calculateMinutesBetween = (start, end) => {
  if (!start || !end) return 0;
  const diffMs = new Date(end) - new Date(start);
  if (diffMs < 0) return 0;
  return Math.round(diffMs / (1000 * 60));
};

/**
 * Convert Time-only field to full Date on a specific day
 * @param {Date} timeField - Time field from DB (e.g., shift.startTime)
 * @param {Date} targetDate - The date to apply the time to
 * @returns {Date}
 */
const applyTimeToDate = (timeField, targetDate) => {
  const time = new Date(timeField);
  const result = new Date(targetDate);
  result.setHours(time.getUTCHours(), time.getUTCMinutes(), time.getUTCSeconds(), 0);
  return result;
};

/**
 * Get start and end of day for a given date
 * @param {Date|string} date 
 * @returns {Object} { dayStart, dayEnd }
 */
const getDayBounds = (date) => {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);
  return { dayStart, dayEnd };
};

/**
 * Get date string in YYYY-MM-DD format
 * @param {Date} date 
 * @returns {string}
 */
const getDateKey = (date) => {
  return date.toISOString().split('T')[0];
};

/**
 * Parse RRULE string and get occurrences within a date range
 * @param {string} rruleString - RRULE format string
 * @param {Date} rangeStart - Start of range
 * @param {Date} rangeEnd - End of range
 * @param {Date} scheduleStart - Schedule start date (dtstart)
 * @param {Date} scheduleEnd - Schedule end date (optional)
 * @returns {Date[]} Array of dates
 */
const getRRuleOccurrences = (rruleString, rangeStart, rangeEnd, scheduleStart, scheduleEnd) => {
  try {
    if (!rruleString) return [];

    // Determine effective start date (later of schedule start or range start)
    const effectiveStart = new Date(Math.max(
      new Date(scheduleStart).getTime(),
      new Date(rangeStart).getTime()
    ));

    // Determine effective end date (earlier of schedule end or range end)
    let effectiveEnd = new Date(rangeEnd);
    if (scheduleEnd) {
      effectiveEnd = new Date(Math.min(
        new Date(scheduleEnd).getTime(),
        new Date(rangeEnd).getTime()
      ));
    }

    // Parse RRULE
    let rule;
    if (rruleString.startsWith('RRULE:')) {
      rule = RRule.fromString(rruleString);
    } else {
      // Try parsing as raw RRULE options
      rule = RRule.fromString(`RRULE:${rruleString}`);
    }

    // Set dtstart to schedule start
    const options = {
      ...rule.origOptions,
      dtstart: new Date(scheduleStart),
    };

    const ruleWithStart = new RRule(options);

    // Get occurrences within range
    const occurrences = ruleWithStart.between(
      effectiveStart,
      effectiveEnd,
      true // inclusive
    );

    return occurrences;
  } catch (error) {
    console.error('Error parsing RRULE:', rruleString, error.message);
    return [];
  }
};

/**
 * Expand ShiftSchedule.daysOfWeek into concrete dates within a range.
 * daysOfWeek uses JS convention: 0=Sun … 6=Sat (matches shiftScheduleController).
 */
const getDaysOfWeekOccurrences = (daysOfWeek, rangeStart, rangeEnd, scheduleStart, scheduleEnd) => {
  const daysAsNumbers = daysOfWeek.map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6);
  if (daysAsNumbers.length === 0) return [];

  const effectiveStart = new Date(Math.max(
    new Date(scheduleStart).getTime(),
    new Date(rangeStart).getTime()
  ));
  const effectiveEnd = new Date(Math.min(
    new Date(scheduleEnd).getTime(),
    new Date(rangeEnd).getTime()
  ));

  if (effectiveStart > effectiveEnd) return [];

  const occurrences = [];
  const current = new Date(effectiveStart);
  current.setHours(0, 0, 0, 0);
  const end = new Date(effectiveEnd);
  end.setHours(23, 59, 59, 999);

  while (current <= end) {
    if (daysAsNumbers.includes(current.getDay())) {
      occurrences.push(new Date(current));
    }
    current.setDate(current.getDate() + 1);
  }

  return occurrences;
};

/**
 * Calculate break deductions based on department policy
 * @param {Object} timeLog - TimeLog with coffeeBreaks and lunchBreak
 * @param {Object} department - Department with break policies
 * @returns {Object} { lunchDeduction, coffeeDeduction, totalDeduction, details }
 */
const calculateBreakDeductions = (timeLog, department) => {
  let lunchDeductionMinutes = 0;
  let coffeeDeductionMinutes = 0;
  const details = {
    lunchTaken: false,
    lunchMinutes: 0,
    coffeeTaken: 0,
    coffeeMinutes: 0,
    coffeeExcessMinutes: 0,
  };

  // ─────────────────────────────────────────────────────────
  // LUNCH BREAK DEDUCTION
  // ─────────────────────────────────────────────────────────
  if (timeLog.lunchBreak?.start && timeLog.lunchBreak?.end) {
    const lunchMinutes = calculateMinutesBetween(
      timeLog.lunchBreak.start,
      timeLog.lunchBreak.end
    );
    details.lunchTaken = true;
    details.lunchMinutes = lunchMinutes;

    // Deduct if lunch is unpaid
    if (!department.paidBreak) {
      lunchDeductionMinutes = lunchMinutes;
    }
  }

  // ─────────────────────────────────────────────────────────
  // COFFEE BREAK DEDUCTION
  // ─────────────────────────────────────────────────────────
  const coffeeBreaks = Array.isArray(timeLog.coffeeBreaks) ? timeLog.coffeeBreaks : [];
  const completedCoffeeBreaks = coffeeBreaks.filter(b => b.start && b.end);
  
  details.coffeeTaken = completedCoffeeBreaks.length;

  if (completedCoffeeBreaks.length > 0) {
    let totalCoffeeMinutes = 0;
    completedCoffeeBreaks.forEach(b => {
      totalCoffeeMinutes += calculateMinutesBetween(b.start, b.end);
    });
    details.coffeeMinutes = totalCoffeeMinutes;

    const allowedCoffeeMinutes = 
      (department.coffeeBreakMaxCount || 0) * (department.coffeeBreakMinutes || 0);

    if (!department.coffeeBreakPaid) {
      // Coffee breaks are unpaid - deduct all
      coffeeDeductionMinutes = totalCoffeeMinutes;
    } else {
      // Coffee breaks are paid - only deduct excess
      if (totalCoffeeMinutes > allowedCoffeeMinutes) {
        coffeeDeductionMinutes = totalCoffeeMinutes - allowedCoffeeMinutes;
        details.coffeeExcessMinutes = coffeeDeductionMinutes;
      }
    }
  }

  return {
    lunchDeductionMinutes,
    coffeeDeductionMinutes,
    totalDeductionMinutes: lunchDeductionMinutes + coffeeDeductionMinutes,
    lunchDeduction: +(lunchDeductionMinutes / 60).toFixed(2),
    coffeeDeduction: +(coffeeDeductionMinutes / 60).toFixed(2),
    totalDeduction: +((lunchDeductionMinutes + coffeeDeductionMinutes) / 60).toFixed(2),
    details,
  };
};

/**
 * Match a TimeLog to the best fitting shift for that day
 * @param {Object} timeLog - TimeLog with timeIn
 * @param {Array} dayShifts - Array of shift objects for the day
 * @param {Date} targetDate - The target date
 * @returns {Object|null} Matched shift info or null
 */
const matchTimeLogToShift = (timeLog, dayShifts, targetDate) => {
  if (!dayShifts || dayShifts.length === 0) return null;
  if (dayShifts.length === 1) return dayShifts[0];

  const logDate = new Date(timeLog.timeIn);
  
  let bestMatch = null;
  let smallestDiff = Infinity;

  for (const shiftInfo of dayShifts) {
    const shift = shiftInfo.shift;
    if (!shift) continue;

    // Get scheduled start time on this date
    const scheduledStart = applyTimeToDate(shift.startTime, targetDate);

    // Calculate difference in minutes
    const diffMinutes = Math.abs(calculateMinutesBetween(scheduledStart, logDate));

    // Check if within matching window
    if (diffMinutes < SHIFT_MATCH_WINDOW_HOURS * 60 && diffMinutes < smallestDiff) {
      smallestDiff = diffMinutes;
      bestMatch = shiftInfo;
    }
  }

  return bestMatch;
};

/**
 * Calculate effective time with grace period and detect tardy/undertime
 * @param {Object} params
 * @returns {Object}
 */
const calculateEffectiveTime = ({
  actualTimeIn,
  actualTimeOut,
  scheduledStart,
  scheduledEnd,
  graceMinutes = GRACE_PERIOD_MINUTES,
}) => {
  let effectiveIn = actualTimeIn;
  let effectiveOut = actualTimeOut;
  let isTardy = false;
  let tardyMinutes = 0;
  let isUndertime = false;
  let undertimeMinutes = 0;
  let extraMinutes = 0;
  let isEarlyArrival = false;
  let earlyArrivalMinutes = 0;
  let isLateStay = false;
  let lateStayMinutes = 0;

  const graceMs = graceMinutes * 60 * 1000;

  // ─────────────────────────────────────────────────────────
  // CLOCK-IN LOGIC
  // ─────────────────────────────────────────────────────────
  const scheduledStartMs = scheduledStart.getTime();
  const actualInMs = actualTimeIn.getTime();

  if (actualInMs < scheduledStartMs - graceMs) {
    // EARLY ARRIVAL (before grace period) → Cap to scheduled start
    effectiveIn = scheduledStart;
    isEarlyArrival = true;
    earlyArrivalMinutes = Math.round((scheduledStartMs - actualInMs) / (60 * 1000));
  } else if (actualInMs <= scheduledStartMs + graceMs) {
    // WITHIN GRACE PERIOD → Treat as on-time
    effectiveIn = scheduledStart;
  } else {
    // TARDY (beyond grace period) → Use actual time
    effectiveIn = actualTimeIn;
    isTardy = true;
    tardyMinutes = Math.round((actualInMs - scheduledStartMs) / (60 * 1000));
  }

  // ─────────────────────────────────────────────────────────
  // CLOCK-OUT LOGIC
  // ─────────────────────────────────────────────────────────
  const scheduledEndMs = scheduledEnd.getTime();
  const actualOutMs = actualTimeOut.getTime();

  if (actualOutMs < scheduledEndMs - graceMs) {
    // UNDERTIME (left early beyond grace) → Use actual time
    effectiveOut = actualTimeOut;
    isUndertime = true;
    undertimeMinutes = Math.round((scheduledEndMs - actualOutMs) / (60 * 1000));
  } else if (actualOutMs <= scheduledEndMs + graceMs) {
    // WITHIN GRACE PERIOD → Treat as on-time
    effectiveOut = scheduledEnd;
  } else {
    // LATE STAY (beyond grace period) → Cap to scheduled end
    effectiveOut = scheduledEnd;
    isLateStay = true;
    lateStayMinutes = Math.round((actualOutMs - scheduledEndMs) / (60 * 1000));
    extraMinutes = lateStayMinutes;
  }

  return {
    effectiveIn,
    effectiveOut,
    isTardy,
    tardyMinutes,
    isUndertime,
    undertimeMinutes,
    isEarlyArrival,
    earlyArrivalMinutes,
    isLateStay,
    lateStayMinutes,
    extraMinutes,
  };
};

/**
 * Get scheduled hours from shift
 * @param {Object} shift - Shift object
 * @param {Date} targetDate - The date for the shift
 * @param {number} lunchDurationMinutes - Lunch duration
 * @param {boolean} isLunchPaid - Whether lunch is paid
 * @returns {Object}
 */
const getScheduledHoursFromShift = (shift, targetDate, lunchDurationMinutes = 60, isLunchPaid = false) => {
  if (!shift) {
    return {
      scheduledHours: 0,
      scheduledStart: null,
      scheduledEnd: null,
      shiftName: null,
    };
  }

  const dateOnly = new Date(targetDate);
  dateOnly.setHours(0, 0, 0, 0);

  let scheduledStart = applyTimeToDate(shift.startTime, dateOnly);
  let scheduledEnd = applyTimeToDate(shift.endTime, dateOnly);

  // Handle crosses midnight
  if (shift.crossesMidnight && scheduledEnd <= scheduledStart) {
    scheduledEnd.setDate(scheduledEnd.getDate() + 1);
  }

  let scheduledMinutes = calculateMinutesBetween(scheduledStart, scheduledEnd);

  // Deduct lunch if unpaid
  if (!isLunchPaid && lunchDurationMinutes > 0) {
    scheduledMinutes -= lunchDurationMinutes;
  }

  return {
    scheduledHours: +(scheduledMinutes / 60).toFixed(2),
    scheduledStart,
    scheduledEnd,
    shiftName: shift.shiftName,
  };
};

/**
 * Build schedule lookup for employees based on ShiftSchedule (RRULE) and UserShift
 * @param {Array} employees - Array of employee objects
 * @param {Date} periodStart - Start of period
 * @param {Date} periodEnd - End of period
 * @param {string} companyId - Company ID
 * @returns {Object} Lookup map: { `${userId}_${dateKey}`: [{ shift, scheduleType }] }
 */
const buildScheduleLookup = async (employees, periodStart, periodEnd, companyId) => {
  const userIds = employees.map(e => e.id);
  const departmentIds = [...new Set(employees.map(e => e.departmentId).filter(Boolean))];

  // ─────────────────────────────────────────────────────────
  // 1. FETCH USER SHIFTS (direct assignments for specific dates)
  // ─────────────────────────────────────────────────────────
  const userShifts = await prisma.userShift.findMany({
    where: {
      userId: { in: userIds },
      assignedDate: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
    include: {
      shift: true,
    },
  });

  // ─────────────────────────────────────────────────────────
  // 2. FETCH SHIFT SCHEDULES (recurring schedules with RRULE)
  // ─────────────────────────────────────────────────────────
  
  // Match current ShiftSchedule schema: assignmentType + targetId + daysOfWeek
  const assignmentConditions = [
    { assignmentType: "all" },
    { assignmentType: "individual", targetId: { in: userIds } },
  ];

  if (departmentIds.length > 0) {
    assignmentConditions.push({
      assignmentType: "department",
      targetId: { in: departmentIds },
    });
  }

  const shiftSchedules = await prisma.shiftSchedule.findMany({
    where: {
      companyId,
      isActive: true,
      startDate: { lte: periodEnd },
      endDate: { gte: periodStart },
      OR: assignmentConditions,
    },
    include: {
      shift: true,
    },
  });

  // ─────────────────────────────────────────────────────────
  // 3. BUILD LOOKUP MAP
  // ─────────────────────────────────────────────────────────
  const scheduleLookup = {};

  // Helper to add to lookup
  const addToLookup = (userId, dateKey, shiftInfo) => {
    const key = `${userId}_${dateKey}`;
    if (!scheduleLookup[key]) {
      scheduleLookup[key] = [];
    }
    // Avoid duplicates
    const exists = scheduleLookup[key].some(s => s.shift?.id === shiftInfo.shift?.id);
    if (!exists) {
      scheduleLookup[key].push(shiftInfo);
    }
  };

  // Process UserShifts (highest priority)
  userShifts.forEach(us => {
    const dateKey = getDateKey(us.assignedDate);
    addToLookup(us.userId, dateKey, {
      shift: us.shift,
      scheduleType: 'userShift',
      customStartTime: us.customStartTime,
      customEndTime: us.customEndTime,
    });
  });

  // Process ShiftSchedules (daysOfWeek-based recurring assignments)
  for (const schedule of shiftSchedules) {
    if (!schedule.shift) continue;

    const daysOfWeek = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
    if (daysOfWeek.length === 0) continue;

    const occurrences = getDaysOfWeekOccurrences(
      daysOfWeek,
      periodStart,
      periodEnd,
      schedule.startDate,
      schedule.endDate
    );

    let applicableUserIds = [];

    if (schedule.assignmentType === "all") {
      applicableUserIds = userIds;
    } else if (schedule.assignmentType === "individual" && schedule.targetId) {
      if (userIds.includes(schedule.targetId)) {
        applicableUserIds = [schedule.targetId];
      }
    } else if (schedule.assignmentType === "department" && schedule.targetId) {
      applicableUserIds = employees
        .filter((e) => e.departmentId === schedule.targetId)
        .map((e) => e.id);
    }

    // Add to lookup for each occurrence and applicable employee
    for (const occurrence of occurrences) {
      const dateKey = getDateKey(occurrence);
      
      for (const userId of applicableUserIds) {
        // Skip if UserShift already exists for this date (UserShift takes priority)
        const key = `${userId}_${dateKey}`;
        const existingUserShift = scheduleLookup[key]?.some(s => s.scheduleType === 'userShift');
        
        if (!existingUserShift) {
          addToLookup(userId, dateKey, {
            shift: schedule.shift,
            scheduleType: 'shiftSchedule',
            scheduleId: schedule.id,
          });
        }
      }
    }
  }

  return scheduleLookup;
};


// ============================================================
// MAIN CONTROLLER: Import Clock Hours (Summary)
// GET /api/payroll-system/import-clock-hours?from=xxx&to=xxx
// ============================================================

const importClockHours = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { from, to } = req.query;

    // ─────────────────────────────────────────────────────────
    // VALIDATION
    // ─────────────────────────────────────────────────────────
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: "Missing required query parameters: 'from' and 'to' dates",
      });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Use YYYY-MM-DD",
      });
    }

    if (fromDate > toDate) {
      return res.status(400).json({
        success: false,
        message: "'from' date must be before or equal to 'to' date",
      });
    }

    const companyId = req.user.companyId;

    // ─────────────────────────────────────────────────────────
    // FETCH EMPLOYEES WITH DEPARTMENTS
    // ─────────────────────────────────────────────────────────
    const employees = await prisma.user.findMany({
      where: {
        ...HUMAN_ONLY,
        companyId,
        status: "active",
        role: { in: ["employee", "supervisor"] },
      },
      select: {
        id: true,
        email: true,
        departmentId: true,
        profile: {
          select: { firstName: true, lastName: true },
        },
        department: {
          select: {
            id: true,
            name: true,
            paidBreak: true,
            breakDuration: true,
            coffeeBreakMaxCount: true,
            coffeeBreakMinutes: true,
            coffeeBreakPaid: true,
          },
        },
        payrollDetails: {
          select: { payType: true, payRate: true },
        },
      },
    });

    if (employees.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No employees found",
        data: {
          periodStart: from,
          periodEnd: to,
          employees: [],
          summary: {
            totalEmployees: 0,
            totalRegularHours: 0,
            totalOvertimeHours: 0,
            employeesWithActiveClockIn: 0,
            employeesWithPendingOT: 0,
          },
        },
      });
    }

    // ─────────────────────────────────────────────────────────
    // PREPARE DATE RANGE
    // ─────────────────────────────────────────────────────────
    const { dayStart: periodStart } = getDayBounds(fromDate);
    const { dayEnd: periodEnd } = getDayBounds(toDate);

    // ─────────────────────────────────────────────────────────
    // BUILD SCHEDULE LOOKUP (RRULE + UserShift)
    // ─────────────────────────────────────────────────────────
    const scheduleLookup = await buildScheduleLookup(employees, periodStart, periodEnd, companyId);

    // ─────────────────────────────────────────────────────────
    // FETCH ALL TIME LOGS FOR DATE RANGE
    // ─────────────────────────────────────────────────────────
    const userIds = employees.map(e => e.id);

    const timeLogs = await prisma.timeLog.findMany({
      where: {
        userId: { in: userIds },
        timeIn: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      include: {
        overtime: {
          select: { 
            id: true,
            requestedHours: true, 
            status: true,
          },
        },
      },
      orderBy: { timeIn: "asc" },
    });

    // Create TimeLogs lookup by user
    const timeLogsByUser = {};
    timeLogs.forEach(log => {
      if (!timeLogsByUser[log.userId]) {
        timeLogsByUser[log.userId] = [];
      }
      timeLogsByUser[log.userId].push(log);
    });

    // ─────────────────────────────────────────────────────────
    // FETCH PENDING OT COUNTS (batch query)
    // ─────────────────────────────────────────────────────────
    const pendingOTCounts = await prisma.overtime.groupBy({
      by: ['requesterId'],
      where: {
        requesterId: { in: userIds },
        status: "pending",
        timeLog: {
          timeIn: {
            gte: periodStart,
            lte: periodEnd,
          },
        },
      },
      _count: { id: true },
    });

    const pendingOTByUser = {};
    pendingOTCounts.forEach(item => {
      pendingOTByUser[item.requesterId] = item._count.id;
    });

    // ─────────────────────────────────────────────────────────
    // PROCESS EACH EMPLOYEE
    // ─────────────────────────────────────────────────────────
    const results = [];
    let grandTotalRegular = 0;
    let grandTotalOvertime = 0;
    let employeesWithActiveClockIn = 0;
    let employeesWithPendingOT = 0;

    for (const employee of employees) {
      const empLogs = timeLogsByUser[employee.id] || [];
      const department = employee.department || {
        paidBreak: false,
        breakDuration: 60,
        coffeeBreakMaxCount: 0,
        coffeeBreakMinutes: 0,
        coffeeBreakPaid: false,
      };

      // Tracking variables
      let totalRegularHours = 0;
      let totalApprovedOTHours = 0;
      let totalRawClockedHours = 0;
      let totalBreakDeductions = 0;
      let totalScheduledHours = 0;
      let hasActiveClockIn = false;
      
      // Attendance tracking
      let tardyMinutes = 0;
      let tardyCount = 0;
      let undertimeMinutes = 0;
      let undertimeCount = 0;
      let unapprovedExtraMinutes = 0;
      
      // Days tracking
      const workedDates = new Set();
      let daysWithNoSchedule = 0;

      // Process each time log
      for (const log of empLogs) {
        // Check for active clock-in (still clocked in)
        if (log.status === true) {
          hasActiveClockIn = true;
          continue;
        }

        if (!log.timeOut) continue;

        // Get the date of this log
        const logDate = new Date(log.timeIn);
        const dateKey = getDateKey(logDate);
        const scheduleKey = `${employee.id}_${dateKey}`;
        
        // Get scheduled shifts for this day (from RRULE or UserShift)
        const dayShifts = scheduleLookup[scheduleKey] || [];

        // Calculate raw clocked hours
        const rawHours = calculateHoursBetween(log.timeIn, log.timeOut);
        totalRawClockedHours += rawHours;

        // Calculate break deductions
        const breakDeductions = calculateBreakDeductions(log, department);
        totalBreakDeductions += breakDeductions.totalDeduction;

        // Track worked date
        workedDates.add(dateKey);

        // ─────────────────────────────────────────────────────
        // CASE 1: No schedule for this day
        // ─────────────────────────────────────────────────────
        if (dayShifts.length === 0) {
          daysWithNoSchedule++;
          
          // Count all net hours (no cap)
          const netWorkedHours = Math.max(0, rawHours - breakDeductions.totalDeduction);
          totalRegularHours += netWorkedHours;

          // Still process approved OT
          if (log.overtime && log.overtime.length > 0) {
            log.overtime.forEach(ot => {
              if (ot.status === 'approved' && ot.requestedHours) {
                totalApprovedOTHours += parseFloat(ot.requestedHours);
              }
            });
          }

          continue;
        }

        // ─────────────────────────────────────────────────────
        // CASE 2: Has schedule - apply grace period logic
        // ─────────────────────────────────────────────────────
        
        // Match this time log to the best shift
        const matchedShift = matchTimeLogToShift(log, dayShifts, logDate);
        const shift = matchedShift?.shift;

        if (!shift) {
          // No matching shift found, treat as no schedule
          daysWithNoSchedule++;
          const netWorkedHours = Math.max(0, rawHours - breakDeductions.totalDeduction);
          totalRegularHours += netWorkedHours;
          continue;
        }

        // Get scheduled times for this shift
        const scheduled = getScheduledHoursFromShift(
          shift,
          logDate,
          department.breakDuration || 60,
          department.paidBreak
        );
        
        totalScheduledHours += scheduled.scheduledHours;

        // Calculate effective time with grace period
        const effectiveTime = calculateEffectiveTime({
          actualTimeIn: log.timeIn,
          actualTimeOut: log.timeOut,
          scheduledStart: scheduled.scheduledStart,
          scheduledEnd: scheduled.scheduledEnd,
          graceMinutes: GRACE_PERIOD_MINUTES,
        });

        // Track tardy
        if (effectiveTime.isTardy) {
          tardyMinutes += effectiveTime.tardyMinutes;
          tardyCount++;
        }

        // Track undertime
        if (effectiveTime.isUndertime) {
          undertimeMinutes += effectiveTime.undertimeMinutes;
          undertimeCount++;
        }

        // Calculate effective worked hours
        const effectiveHours = calculateHoursBetween(
          effectiveTime.effectiveIn,
          effectiveTime.effectiveOut
        );

        // Deduct breaks from effective hours
        const netWorkedHours = Math.max(0, effectiveHours - breakDeductions.totalDeduction);
        totalRegularHours += netWorkedHours;

        // ─────────────────────────────────────────────────────
        // PROCESS OVERTIME
        // ─────────────────────────────────────────────────────
        let logApprovedOTMinutes = 0;

        if (log.overtime && log.overtime.length > 0) {
          log.overtime.forEach(ot => {
            if (ot.status === 'approved' && ot.requestedHours) {
              const otHours = parseFloat(ot.requestedHours);
              totalApprovedOTHours += otHours;
              logApprovedOTMinutes += otHours * 60;
            }
          });
        }

        // Track unapproved extra time (late stay without approved OT)
        if (effectiveTime.extraMinutes > 0) {
          const unapprovedMinutes = Math.max(0, effectiveTime.extraMinutes - logApprovedOTMinutes);
          unapprovedExtraMinutes += unapprovedMinutes;
        }
      }

      // ─────────────────────────────────────────────────────
      // CHECK FOR PENDING OT
      // ─────────────────────────────────────────────────────
      const pendingOTCount = pendingOTByUser[employee.id] || 0;

      if (hasActiveClockIn) employeesWithActiveClockIn++;
      if (pendingOTCount > 0) employeesWithPendingOT++;

      // ─────────────────────────────────────────────────────
      // BUILD EMPLOYEE RESULT
      // ─────────────────────────────────────────────────────
      const employeeResult = {
        userId: employee.id,
        employeeName: employee.profile
          ? `${employee.profile.firstName || ''} ${employee.profile.lastName || ''}`.trim()
          : employee.email,
        department: department.name || 'Unassigned',
        payType: employee.payrollDetails?.payType || 'hourly',
        payRate: employee.payrollDetails?.payRate 
          ? parseFloat(employee.payrollDetails.payRate) 
          : 0,

        // === MAIN HOURS ===
        regularHours: +totalRegularHours.toFixed(2),
        approvedOvertimeHours: +totalApprovedOTHours.toFixed(2),

        // === RAW DATA ===
        totalRawClockedHours: +totalRawClockedHours.toFixed(2),
        totalBreakDeductions: +totalBreakDeductions.toFixed(2),
        totalScheduledHours: +totalScheduledHours.toFixed(2),

        // === ATTENDANCE FLAGS ===
        tardyMinutes,
        tardyCount,
        undertimeMinutes,
        undertimeCount,
        unapprovedExtraMinutes,

        // === DAYS TRACKING ===
        daysWorked: workedDates.size,
        daysWithNoSchedule,

        // === STATUS FLAGS ===
        hasActiveClockIn,
        hasPendingOT: pendingOTCount > 0,
        pendingOTCount,
      };

      results.push(employeeResult);
      grandTotalRegular += totalRegularHours;
      grandTotalOvertime += totalApprovedOTHours;
    }

    // ─────────────────────────────────────────────────────────
    // RETURN RESPONSE
    // ─────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: "Clock hours imported successfully",
      data: {
        periodStart: from,
        periodEnd: to,
        gracePeriodMinutes: GRACE_PERIOD_MINUTES,
        employees: results,
        summary: {
          totalEmployees: results.length,
          totalRegularHours: +grandTotalRegular.toFixed(2),
          totalOvertimeHours: +grandTotalOvertime.toFixed(2),
          employeesWithActiveClockIn,
          employeesWithPendingOT,
        },
      },
    });
  } catch (error) {
    console.error("❌ Error importing clock hours:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};


// ============================================================
// DETAIL CONTROLLER: Single Employee Clock Hours
// GET /api/payroll-system/import-clock-hours/:userId?from=xxx&to=xxx
// ============================================================

const importClockHoursDetail = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { userId } = req.params;
    const { from, to } = req.query;

    // ─────────────────────────────────────────────────────────
    // VALIDATION
    // ─────────────────────────────────────────────────────────
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameter: userId",
      });
    }

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: "Missing required query parameters: 'from' and 'to' dates",
      });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Use YYYY-MM-DD",
      });
    }

    const companyId = req.user.companyId;

    // ─────────────────────────────────────────────────────────
    // FETCH EMPLOYEE
    // ─────────────────────────────────────────────────────────
    const employee = await prisma.user.findFirst({
      where: {
        id: userId,
        companyId,
      },
      select: {
        id: true,
        email: true,
        departmentId: true,
        profile: {
          select: { firstName: true, lastName: true },
        },
        department: {
          select: {
            id: true,
            name: true,
            paidBreak: true,
            breakDuration: true,
            coffeeBreakMaxCount: true,
            coffeeBreakMinutes: true,
            coffeeBreakPaid: true,
          },
        },
        payrollDetails: {
          select: { payType: true, payRate: true },
        },
      },
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    const department = employee.department || {
      paidBreak: false,
      breakDuration: 60,
      coffeeBreakMaxCount: 0,
      coffeeBreakMinutes: 0,
      coffeeBreakPaid: false,
    };

    // ─────────────────────────────────────────────────────────
    // PREPARE DATE RANGE
    // ─────────────────────────────────────────────────────────
    const { dayStart: periodStart } = getDayBounds(fromDate);
    const { dayEnd: periodEnd } = getDayBounds(toDate);

    // Generate array of dates
    const dateRange = [];
    const currentDate = new Date(periodStart);
    while (currentDate <= periodEnd) {
      dateRange.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // ─────────────────────────────────────────────────────────
    // BUILD SCHEDULE LOOKUP (RRULE + UserShift)
    // ─────────────────────────────────────────────────────────
    const scheduleLookup = await buildScheduleLookup([employee], periodStart, periodEnd, companyId);

    // ─────────────────────────────────────────────────────────
    // FETCH TIME LOGS
    // ─────────────────────────────────────────────────────────
    const timeLogs = await prisma.timeLog.findMany({
      where: {
        userId,
        timeIn: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      include: {
        overtime: {
          select: { 
            id: true,
            requestedHours: true, 
            status: true,
            requesterReason: true,
          },
        },
      },
      orderBy: { timeIn: "asc" },
    });

    // Create logs by date lookup
    const logsByDate = {};
    timeLogs.forEach(log => {
      const dateKey = getDateKey(log.timeIn);
      if (!logsByDate[dateKey]) {
        logsByDate[dateKey] = [];
      }
      logsByDate[dateKey].push(log);
    });

    // ─────────────────────────────────────────────────────────
    // PROCESS EACH DAY
    // ─────────────────────────────────────────────────────────
    const dailyBreakdown = [];
    let totalRegularHours = 0;
    let totalApprovedOTHours = 0;
    let totalPendingOTHours = 0;
    let totalRawClockedHours = 0;
    let totalBreakDeductions = 0;
    let totalScheduledHours = 0;
    let daysWorked = 0;
    let daysWithNoSchedule = 0;
    let hasActiveClockIn = false;
    
    // Attendance totals
    let totalTardyMinutes = 0;
    let totalTardyCount = 0;
    let totalUndertimeMinutes = 0;
    let totalUndertimeCount = 0;
    let totalUnapprovedExtraMinutes = 0;

    for (const date of dateRange) {
      const dateKey = getDateKey(date);
      const dayLogs = logsByDate[dateKey] || [];
      const scheduleKey = `${employee.id}_${dateKey}`;
      const dayShifts = scheduleLookup[scheduleKey] || [];

      // Day tracking
      let dayRawHours = 0;
      let dayBreakDeductions = 0;
      let dayRegularHours = 0;
      let dayApprovedOT = 0;
      let dayPendingOT = 0;
      let dayScheduledHours = 0;
      let dayStatus = 'no_log';
      let dayHasNoSchedule = dayShifts.length === 0;
      
      // Attendance for the day
      let dayTardyMinutes = 0;
      let dayUndertimeMinutes = 0;
      let dayUnapprovedExtraMinutes = 0;
      let dayIsTardy = false;
      let dayIsUndertime = false;

      const dayLogDetails = [];

      // Process scheduled shifts for the day
      const shiftsInfo = dayShifts.map(shiftInfo => {
        const scheduled = getScheduledHoursFromShift(
          shiftInfo.shift,
          date,
          department.breakDuration || 60,
          department.paidBreak
        );
        dayScheduledHours += scheduled.scheduledHours;
        return {
          ...scheduled,
          scheduleType: shiftInfo.scheduleType,
        };
      });

      totalScheduledHours += dayScheduledHours;

      // Process each time log for the day
      for (const log of dayLogs) {
        // Check for active clock-in
        if (log.status === true) {
          hasActiveClockIn = true;
          dayStatus = 'active';
          dayLogDetails.push({
            timeLogId: log.id,
            timeIn: log.timeIn,
            timeOut: null,
            status: 'active',
            rawHours: 0,
            effectiveHours: 0,
            noSchedule: dayHasNoSchedule,
          });
          continue;
        }

        if (!log.timeOut) continue;

        dayStatus = 'completed';
        daysWorked++;

        // Calculate raw hours
        const rawHours = calculateHoursBetween(log.timeIn, log.timeOut);
        dayRawHours += rawHours;
        totalRawClockedHours += rawHours;

        // Calculate break deductions
        const breakDeductions = calculateBreakDeductions(log, department);
        dayBreakDeductions += breakDeductions.totalDeduction;
        totalBreakDeductions += breakDeductions.totalDeduction;

        // Match to shift
        const matchedShift = matchTimeLogToShift(log, dayShifts, date);
        const shift = matchedShift?.shift;

        let effectiveHours = 0;
        let logTardyMinutes = 0;
        let logUndertimeMinutes = 0;
        let logExtraMinutes = 0;
        let logIsTardy = false;
        let logIsUndertime = false;

        if (!shift) {
          // No schedule - count all net hours
          dayHasNoSchedule = true;
          effectiveHours = Math.max(0, rawHours - breakDeductions.totalDeduction);
        } else {
          // Has schedule - apply grace period
          const scheduled = getScheduledHoursFromShift(
            shift,
            date,
            department.breakDuration || 60,
            department.paidBreak
          );

          const effectiveTime = calculateEffectiveTime({
            actualTimeIn: log.timeIn,
            actualTimeOut: log.timeOut,
            scheduledStart: scheduled.scheduledStart,
            scheduledEnd: scheduled.scheduledEnd,
            graceMinutes: GRACE_PERIOD_MINUTES,
          });

          effectiveHours = Math.max(
            0, 
            calculateHoursBetween(effectiveTime.effectiveIn, effectiveTime.effectiveOut) - breakDeductions.totalDeduction
          );

          logTardyMinutes = effectiveTime.tardyMinutes;
          logUndertimeMinutes = effectiveTime.undertimeMinutes;
          logExtraMinutes = effectiveTime.extraMinutes;
          logIsTardy = effectiveTime.isTardy;
          logIsUndertime = effectiveTime.isUndertime;

          if (logIsTardy) {
            dayTardyMinutes += logTardyMinutes;
            dayIsTardy = true;
          }
          if (logIsUndertime) {
            dayUndertimeMinutes += logUndertimeMinutes;
            dayIsUndertime = true;
          }
        }

        dayRegularHours += effectiveHours;

        // Process overtime
        let logApprovedOTMinutes = 0;
        const overtimeDetails = [];

        if (log.overtime && log.overtime.length > 0) {
          log.overtime.forEach(ot => {
            const otHours = ot.requestedHours ? parseFloat(ot.requestedHours) : 0;
            overtimeDetails.push({
              id: ot.id,
              hours: otHours,
              status: ot.status,
              reason: ot.requesterReason,
            });

            if (ot.status === 'approved') {
              dayApprovedOT += otHours;
              totalApprovedOTHours += otHours;
              logApprovedOTMinutes += otHours * 60;
            } else if (ot.status === 'pending') {
              dayPendingOT += otHours;
              totalPendingOTHours += otHours;
            }
          });
        }

        // Track unapproved extra time
        if (logExtraMinutes > 0) {
          const unapproved = Math.max(0, logExtraMinutes - logApprovedOTMinutes);
          dayUnapprovedExtraMinutes += unapproved;
        }

        dayLogDetails.push({
          timeLogId: log.id,
          timeIn: log.timeIn,
          timeOut: log.timeOut,
          status: 'completed',
          rawHours: +rawHours.toFixed(2),
          effectiveHours: +effectiveHours.toFixed(2),
          breakDeductions: {
            lunch: breakDeductions.lunchDeduction,
            coffee: breakDeductions.coffeeDeduction,
            total: breakDeductions.totalDeduction,
            details: breakDeductions.details,
          },
          attendance: {
            isTardy: logIsTardy,
            tardyMinutes: logTardyMinutes,
            isUndertime: logIsUndertime,
            undertimeMinutes: logUndertimeMinutes,
            extraMinutes: logExtraMinutes,
          },
          overtime: overtimeDetails,
          noSchedule: !shift,
          matchedShift: shift?.shiftName || null,
        });
      }

      // Update totals
      totalRegularHours += dayRegularHours;
      
      if (dayIsTardy) {
        totalTardyMinutes += dayTardyMinutes;
        totalTardyCount++;
      }
      if (dayIsUndertime) {
        totalUndertimeMinutes += dayUndertimeMinutes;
        totalUndertimeCount++;
      }
      totalUnapprovedExtraMinutes += dayUnapprovedExtraMinutes;

      if (dayHasNoSchedule && dayLogs.length > 0) {
        daysWithNoSchedule++;
      }

      // Add to breakdown if there's activity or a schedule
      if (dayLogs.length > 0 || dayShifts.length > 0) {
        dailyBreakdown.push({
          date: dateKey,
          dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }),
          
          // Schedule info
          scheduledHours: +dayScheduledHours.toFixed(2),
          shifts: shiftsInfo.map(s => ({
            shiftName: s.shiftName,
            scheduledStart: s.scheduledStart,
            scheduledEnd: s.scheduledEnd,
            scheduledHours: s.scheduledHours,
            scheduleType: s.scheduleType,
          })),
          noSchedule: dayHasNoSchedule,

          // Hours
          rawClockedHours: +dayRawHours.toFixed(2),
          breakDeductions: +dayBreakDeductions.toFixed(2),
          regularHours: +dayRegularHours.toFixed(2),

          // Overtime
          approvedOTHours: +dayApprovedOT.toFixed(2),
          pendingOTHours: +dayPendingOT.toFixed(2),

          // Attendance
          attendance: {
            isTardy: dayIsTardy,
            tardyMinutes: dayTardyMinutes,
            isUndertime: dayIsUndertime,
            undertimeMinutes: dayUndertimeMinutes,
            unapprovedExtraMinutes: dayUnapprovedExtraMinutes,
          },

          // Status
          status: dayStatus,
          
          // Log details
          logs: dayLogDetails,
        });
      }
    }

    // ─────────────────────────────────────────────────────────
    // BUILD RESPONSE
    // ─────────────────────────────────────────────────────────
    const employeeName = employee.profile
      ? `${employee.profile.firstName || ''} ${employee.profile.lastName || ''}`.trim()
      : employee.email;

    return res.status(200).json({
      success: true,
      message: "Employee clock hours detail retrieved successfully",
      data: {
        periodStart: from,
        periodEnd: to,
        gracePeriodMinutes: GRACE_PERIOD_MINUTES,
        
        employee: {
          userId: employee.id,
          employeeName,
          email: employee.email,
          department: department.name || 'Unassigned',
          departmentId: employee.departmentId,
          payType: employee.payrollDetails?.payType || 'hourly',
          payRate: employee.payrollDetails?.payRate 
            ? parseFloat(employee.payrollDetails.payRate) 
            : 0,
        },

        departmentPolicy: {
          lunchPaid: department.paidBreak,
          lunchDuration: department.breakDuration || 60,
          coffeeBreakMaxCount: department.coffeeBreakMaxCount || 0,
          coffeeBreakMinutes: department.coffeeBreakMinutes || 0,
          coffeeBreakPaid: department.coffeeBreakPaid || false,
        },

        summary: {
          regularHours: +totalRegularHours.toFixed(2),
          approvedOvertimeHours: +totalApprovedOTHours.toFixed(2),
          pendingOvertimeHours: +totalPendingOTHours.toFixed(2),
          totalRawClockedHours: +totalRawClockedHours.toFixed(2),
          totalBreakDeductions: +totalBreakDeductions.toFixed(2),
          totalScheduledHours: +totalScheduledHours.toFixed(2),
          
          // Attendance summary
          tardyMinutes: totalTardyMinutes,
          tardyCount: totalTardyCount,
          undertimeMinutes: totalUndertimeMinutes,
          undertimeCount: totalUndertimeCount,
          unapprovedExtraMinutes: totalUnapprovedExtraMinutes,
          
          // Days
          daysWorked,
          daysWithNoSchedule,
          hasActiveClockIn,
        },

        dailyBreakdown,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching employee clock hours detail:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};


module.exports = {
  importClockHours,
  importClockHoursDetail,
};