// src/controllers/Features/employeeAnalyticsController.js
//
// GET /api/analytics/employee — the signed-in user's own Overview.
// BB-133: rebuilt on services/Analytics/attendanceAnalyticsService.js (company
// time zone, range clamped to today, grace, overnight shifts, leave/holidays,
// approved OT). New fields per the BB-133 contract; old field names are kept
// with corrected values until the client switches (see
// docs/client-update-BB-133.md).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const A = require("@services/Analytics/attendanceAnalyticsService");

const median = (nums) => {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const fromMinutes = (min) => {
  if (min == null) return null;
  const r = Math.round(min);
  return `${String(Math.floor(r / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}`;
};
const label12 = (hhmm) => (hhmm ? moment(hhmm, "HH:mm").format("h:mm A") : null);

const getEmployeeAnalytics = async (req, res) => {
  try {
    const uid = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: uid },
      include: { profile: true, department: true },
    });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.companyId) return res.status(403).json({ message: "Unauthorized: No company context" });

    const company = await A.loadCompanyRules(user.companyId);
    let range;
    try {
      range = A.resolveRange(req.query, company?.timeZone, { maxCustomDays: 180 });
    } catch (e) {
      if (e instanceof A.AnalyticsRangeError) return res.status(400).json({ message: e.message });
      throw e;
    }

    const [attendance, activeSessions] = await Promise.all([
      A.buildAttendance({ company, userIds: [uid], range }),
      prisma.timeLog.count({ where: { userId: uid, status: true } }),
    ]);
    const days = [...attendance.get(uid).values()];

    const sum = (fn) => A.round2(days.reduce((n, d) => n + fn(d), 0));
    const worked = days.filter((d) => d.worked);
    const hoursWorked = sum((d) => d.hours);
    const approvedOvertime = sum((d) => d.approvedOvertime);
    const hoursBeyondSchedule = sum((d) => d.beyondSchedule);
    const totals = {
      hoursWorked,
      daysWorked: worked.length,
      scheduledDays: days.filter((d) => d.scheduled && d.status !== "scheduled").length,
      absences: days.filter((d) => d.absent).length,
      lateIns: days.filter((d) => d.late).length,
      earlyOuts: days.filter((d) => d.earlyOut).length,
      approvedOvertime,
      overtimeDays: days.filter((d) => d.approvedOvertime > 0).length,
      hoursBeyondSchedule,
      leaveDays: days.filter((d) => d.onLeave).length,
      // Old names (kept until the client switches; values now follow BB-133 rules)
      totalHours: hoursWorked,
      overtime: hoursBeyondSchedule,
      activeSessions,
    };

    const usualClockIn = fromMinutes(median(worked.filter((d) => d.firstIn).map((d) => toMinutes(d.firstIn))));
    const usualClockOut = fromMinutes(median(worked.filter((d) => d.lastOut).map((d) => toMinutes(d.lastOut))));

    const perDay = (n) => (worked.length ? A.round2(n / worked.length) : 0);
    const averages = {
      hoursPerDayWorked: perDay(hoursWorked),
      overtimePerDayWorked: perDay(approvedOvertime),
      // Old names: per day worked (the ×7 / ×30 projections are gone)
      hoursPerDay: perDay(hoursWorked),
      overtimePerDay: perDay(approvedOvertime),
    };

    const daily = days.map((d) => ({
      date: d.date,
      hours: d.hours,
      overtime: d.approvedOvertime,
      beyondSchedule: d.beyondSchedule,
      scheduledHours: d.scheduledHours,
      status: d.status,
      lateIn: d.late,
      earlyOut: d.earlyOut,
      firstIn: d.firstIn,
      lastOut: d.lastOut,
    }));

    return res.status(200).json({
      data: {
        timeZone: range.timeZone,
        profile: {
          username: user.username,
          firstName: user.profile?.firstName || "",
          lastName: user.profile?.lastName || "",
          email: user.email,
          department: user.department?.name || "—",
        },
        totals,
        patterns: {
          usualClockIn, // "HH:mm", company zone
          usualClockOut,
          usualClockInLabel: label12(usualClockIn), // "h:mm A" (the old format)
          usualClockOutLabel: label12(usualClockOut),
        },
        averages,
        series: { daily },
        // Old name: days with a punch only
        charts: { dailyHours: worked.map((d) => ({ date: d.date, hours: d.hours })) },
        dateRange: A.dateRangeOf(range),
      },
    });
  } catch (e) {
    console.error("getEmployeeAnalytics", e);
    res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = { getEmployeeAnalytics };
