// src/controllers/Features/adminAnalyticsController.js

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const A = require("@services/Analytics/attendanceAnalyticsService"); // BB-133
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

// GET /api/analytics/admin-dashboard
// BB-133: rebuilt on services/Analytics/attendanceAnalyticsService.js (company
// time zone, range clamped to today, grace, overnight shifts, per-day late /
// early / absent, leave + holidays, approved OT). Old field names are kept
// with corrected values; new fields added (docs/client-update-BB-133.md).
// Scope: admin / superadmin = whole company; supervisor = their department +
// direct reports (same scope as the Employee Report page).
exports.getAdminAnalyticsDashboard = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(403).json({ message: "Unauthorized: No company context" });
    }

    const company = await A.loadCompanyRules(companyId);
    let range;
    try {
      range = A.resolveRange(req.query, company?.timeZone, { maxCustomDays: 180 });
    } catch (e) {
      if (e instanceof A.AnalyticsRangeError) return res.status(400).json({ message: e.message });
      throw e;
    }
    const byMonth = range.days.length > 31;
    const bucket = (ymd) => (byMonth ? ymd.slice(0, 7) : ymd);
    const bucketLabel = (key) => (byMonth ? key : key.slice(5)); // "11-03" or "2026-11"

    // ── Scope ──
    let scopeWhere = { companyId };
    if (req.user.role === "supervisor") {
      const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { departmentId: true } }); // req.user has no departmentId
      scopeWhere = {
        companyId,
        OR: [{ employmentDetail: { supervisorId: req.user.id } }, ...(me?.departmentId ? [{ departmentId: me.departmentId }] : [])],
      };
    }

    const [people, subscription] = await Promise.all([
      prisma.user.findMany({
        where: { ...HUMAN_ONLY, ...scopeWhere },
        select: { id: true, status: true, departmentId: true, department: { select: { name: true } } },
      }),
      prisma.subscription.findFirst({
        where: { companyId, active: true },
        include: { plan: { select: { name: true } } },
      }),
    ]);
    const userIds = people.map((p) => p.id);
    const deptOf = new Map(people.map((p) => [p.id, p.department?.name || "Unassigned"]));
    const activeEmployees = people.filter((p) => p.status === "active");

    const [attendance, leaves, leaveDayRows] = await Promise.all([
      A.buildAttendance({ company, userIds, range }),
      // Leave requests that overlap the range (any status), for the approval rate.
      prisma.leave.findMany({
        where: { userId: { in: userIds }, startDate: { lte: range.endUtc }, endDate: { gte: range.startUtc } },
        select: { id: true, status: true },
      }),
      // Approved leave days in the range (not reverted), for days by type.
      range.empty
        ? []
        : prisma.leaveDay.findMany({
            where: {
              date: { gte: new Date(`${range.from}T00:00:00.000Z`), lte: new Date(`${range.to}T23:59:59.999Z`) },
              revertedAt: null,
              leave: { userId: { in: userIds }, status: "approved" },
            },
            select: { date: true, leaveId: true, leave: { select: { leaveType: true } } },
          }),
    ]);

    // ── Walk every person-day once ──
    const activeByBucket = {};
    const hoursByDay = {};
    const attendanceDaily = {};
    const otByDept = {};
    const otByBucket = {};
    const deptHours = {};
    const deptActive = {};
    let scheduledShifts = 0, lateCount = 0, earlyCount = 0, onTimeCount = 0, absences = 0, covered = 0;
    let totalHours = 0, approvedOt = 0, beyond = 0;

    for (const [uid, days] of attendance) {
      const dept = deptOf.get(uid);
      for (const d of days.values()) {
        const b = bucket(d.date);
        (hoursByDay[d.date] ??= { scheduled: 0, actual: 0 });
        hoursByDay[d.date].scheduled += d.scheduledHours;
        hoursByDay[d.date].actual += d.hours;
        totalHours += d.hours;
        approvedOt += d.approvedOvertime;
        beyond += d.beyondSchedule;

        if (d.worked) {
          (activeByBucket[b] ??= new Set()).add(uid);
          (deptActive[dept] ??= new Set()).add(uid);
          deptHours[dept] = (deptHours[dept] || 0) + d.hours;
        }
        if (d.approvedOvertime || d.beyondSchedule) {
          (otByDept[dept] ??= { approved: 0, beyond: 0 });
          otByDept[dept].approved += d.approvedOvertime;
          otByDept[dept].beyond += d.beyondSchedule;
          (otByBucket[b] ??= { approved: 0, beyond: 0 });
          otByBucket[b].approved += d.approvedOvertime;
          otByBucket[b].beyond += d.beyondSchedule;
        }

        // Attendance: scheduled days that are already decided (not "today, shift not over").
        // Leave / holiday days without a punch are neither absent nor attended.
        if (!d.scheduled || d.status === "scheduled" || (!d.worked && (d.onLeave || d.holiday))) continue;
        scheduledShifts++;
        const row = (attendanceDaily[d.date] ??= { onTime: 0, late: 0, earlyOut: 0, absent: 0 });
        if (d.absent) { absences++; row.absent++; continue; }
        if (!d.worked) continue;
        covered++;
        if (d.late) { lateCount++; row.late++; }
        if (d.earlyOut) earlyCount++;
        if (d.late) continue;
        if (d.earlyOut) row.earlyOut++;
        else { onTimeCount++; row.onTime++; }
      }
    }

    const pct = (n, of) => (of ? Number(((n / of) * 100).toFixed(1)) : 0);
    const lateRate = pct(lateCount, scheduledShifts);
    const earlyRate = pct(earlyCount, scheduledShifts);
    const reliabilityRate = pct(onTimeCount, scheduledShifts);
    const coverageRate = pct(covered, scheduledShifts);

    const activeStaffData = Object.entries(activeByBucket)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, ids]) => ({ period, count: ids.size, label: bucketLabel(period) }));

    const hoursComparisonData = Object.entries(hoursByDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, scheduled: A.round2(v.scheduled), actual: A.round2(v.actual) }));

    const attendanceDailyData = Object.entries(attendanceDaily)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));

    // Leave
    const approvedLeaves = leaves.filter((l) => l.status === "approved");
    const leaveApprovalRate = pct(approvedLeaves.length, leaves.length);
    const leaveDistribution = [
      { name: "Approved", value: approvedLeaves.length },
      { name: "Pending/Rejected", value: leaves.length - approvedLeaves.length },
    ];
    // leaveType holds the LeavePolicy id — resolve to names (same as leaveController._attachPolicyNames).
    const policyIds = [...new Set(leaveDayRows.map((r) => r.leave.leaveType).filter(Boolean))];
    const policies = policyIds.length
      ? await prisma.leavePolicy.findMany({ where: { id: { in: policyIds } }, select: { id: true, leaveType: true } })
      : [];
    const policyName = new Map(policies.map((p) => [p.id, p.leaveType]));
    const leaveDaysByType = {};
    const seenLeaveDay = new Set(); // a split paid/unpaid day is two rows — count it once
    for (const r of leaveDayRows) {
      const k = `${r.leaveId}|${r.date.toISOString().slice(0, 10)}`;
      if (seenLeaveDay.has(k)) continue;
      seenLeaveDay.add(k);
      const type = policyName.get(r.leave.leaveType) || r.leave.leaveType || "Leave";
      leaveDaysByType[type] = (leaveDaysByType[type] || 0) + 1;
    }
    const leaveByTypeData = Object.entries(leaveDaysByType).map(([type, days]) => ({ type, days }));

    // Overtime (old `hours` = hours beyond schedule, as before; approved OT added)
    const overtimeByDeptData = Object.entries(otByDept)
      .map(([dept, v]) => ({
        dept,
        hours: A.round2(v.beyond),
        approvedHours: A.round2(v.approved),
        beyondScheduleHours: A.round2(v.beyond),
      }))
      .sort((a, b) => b.approvedHours - a.approvedHours || b.beyondScheduleHours - a.beyondScheduleHours);
    const overtimeTrendData = Object.entries(otByBucket)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({
        period,
        hours: A.round2(v.beyond),
        approvedHours: A.round2(v.approved),
        beyondScheduleHours: A.round2(v.beyond),
      }));

    // Departments
    const deptEmployees = {};
    activeEmployees.forEach((e) => {
      const name = e.department?.name || "Unassigned";
      deptEmployees[name] = (deptEmployees[name] || 0) + 1;
    });
    const departmentBreakdown = Object.entries(deptEmployees).map(([department, employees]) => {
      const hours = deptHours[department] || 0;
      return {
        department,
        employees,
        activeEmployees: deptActive[department]?.size || 0,
        totalHours: A.round2(hours),
        avgHoursPerEmployee: employees ? A.round2(hours / employees) : 0,
      };
    });
    const departments = req.user.role === "supervisor"
      ? new Set(people.map((p) => p.departmentId).filter(Boolean)).size
      : await prisma.department.count({ where: { companyId } });

    return res.status(200).json({
      data: {
        timeZone: range.timeZone,
        scope: req.user.role === "supervisor" ? "team" : "company",
        summary: {
          departments,
          totalEmployees: activeEmployees.length,
          activePlan: subscription?.plan?.name || "Free",
          activeStaff: activeStaffData.at(-1)?.count || 0,
          lateRate,
          earlyLeaveRate: earlyRate,
          reliabilityRate,
          coverageRate,
          leaveApprovalRate,
          totalHoursWorked: A.round2(totalHours),
          totalOvertimeHours: A.round2(beyond), // old name: hours beyond schedule
          approvedOvertimeHours: A.round2(approvedOt),
          hoursBeyondSchedule: A.round2(beyond),
          absences,
          scheduledShifts,
        },
        charts: {
          activeStaff: activeStaffData,
          hoursComparison: hoursComparisonData,
          attendanceMetrics: { lateRate, earlyRate, reliabilityRate },
          attendanceDaily: attendanceDailyData,
          leaveDistribution,
          leaveByType: leaveByTypeData,
          overtimeByDepartment: overtimeByDeptData,
          overtimeTrend: overtimeTrendData,
          departmentBreakdown,
        },
        dateRange: A.dateRangeOf(range),
      },
    });
  } catch (e) {
    console.error("getAdminAnalyticsDashboard", e);
    res.status(500).json({ message: "Internal server error" });
  }
};
