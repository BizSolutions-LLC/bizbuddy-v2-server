// src/controllers/Features/superAdminAnalyticsController.js

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

const ym = (d) => new Date(d).toISOString().slice(0, 7);

module.exports.getSuperAdminAnalytics = async (req, res) => {
  try {
    const [companies, users, timelogs, payments] = await Promise.all([
      prisma.company.findMany({
        select: {
          id: true,
          name: true,
          createdAt: true,
          Subscription: {
            where: { active: true },
            select: { plan: { select: { name: true } } },
            take: 1,
          },
        },
      }),
      prisma.user.findMany({ where: HUMAN_ONLY, select: { id: true, companyId: true, createdAt: true } }),
      prisma.timeLog.findMany({
        select: {
          userId: true,
          timeIn: true,
          deviceInfo: true,
          location: true,
        },
      }),
      prisma.payment.findMany({
        where: { paymentDate: { gte: new Date(new Date().setDate(new Date().getDate() - 30)) } },
        select: { amount: true },
      }),
    ]);

    const planMix = {};
    const companiesPerMonth = {};
    companies.forEach((c) => {
      const plan = c.Subscription?.[0]?.plan?.name || "None";
      planMix[plan] = (planMix[plan] || 0) + 1;

      const m = ym(c.createdAt);
      companiesPerMonth[m] = (companiesPerMonth[m] || 0) + 1;
    });

    const hiresPerMonth = {};
    users.forEach((u) => {
      const m = ym(u.createdAt);
      hiresPerMonth[m] = (hiresPerMonth[m] || 0) + 1;
    });

    const sessionsCountry = {};
    const sessionsCity = {};
    const deviceUsage = {};

    timelogs.forEach((log) => {
      const loc = log.location?.start || log.location?.end || {};
      if (loc.country) sessionsCountry[loc.country] = (sessionsCountry[loc.country] || 0) + 1;
      if (loc.city) sessionsCity[loc.city] = (sessionsCity[loc.city] || 0) + 1;

      const dev = (log.deviceInfo?.start?.platform || log.deviceInfo?.end?.platform || "Unknown").toLowerCase();
      let bucket = "web";
      if (dev.includes("android") || dev.includes("ios")) bucket = "mobile";
      else if (dev.includes("tablet")) bucket = "tablet";
      deviceUsage[bucket] = (deviceUsage[bucket] || 0) + 1;
    });

    const THIRTY_DAYS = new Date(new Date().setDate(new Date().getDate() - 30));
    const activeUsersSet = new Set(timelogs.filter((t) => new Date(t.timeIn) >= THIRTY_DAYS).map((t) => t.userId));

    const totalActiveUsers = activeUsersSet.size;
    const mrr = payments.reduce((s, p) => s + Number(p.amount), 0).toFixed(2);
    const serverUptime = 99.95;

    const activeByCompany = {};
    activeUsersSet.forEach((uid) => {
      const compId = users.find((u) => u.id === uid)?.companyId;
      if (compId) activeByCompany[compId] = (activeByCompany[compId] || 0) + 1;
    });
    const topClients = Object.entries(activeByCompany)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cid, cnt]) => ({
        company: companies.find((c) => c.id === cid)?.name || cid,
        activeUsers: cnt,
      }));

    let ticketsPerMonth = [];
    try {
      const tickets = await prisma.supportTicket.findMany({
        select: { createdAt: true },
      });
      const map = {};
      tickets.forEach((t) => {
        const m = ym(t.createdAt);
        map[m] = (map[m] || 0) + 1;
      });
      ticketsPerMonth = Object.entries(map)
        .sort()
        .map(([month, count]) => ({ month, count }));
    } catch (_) {}

    const toArr = (obj, k1 = "name", k2 = "value") => Object.entries(obj).map(([a, b]) => ({ [k1]: a, [k2]: b }));

    return res.status(200).json({
      data: {
        planMix: toArr(planMix),
        newCompanies: toArr(companiesPerMonth, "month", "count").sort((a, b) => a.month.localeCompare(b.month)),
        newEmployees: toArr(hiresPerMonth, "month", "count").sort((a, b) => a.month.localeCompare(b.month)),
        sessionsCountry: toArr(sessionsCountry, "country", "count"),
        sessionsCity: toArr(sessionsCity, "city", "count"),
        deviceUsage: toArr(deviceUsage),
        totalActiveUsers,
        mrr: Number(mrr),
        serverUptime,
        topClients,
        ticketsPerMonth,
        totals: {
          companies: companies.length,
          employees: users.length,
          plans: Object.keys(planMix).length,
        },
      },
    });
  } catch (err) {
    console.error("SuperAdminAnalytics error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports.getSuperadminAnalyticsDashboard = async (req, res) => {
  try {
    const { period = 'this_month', startDate, endDate } = req.query;
    
    // Verify superadmin role
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ message: "Access denied: Superadmin only" });
    }

    // Calculate date range
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

      case 'last_30_days':
        rangeEnd = new Date(now);
        rangeStart = new Date(now);
        rangeStart.setDate(rangeStart.getDate() - 29);
        rangeLabel = 'Last 30 days';
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
        
        rangeLabel = `${rangeStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${rangeEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        break;
    }

    rangeStart.setHours(0, 0, 0, 0);
    rangeEnd.setHours(23, 59, 59, 999);

    const daysDiff = Math.ceil((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24));

    if (period === 'custom' && daysDiff > 365) {
      return res.status(400).json({ message: "Date range cannot exceed 365 days for superadmin view" });
    }

    // Helper functions
    const monthKey = (date) => new Date(date).toISOString().slice(0, 7);
    const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

    // === PLATFORM TOTALS (All Time) ===
    const [
      totalCompanies,
      totalEmployees,
      totalPlans,
      activeSubscriptions,
    ] = await Promise.all([
      prisma.company.count(),
      prisma.user.count({ where: { ...HUMAN_ONLY, status: 'active', role: { not: 'superadmin' } } }),
      prisma.subscriptionPlan.count(),
      prisma.subscription.findMany({
        where: { active: true },
        include: {
          plan: { select: { name: true, price: true } },
          company: { select: { name: true } },
        },
      }),
    ]);

    // === PERIOD-SPECIFIC METRICS ===
    const [
      newCompanies,
      newEmployees,
      activeUsers,
      timelogs,
      leaves,
    ] = await Promise.all([
      // New companies in period
      prisma.company.findMany({
        where: {
          createdAt: { gte: rangeStart, lte: rangeEnd },
        },
        select: {
          id: true,
          name: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),

      // New employees in period
      prisma.user.findMany({
        where: {
          ...HUMAN_ONLY,
          createdAt: { gte: rangeStart, lte: rangeEnd },
          role: { not: 'superadmin' },
        },
        select: {
          id: true,
          username: true,
          companyId: true,
          createdAt: true,
        },
      }),

      // Active users (logged time) in period
      prisma.user.findMany({
        where: {
          ...HUMAN_ONLY,
          role: { not: 'superadmin' },
          TimeLog: {
            some: {
              timeIn: { gte: rangeStart, lte: rangeEnd },
            },
          },
        },
        select: {
          id: true,
          companyId: true,
          company: { select: { name: true } },
        },
      }),

      // Timelogs for activity metrics
      prisma.timeLog.findMany({
        where: {
          timeIn: { gte: rangeStart, lte: rangeEnd },
          user: { role: { not: 'superadmin' } },
        },
        select: {
          userId: true,
          timeIn: true,
          timeOut: true,
          user: {
            select: {
              companyId: true,
              company: { select: { name: true, country: true } },
            },
          },
        },
      }),

      // Leave requests in period
      prisma.leave.count({
        where: {
          OR: [
            { startDate: { gte: rangeStart, lte: rangeEnd } },
            { endDate: { gte: rangeStart, lte: rangeEnd } },
          ],
        },
      }),
    ]);

    // === CALCULATIONS ===

    // 1. MRR (Monthly Recurring Revenue)
    const mrr = activeSubscriptions.reduce((sum, sub) => {
      const price = parseFloat(sub.plan.price);
      return sum + price;
    }, 0);

    // 2. Subscription Mix
    const subscriptionMix = {};
    activeSubscriptions.forEach(sub => {
      const planName = sub.plan.name;
      subscriptionMix[planName] = (subscriptionMix[planName] || 0) + 1;
    });
    const planMix = Object.entries(subscriptionMix).map(([name, value]) => ({ name, value }));

    // 3. Revenue by Plan
    const revenueByPlan = {};
    activeSubscriptions.forEach(sub => {
      const planName = sub.plan.name;
      const price = parseFloat(sub.plan.price);
      revenueByPlan[planName] = (revenueByPlan[planName] || 0) + price;
    });
    const revenueByPlanData = Object.entries(revenueByPlan)
      .map(([plan, revenue]) => ({ plan, revenue: Number(revenue.toFixed(2)) }))
      .sort((a, b) => b.revenue - a.revenue);

    // 4. New Companies Over Time
    const companiesByPeriod = {};
    newCompanies.forEach(company => {
      const key = daysDiff <= 31 ? dayKey(company.createdAt) : monthKey(company.createdAt);
      companiesByPeriod[key] = (companiesByPeriod[key] || 0) + 1;
    });
    const newCompaniesData = Object.entries(companiesByPeriod)
      .sort()
      .map(([period, count]) => ({
        period,
        count,
        label: daysDiff <= 31 ? period.slice(5) : period,
      }));

    // 5. New Employees Over Time
    const employeesByPeriod = {};
    newEmployees.forEach(emp => {
      const key = daysDiff <= 31 ? dayKey(emp.createdAt) : monthKey(emp.createdAt);
      employeesByPeriod[key] = (employeesByPeriod[key] || 0) + 1;
    });
    const newEmployeesData = Object.entries(employeesByPeriod)
      .sort()
      .map(([period, count]) => ({
        period,
        count,
        label: daysDiff <= 31 ? period.slice(5) : period,
      }));

    // 6. Active Users by Company
    const activeByCompany = {};
    activeUsers.forEach(user => {
      const companyName = user.company?.name || 'Unknown';
      activeByCompany[companyName] = (activeByCompany[companyName] || 0) + 1;
    });
    const topActiveCompanies = Object.entries(activeByCompany)
      .map(([company, activeUsers]) => ({ company, activeUsers }))
      .sort((a, b) => b.activeUsers - a.activeUsers)
      .slice(0, 10);

    // 7. Activity by Country
    const activityByCountry = {};
    timelogs.forEach(log => {
      const country = log.user?.company?.country || 'Unknown';
      activityByCountry[country] = (activityByCountry[country] || 0) + 1;
    });
    const sessionsByCountry = Object.entries(activityByCountry)
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 8. Total Hours Tracked Platform-Wide
    const totalHours = timelogs.reduce((sum, log) => {
      if (!log.timeOut) return sum;
      const hours = (new Date(log.timeOut) - new Date(log.timeIn)) / 36e5;
      return sum + hours;
    }, 0);

    // 9. Average Hours per Active User
    const avgHoursPerUser = activeUsers.length > 0 
      ? (totalHours / activeUsers.length).toFixed(1) 
      : 0;

    // 10. Engagement Rate (Active Users / Total Employees)
    const engagementRate = totalEmployees > 0 
      ? ((activeUsers.length / totalEmployees) * 100).toFixed(1) 
      : 0;

    // 11. Companies by Hours Tracked (Top Performers)
    const hoursByCompany = {};
    timelogs.forEach(log => {
      if (!log.timeOut) return;
      const company = log.user?.company?.name || 'Unknown';
      const hours = (new Date(log.timeOut) - new Date(log.timeIn)) / 36e5;
      hoursByCompany[company] = (hoursByCompany[company] || 0) + hours;
    });
    const topCompaniesByHours = Object.entries(hoursByCompany)
      .map(([company, hours]) => ({ company, hours: Number(hours.toFixed(1)) }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 10);

    // 12. Platform Health Metrics
    const serverUptime = 99.9; // Replace with actual monitoring data
    const avgResponseTime = 245; // Replace with actual monitoring data (ms)

    // === RESPONSE ===
    return res.status(200).json({
      data: {
        summary: {
          // Platform Totals (All Time)
          totalCompanies,
          totalEmployees,
          totalPlans,
          totalActiveSubscriptions: activeSubscriptions.length,
          
          // Period Metrics
          newCompaniesCount: newCompanies.length,
          newEmployeesCount: newEmployees.length,
          activeUsersCount: activeUsers.length,
          totalHoursTracked: Number(totalHours.toFixed(1)),
          avgHoursPerUser: parseFloat(avgHoursPerUser),
          engagementRate: parseFloat(engagementRate),
          leaveRequestsCount: leaves,
          
          // Business Metrics
          mrr: Number(mrr.toFixed(2)),
          
          // Platform Health
          serverUptime,
          avgResponseTime,
        },
        charts: {
          subscriptionMix: planMix,
          revenueByPlan: revenueByPlanData,
          newCompanies: newCompaniesData,
          newEmployees: newEmployeesData,
          topActiveCompanies: topActiveCompanies.slice(0, 5), // Top 5 for main view
          topCompaniesByHours,
          sessionsByCountry,
        },
        tables: {
          topActiveCompanies, // All 10 for table
          recentCompanies: newCompanies.slice(0, 10).map(c => ({
            name: c.name,
            createdAt: c.createdAt,
            daysAgo: Math.floor((now - new Date(c.createdAt)) / (1000 * 60 * 60 * 24)),
          })),
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
    console.error("getSuperadminAnalytics", e);
    res.status(500).json({ message: "Internal server error" });
  }
};