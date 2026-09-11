// src/controllers/Features/adminAnalyticsController.js

const { prisma } = require("@config/connection");
const { differenceInHours, parseISO, startOfDay, endOfDay, addDays } = require("date-fns");

function shiftDurationHours(shift) {
  const s = shift.startTime;
  const e = shift.endTime;
  const diff = (e.getTime() - s.getTime()) / 36e5 + (shift.crossesMidnight ? 24 : 0);
  return diff < 0 ? diff + 24 : diff;
}

function logDurationHours(log) {
  if (!log.timeOut) return 0;
  let hrs = (log.timeOut.getTime() - log.timeIn.getTime()) / 36e5;
  if (Array.isArray(log.coffeeBreaks)) {
    log.coffeeBreaks.forEach((b) => {
      if (b.start && b.end) hrs -= (new Date(b.end) - new Date(b.start)) / 36e5;
    });
  }
  if (log.lunchBreak && log.lunchBreak.start && log.lunchBreak.end) {
    hrs -= (new Date(log.lunchBreak.end) - new Date(log.lunchBreak.start)) / 36e5;
  }
  return hrs > 0 ? hrs : 0;
}

exports.getAdminAnalytics = async (req, res) => {
  try {
    const { companyId } = req.user;
    const from = req.query.from ? parseISO(req.query.from) : addDays(startOfDay(new Date()), -30);
    const to = req.query.to ? endOfDay(parseISO(req.query.to)) : endOfDay(new Date());
    const [timelogs, userShifts, leaves, paySettings] = await Promise.all([
      prisma.timeLog.findMany({
        where: {
          user: { companyId },
          timeIn: { gte: from, lte: to },
        },
        include: { user: { select: { departmentId: true } } },
      }),
      prisma.userShift.findMany({
        where: {
          user: { companyId },
          assignedDate: { gte: from, lte: to },
        },
        include: { shift: true, user: { select: { departmentId: true } } },
      }),
      prisma.leave.findMany({
        where: {
          user: { companyId },
          startDate: { lte: to },
          endDate: { gte: from },
        },
      }),
      prisma.payrollSettings.findUnique({ where: { companyId } }),
    ]);

    const activeTimeline = {};
    const activeUsersSet = new Set();
    timelogs.forEach((l) => {
      const key = l.timeIn.toISOString().slice(0, 7);
      activeTimeline[key] = (activeTimeline[key] || new Set()).add(l.userId);
      activeUsersSet.add(l.userId);
    });
    const activeTimelineArr = Object.entries(activeTimeline).map(([month, set]) => ({ month, count: set.size }));
    let totalScheduled = 0;
    userShifts.forEach((us) => {
      totalScheduled += shiftDurationHours(us.shift);
    });

    let totalActual = 0;
    timelogs.forEach((l) => {
      totalActual += logDurationHours(l);
    });

    let lateCnt = 0,
      earlyCnt = 0;
    userShifts.forEach((us) => {
      const logsForUserDate = timelogs.filter(
        (tl) => tl.userId === us.userId && tl.timeIn.toISOString().slice(0, 10) === us.assignedDate.toISOString().slice(0, 10)
      );
      if (!logsForUserDate.length) return;
      const firstIn = logsForUserDate.reduce((min, tl) => (tl.timeIn < min ? tl.timeIn : min), logsForUserDate[0].timeIn);
      const lastOut = logsForUserDate.reduce(
        (max, tl) => (tl.timeOut && tl.timeOut > max ? tl.timeOut : max),
        logsForUserDate[0].timeOut || logsForUserDate[0].timeIn
      );

      const schedStart = new Date(us.assignedDate);
      schedStart.setHours(us.shift.startTime.getHours(), us.shift.startTime.getMinutes());
      const schedEnd = new Date(us.assignedDate);
      schedEnd.setHours(us.shift.endTime.getHours(), us.shift.endTime.getMinutes());
      if (us.shift.crossesMidnight) schedEnd.setDate(schedEnd.getDate() + 1);

      if (firstIn > schedStart) lateCnt++;
      if (lastOut && lastOut < schedEnd) earlyCnt++;
    });
    const totalShifts = userShifts.length;
    const latePct = totalShifts ? ((lateCnt / totalShifts) * 100).toFixed(1) : 0;
    const earlyPct = totalShifts ? ((earlyCnt / totalShifts) * 100).toFixed(1) : 0;

    let onTimeShifts = totalShifts - lateCnt - earlyCnt;
    const attendanceReliability = totalShifts ? ((onTimeShifts / totalShifts) * 100).toFixed(1) : 0;

    const leaveUsage = {};
    let approved = 0,
      pending = 0,
      rejected = 0;
    leaves.forEach((lv) => {
      const days = differenceInHours(lv.endDate > to ? to : lv.endDate, lv.startDate < from ? from : lv.startDate) / 24;
      if (lv.status === "approved") {
        approved++;
        leaveUsage[lv.leaveType] = (leaveUsage[lv.leaveType] || 0) + days;
      } else if (lv.status === "pending") pending++;
      else if (lv.status === "rejected") rejected++;
    });

    const shiftHoursMap = {};
    userShifts.forEach((us) => {
      const key = us.userId + "-" + us.assignedDate.toISOString().slice(0, 10);
      shiftHoursMap[key] = (shiftHoursMap[key] || 0) + shiftDurationHours(us.shift);
    });

    let totalOvertime = 0;
    const overtimeByDept = {};
    timelogs.forEach((l) => {
      const dateKey = l.timeIn.toISOString().slice(0, 10);
      const key = l.userId + "-" + dateKey;
      const sched = shiftHoursMap[key] || 0;
      const actual = logDurationHours(l);
      if (actual > sched) {
        const ot = actual - sched;
        totalOvertime += ot;
        const dept = l.user.departmentId || "none";
        overtimeByDept[dept] = (overtimeByDept[dept] || 0) + ot;
      }
    });

    const otRate = paySettings ? paySettings.overtimeRate : 1.5;
    const overtimeCost = Number((totalOvertime * otRate).toFixed(2));

    let covered = 0;
    userShifts.forEach((us) => {
      const hasPunch = timelogs.some(
        (tl) => tl.userId === us.userId && tl.timeIn.toISOString().slice(0, 10) === us.assignedDate.toISOString().slice(0, 10)
      );
      if (hasPunch) covered++;
    });
    const coverageRate = totalShifts ? ((covered / totalShifts) * 100).toFixed(1) : 0;

    return res.status(200).json({
      message: "Analytics ready",
      data: {
        period: { from, to },
        activeStaff: {
          totalUnique: activeUsersSet.size,
          timeline: activeTimelineArr,
        },
        scheduledVsActual: {
          scheduledHours: Number(totalScheduled.toFixed(2)),
          actualHours: Number(totalActual.toFixed(2)),
          variance: Number((totalActual - totalScheduled).toFixed(2)),
        },
        lateEarlyRate: {
          lateCnt,
          earlyCnt,
          latePct,
          earlyPct,
        },
        attendanceReliability,
        leaveUsageByType: leaveUsage,
        leaveRequestsVsApprovals: { approved, pending, rejected },
        overtime: {
          totalHours: Number(totalOvertime.toFixed(2)),
          overtimeCostImpact: overtimeCost,
          byDepartment: overtimeByDept,
        },
        shiftCoverageRate: coverageRate,
      },
    });
  } catch (err) {
    console.error("getAdminAnalytics error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

exports.getAdminAnalyticsDashboard = async (req, res) => {
  try {
    const { period = 'this_month', startDate, endDate } = req.query;
    const companyId = req.user.companyId;

    if (!companyId) {
      return res.status(403).json({ message: "Unauthorized: No company context" });
    }

    // Get company with timezone
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { timeZone: true },
    });

    const timezone = company?.timeZone || 'America/Los_Angeles';

    // Calculate date range based on period
    let rangeStart, rangeEnd, rangeLabel;
    const now = new Date();

    switch (period) {
      case 'last_7_days':
        rangeEnd = new Date(now);
        rangeStart = new Date(now);
        rangeStart.setDate(rangeStart.getDate() - 6);
        rangeLabel = 'Last 7 days';
        break;

      case 'last_14_days':
        rangeEnd = new Date(now);
        rangeStart = new Date(now);
        rangeStart.setDate(rangeStart.getDate() - 13);
        rangeLabel = 'Last 14 days';
        break;

      case 'last_28_days':
        rangeEnd = new Date(now);
        rangeStart = new Date(now);
        rangeStart.setDate(rangeStart.getDate() - 27);
        rangeLabel = 'Last 28 days';
        break;

      case 'last_month':
        rangeEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        rangeLabel = rangeStart.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        break;

      case 'this_month':
      default:
        rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
        rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        rangeLabel = rangeStart.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        break;

      case 'custom':
        if (!startDate || !endDate) {
          return res.status(400).json({ message: "startDate and endDate required for custom period" });
        }
        rangeStart = new Date(startDate);
        rangeEnd = new Date(endDate);
        
        if (rangeStart > rangeEnd) {
          return res.status(400).json({ message: "startDate must be before endDate" });
        }
        
        // Note: daysDiff validation happens after this switch statement
        rangeLabel = `${rangeStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${rangeEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        break;
    }

    rangeStart.setHours(0, 0, 0, 0);
    rangeEnd.setHours(23, 59, 59, 999);

    // Calculate daysDiff for all periods (needed for chart formatting)
    const daysDiff = Math.ceil((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24));

    // Validate custom range limit (180 days max)
    if (period === 'custom' && daysDiff > 180) {
      return res.status(400).json({ message: "Date range cannot exceed 180 days" });
    }

    // Parallel data fetching with date filters
    const [departments, employees, timelogs, userShifts, leaves, subscription] = await Promise.all([
      // Departments count
      prisma.department.count({ where: { companyId } }),

      // Active employees with department info
      prisma.user.findMany({
        where: { 
          companyId,
          status: 'active',
        },
        select: {
          id: true,
          username: true,
          departmentId: true,
          department: { select: { name: true } },
        },
      }),

      // Timelogs within date range
      prisma.timeLog.findMany({
        where: {
          user: { companyId },
          timeIn: { gte: rangeStart, lte: rangeEnd },
        },
        select: {
          id: true,
          userId: true,
          timeIn: true,
          timeOut: true,
        },
        orderBy: { timeIn: 'asc' },
      }),

      // User shifts within date range
      prisma.userShift.findMany({
        where: {
          user: { companyId },
          assignedDate: { gte: rangeStart, lte: rangeEnd },
        },
        include: {
          shift: { select: { startTime: true, endTime: true } },
        },
      }),

      // Leaves within date range
      prisma.leave.findMany({
        where: {
          User: { companyId },
          OR: [
            { startDate: { gte: rangeStart, lte: rangeEnd } },
            { endDate: { gte: rangeStart, lte: rangeEnd } },
          ],
        },
        select: {
          id: true,
          userId: true,
          leaveType: true,
          status: true,
          startDate: true,
          endDate: true,
        },
      }),

      // Active subscription
      prisma.subscription.findFirst({
        where: { companyId, active: true },
        include: { plan: { select: { name: true } } },
      }),
    ]);

    // Helper functions
    const diffHours = (isoA, isoB) => (isoA && isoB ? (new Date(isoB) - new Date(isoA)) / 36e5 : 0);
    const monthKey = (iso) => new Date(iso).toISOString().slice(0, 7);
    const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);

    // === KPI CALCULATIONS ===

    // 1. Active staff per month/day (based on period length)
    const activeByPeriod = {};
    timelogs.forEach((l) => {
      const key = daysDiff <= 31 ? dayKey(l.timeIn) : monthKey(l.timeIn);
      (activeByPeriod[key] ??= new Set()).add(l.userId);
    });
    const activeStaffData = Object.entries(activeByPeriod)
      .sort()
      .map(([period, ids]) => ({ 
        period, 
        count: ids.size,
        label: daysDiff <= 31 ? period.slice(5) : period // Format: "12-25" or "2024-12"
      }));

    // 2. Hours: Scheduled vs Actual
    const schedHoursByUser = {};
    const actualHoursByUser = {};

    userShifts.forEach((us) => {
      const key = `${us.userId}_${dayKey(us.assignedDate)}`;
      const hours = diffHours(us.shift.startTime, us.shift.endTime);
      schedHoursByUser[key] = (schedHoursByUser[key] || 0) + hours;
    });

    timelogs.forEach((l) => {
      if (!l.timeOut) return;
      const key = `${l.userId}_${dayKey(l.timeIn)}`;
      const hours = diffHours(l.timeIn, l.timeOut);
      actualHoursByUser[key] = (actualHoursByUser[key] || 0) + hours;
    });

    const allDays = new Set([
      ...Object.keys(schedHoursByUser).map(k => k.split('_')[1]),
      ...Object.keys(actualHoursByUser).map(k => k.split('_')[1]),
    ]);

    const hoursComparisonData = [...allDays].sort().map((day) => {
      const scheduled = Object.entries(schedHoursByUser)
        .filter(([k]) => k.endsWith(`_${day}`))
        .reduce((sum, [, v]) => sum + v, 0);
      const actual = Object.entries(actualHoursByUser)
        .filter(([k]) => k.endsWith(`_${day}`))
        .reduce((sum, [, v]) => sum + v, 0);
      
      return {
        date: day,
        scheduled: Number(scheduled.toFixed(2)),
        actual: Number(actual.toFixed(2)),
      };
    });

    // 3. Attendance Metrics
    let lateCount = 0;
    let earlyLeaveCount = 0;
    const shiftLookup = {};
    
    userShifts.forEach((us) => {
      shiftLookup[`${us.userId}_${dayKey(us.assignedDate)}`] = {
        start: us.shift.startTime,
        end: us.shift.endTime,
      };
    });

    timelogs.forEach((log) => {
      const key = `${log.userId}_${dayKey(log.timeIn)}`;
      const shift = shiftLookup[key];
      if (!shift) return;

      const clockInTime = new Date(log.timeIn);
      const shiftStart = new Date(shift.start);
      shiftStart.setFullYear(clockInTime.getFullYear(), clockInTime.getMonth(), clockInTime.getDate());

      if (clockInTime > shiftStart) lateCount++;

      if (log.timeOut) {
        const clockOutTime = new Date(log.timeOut);
        const shiftEnd = new Date(shift.end);
        shiftEnd.setFullYear(clockOutTime.getFullYear(), clockOutTime.getMonth(), clockOutTime.getDate());
        
        if (clockOutTime < shiftEnd) earlyLeaveCount++;
      }
    });

    const totalScheduledShifts = userShifts.length || 1;
    const lateRate = ((lateCount / totalScheduledShifts) * 100).toFixed(1);
    const earlyRate = ((earlyLeaveCount / totalScheduledShifts) * 100).toFixed(1);
    const onTimeCount = Math.max(0, totalScheduledShifts - lateCount - earlyLeaveCount);
    const reliabilityRate = ((onTimeCount / totalScheduledShifts) * 100).toFixed(1);

    // 4. Coverage Rate
    const coveredShifts = userShifts.filter((us) =>
      timelogs.some((l) => l.userId === us.userId && dayKey(l.timeIn) === dayKey(us.assignedDate))
    ).length;
    const coverageRate = ((coveredShifts / totalScheduledShifts) * 100).toFixed(1);

    // 5. Leave Analytics
    // leaveType is a legacy field that actually holds the LeavePolicy id, not
    // a display name — resolve to names the same way leaveController.js's
    // _attachPolicyNames() does, so the chart doesn't show raw ids.
    const leaveTypeIds = [...new Set(leaves.map((l) => l.leaveType).filter(Boolean))];
    const leavePolicies = await prisma.leavePolicy.findMany({
      where: { id: { in: leaveTypeIds } },
      select: { id: true, leaveType: true },
    });
    const leaveTypeNameById = Object.fromEntries(leavePolicies.map((p) => [p.id, p.leaveType]));

    const leaveByType = {};
    const approvedLeaves = leaves.filter(l => l.status === 'approved');

    approvedLeaves.forEach((lv) => {
      const days = Math.max(1, diffHours(lv.startDate, lv.endDate) / 8);
      const typeName = leaveTypeNameById[lv.leaveType] || lv.leaveType;
      leaveByType[typeName] = (leaveByType[typeName] || 0) + days;
    });

    const totalLeaveRequests = leaves.length || 1;
    const leaveApprovalRate = ((approvedLeaves.length / totalLeaveRequests) * 100).toFixed(1);

    const leaveDistribution = [
      { name: 'Approved', value: approvedLeaves.length },
      { name: 'Pending/Rejected', value: totalLeaveRequests - approvedLeaves.length },
    ];

    const leaveByTypeData = Object.entries(leaveByType).map(([type, days]) => ({
      type,
      days: Number(days.toFixed(1)),
    }));

    // 6. Overtime Analysis
    const overtimeByDept = {};
    const overtimeOverTime = {};

    Object.keys(schedHoursByUser).forEach((key) => {
      const [userId, date] = key.split('_');
      const scheduled = schedHoursByUser[key] || 0;
      const actual = actualHoursByUser[key] || 0;
      const overtime = Math.max(0, actual - scheduled);
      
      if (overtime === 0) return;

      const employee = employees.find(e => e.id === userId);
      const deptName = employee?.department?.name || 'Unassigned';
      
      overtimeByDept[deptName] = (overtimeByDept[deptName] || 0) + overtime;
      
      const periodKey = daysDiff <= 31 ? date : monthKey(date);
      overtimeOverTime[periodKey] = (overtimeOverTime[periodKey] || 0) + overtime;
    });

    const overtimeByDeptData = Object.entries(overtimeByDept)
      .map(([dept, hours]) => ({ dept, hours: Number(hours.toFixed(2)) }))
      .sort((a, b) => b.hours - a.hours);

    const overtimeTrendData = Object.entries(overtimeOverTime)
      .sort()
      .map(([period, hours]) => ({
        period,
        hours: Number(hours.toFixed(2)),
        cost: Number((hours * 1.5 * 15).toFixed(2)), // Assuming $15/hr base rate
      }));

    // 7. Department Breakdown
    const deptStats = {};
    employees.forEach(emp => {
      const deptName = emp.department?.name || 'Unassigned';
      if (!deptStats[deptName]) {
        deptStats[deptName] = { employees: 0, activeCount: 0, totalHours: 0 };
      }
      deptStats[deptName].employees++;
    });

    timelogs.forEach(log => {
      const emp = employees.find(e => e.id === log.userId);
      const deptName = emp?.department?.name || 'Unassigned';
      if (deptStats[deptName]) {
        deptStats[deptName].activeCount++;
        if (log.timeOut) {
          deptStats[deptName].totalHours += diffHours(log.timeIn, log.timeOut);
        }
      }
    });

    const departmentBreakdown = Object.entries(deptStats).map(([name, stats]) => ({
      department: name,
      employees: stats.employees,
      activeEmployees: new Set(
        timelogs
          .filter(l => employees.find(e => e.id === l.userId)?.department?.name === name)
          .map(l => l.userId)
      ).size,
      totalHours: Number(stats.totalHours.toFixed(2)),
      avgHoursPerEmployee: Number((stats.totalHours / stats.employees).toFixed(2)),
    }));

    // === RESPONSE ===
    return res.status(200).json({
      data: {
        summary: {
          departments: departments,
          totalEmployees: employees.length,
          activePlan: subscription?.plan?.name || 'Free',
          activeStaff: activeStaffData.at(-1)?.count || 0,
          lateRate: parseFloat(lateRate),
          earlyLeaveRate: parseFloat(earlyRate),
          reliabilityRate: parseFloat(reliabilityRate),
          coverageRate: parseFloat(coverageRate),
          leaveApprovalRate: parseFloat(leaveApprovalRate),
          totalHoursWorked: hoursComparisonData.reduce((sum, d) => sum + d.actual, 0),
          totalOvertimeHours: overtimeTrendData.reduce((sum, d) => sum + d.hours, 0),
        },
        charts: {
          activeStaff: activeStaffData,
          hoursComparison: hoursComparisonData,
          attendanceMetrics: {
            lateRate: parseFloat(lateRate),
            earlyRate: parseFloat(earlyRate),
            reliabilityRate: parseFloat(reliabilityRate),
          },
          leaveDistribution,
          leaveByType: leaveByTypeData,
          overtimeByDepartment: overtimeByDeptData,
          overtimeTrend: overtimeTrendData,
          departmentBreakdown,
        },
        dateRange: {
          start: rangeStart.toISOString().split('T')[0],
          end: rangeEnd.toISOString().split('T')[0],
          label: rangeLabel,
          period: period,
        },
      },
    });
  } catch (e) {
    console.error("getAdminAnalytics", e);
    res.status(500).json({ message: "Internal server error" });
  }
};