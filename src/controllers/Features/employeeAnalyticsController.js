// src/controllers/Features/employeeAnalyticsController.js

const { prisma } = require("@config/connection");

const toDate = (v) => (v instanceof Date ? v : new Date(v));
const addMin = (d, m) => new Date(d.getTime() + m * 60000);
const diffH = (a, b) => (a && b ? (toDate(b) - toDate(a)) / 36e5 : 0);
const day = (v) => toDate(v).toISOString().slice(0, 10);

// Minute-of-day for a punch, kept in the same UTC-based frame `day()` above
// already buckets calendar days in (this endpoint doesn't use company
// timezone anywhere yet) so the new "usual" times stay internally consistent
// with the existing daily bucketing rather than mixing frames.
const minutesOfDay = (v) => {
  const d = toDate(v);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

const median = (nums) => {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const formatTimeOfDay = (minutes) => {
  if (minutes == null) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
};

const getEmployeeAnalytics = async (req, res) => {
  try {
    const uid = req.user.id;
    const { period = 'this_month', startDate, endDate } = req.query;

    // Get user with company for timezone
    const user = await prisma.user.findUnique({
      where: { id: uid },
      include: { 
        profile: true, 
        department: true,
        company: { select: { timeZone: true } }
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const timezone = user.company?.timeZone || 'America/Los_Angeles';

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
        rangeEnd = new Date(now.getFullYear(), now.getMonth(), 0); // Last day of previous month
        rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1); // First day of previous month
        rangeLabel = rangeStart.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        break;

      case 'this_month':
      default:
        rangeStart = new Date(now.getFullYear(), now.getMonth(), 1); // First day of current month
        rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0); // Last day of current month
        rangeLabel = rangeStart.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        break;

      case 'custom':
        if (!startDate || !endDate) {
          return res.status(400).json({ message: "startDate and endDate required for custom period" });
        }
        rangeStart = new Date(startDate);
        rangeEnd = new Date(endDate);
        
        // Validate date range
        if (rangeStart > rangeEnd) {
          return res.status(400).json({ message: "startDate must be before endDate" });
        }
        
        // Note: daysDiff validation happens after this switch statement
        rangeLabel = `${rangeStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${rangeEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        break;
    }

    // Set to start of day and end of day
    rangeStart.setHours(0, 0, 0, 0);
    rangeEnd.setHours(23, 59, 59, 999);

    // Calculate daysDiff (needed if you want to use it for any logic)
    const daysDiff = Math.ceil((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24));

    // Validate custom range limit (180 days max)
    if (period === 'custom' && daysDiff > 180) {
      return res.status(400).json({ message: "Date range cannot exceed 180 days" });
    }

    // Fetch timelogs within date range
    const timelogs = await prisma.timeLog.findMany({
      where: {
        userId: uid,
        timeIn: {
          gte: rangeStart,
          lte: rangeEnd,
        },
      },
      orderBy: { timeIn: 'asc' },
    });

    // Fetch shifts within date range
    const shifts = await prisma.userShift.findMany({
      where: {
        userId: uid,
        assignedDate: {
          gte: rangeStart,
          lte: rangeEnd,
        },
      },
      include: { shift: true },
      orderBy: { assignedDate: 'asc' },
    });

    const logsByDate = {};
    timelogs.forEach((l) => {
      if (!l.timeIn) return;
      const k = day(l.timeIn);
      logsByDate[k] ??= { hours: 0, firstIn: toDate(l.timeIn), lastOut: null };
      logsByDate[k].hours += diffH(l.timeIn, l.timeOut ?? l.timeIn);
      if (toDate(l.timeIn) < logsByDate[k].firstIn) logsByDate[k].firstIn = toDate(l.timeIn);
      if (l.timeOut) {
        const timeOut = toDate(l.timeOut);
        if (!logsByDate[k].lastOut || timeOut > logsByDate[k].lastOut) logsByDate[k].lastOut = timeOut;
      }
    });

    const shiftByDate = {};
    shifts.forEach((s) => {
      const k = day(s.assignedDate);
      shiftByDate[k] ??= [];
      shiftByDate[k].push(s.shift);
    });

    let totalHours = 0,
      overtime = 0,
      late = 0,
      absences = 0;

    Object.entries(shiftByDate).forEach(([k, arr]) => {
      const schedH = arr.reduce((n, sh) => n + diffH(sh.startTime, sh.endTime), 0);
      const actualH = logsByDate[k]?.hours ?? 0;
      totalHours += actualH;
      overtime += Math.max(0, actualH - schedH);

      const firstStart = toDate(Math.min(...arr.map((sh) => toDate(sh.startTime))));
      const grace = addMin(firstStart, 15);

      if (!actualH) absences++;
      else if (logsByDate[k].firstIn > grace) late++;
    });

    Object.entries(logsByDate).forEach(([k, v]) => {
      if (!shiftByDate[k]) totalHours += v.hours;
    });

    const dailyHours = Object.entries(logsByDate)
      .sort()
      .map(([d, v]) => ({ date: d, hours: +v.hours.toFixed(2) }));

    // "Usual" clock-in/out — median time-of-day across days with a session,
    // robust to one-off early/late outliers. Clock-out only considers days
    // with a completed (timeOut-having) session.
    const daySessions = Object.values(logsByDate);
    const usualClockIn = formatTimeOfDay(median(daySessions.map((v) => minutesOfDay(v.firstIn))));
    const usualClockOut = formatTimeOfDay(
      median(daySessions.filter((v) => v.lastOut).map((v) => minutesOfDay(v.lastOut)))
    );

    // Averages — per-day is total ÷ days that actually have a logged
    // session (not every calendar day in the period); per-week/per-month are
    // a projected rate off that daily figure, since the period picker itself
    // already governs which days are being averaged.
    const daysWithSession = daySessions.length;
    const hoursPerDay = daysWithSession ? totalHours / daysWithSession : 0;
    const overtimePerDay = daysWithSession ? overtime / daysWithSession : 0;
    const averages = {
      hoursPerDay: +hoursPerDay.toFixed(2),
      hoursPerWeek: +(hoursPerDay * 7).toFixed(2),
      hoursPerMonth: +(hoursPerDay * 30).toFixed(2),
      overtimePerDay: +overtimePerDay.toFixed(2),
      overtimePerWeek: +(overtimePerDay * 7).toFixed(2),
      overtimePerMonth: +(overtimePerDay * 30).toFixed(2),
    };

    return res.status(200).json({
      data: {
        profile: {
          username: user.username,
          firstName: user.profile?.firstName || "",
          lastName: user.profile?.lastName || "",
          email: user.email,
          department: user.department?.name || "—",
        },
        totals: {
          totalHours: +totalHours.toFixed(2),
          overtime: +overtime.toFixed(2),
          lateIns: late,
          absences,
          activeSessions: timelogs.filter((l) => l.status).length,
        },
        patterns: {
          usualClockIn,
          usualClockOut,
        },
        averages,
        charts: { dailyHours },
        dateRange: {
          start: rangeStart.toISOString().split('T')[0],
          end: rangeEnd.toISOString().split('T')[0],
          label: rangeLabel,
          period: period,
        },
      },
    });
  } catch (e) {
    console.error("getEmployeeAnalytics", e);
    res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = { getEmployeeAnalytics };
