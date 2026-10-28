// src/services/Analytics/analyticsService.js

const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();

class AnalyticsService {
  /**
   * Get overview statistics
   */
  async getOverview(timeRange = "24h") {
    const { startDate, endDate } = this.getTimeRange(timeRange);

    const [totalRequests, failedRequests, slowRequests, avgResponseTime, uniqueCounts] =
      await Promise.all([
        prisma.requestLog.count({
          where: { createdAt: { gte: startDate, lte: endDate } },
        }),
        prisma.requestLog.count({
          where: {
            createdAt: { gte: startDate, lte: endDate },
            isFailed: true,
          },
        }),
        prisma.requestLog.count({
          where: {
            createdAt: { gte: startDate, lte: endDate },
            isSlowRequest: true,
          },
        }),
        prisma.requestLog.aggregate({
          where: { createdAt: { gte: startDate, lte: endDate } },
          _avg: { responseTime: true },
        }),
        prisma.requestLog.findMany({
          where: { createdAt: { gte: startDate, lte: endDate } },
          select: { userId: true, companyId: true },
          distinct: ["userId", "companyId"],
        }),
      ]);

    const successfulRequests = totalRequests - failedRequests;
    const errorRate = totalRequests > 0 ? ((failedRequests / totalRequests) * 100).toFixed(2) : "0.00";
    const slowRequestRate = totalRequests > 0 ? ((slowRequests / totalRequests) * 100).toFixed(2) : "0.00";

    const uniqueUsers = new Set(uniqueCounts.filter((r) => r.userId).map((r) => r.userId)).size;
    const uniqueCompanies = new Set(uniqueCounts.filter((r) => r.companyId).map((r) => r.companyId)).size;

    return {
      totalRequests,
      failedRequests,
      slowRequests,
      successfulRequests,
      errorRate,
      slowRequestRate,
      avgResponseTime: Math.round(avgResponseTime._avg.responseTime || 0),
      uniqueUsers,
      uniqueCompanies,
      timeRange,
      startDate,
      endDate,
    };
  }

  /**
   * Per-endpoint performance. BB-112: aggregated in the database (percentiles via
   * percentile_disc) instead of loading every log row into memory. Same output shape.
   */
  async getPerformanceMetrics(limit = 20, timeRange = "24h") {
    const { startDate, endDate } = this.getTimeRange(timeRange);
    const rows = await this.endpointStats(startDate, endDate);

    const endpoints = [...rows]
      .sort((a, b) => b.requestCount - a.requestCount)
      .slice(0, limit)
      .map((r) => ({
        endpoint: r.endpoint,
        method: r.method,
        requestCount: r.requestCount,
        avgResponseTime: r.avgResponseTime,
        minResponseTime: r.minResponseTime,
        maxResponseTime: r.maxResponseTime,
        p50ResponseTime: r.p50ResponseTime,
        p95ResponseTime: r.p95ResponseTime,
        p99ResponseTime: r.p99ResponseTime,
        errorCount: r.errorCount,
        slowCount: r.slowCount,
        errorRate: r.requestCount > 0 ? ((r.errorCount / r.requestCount) * 100).toFixed(2) : "0.00",
      }));

    return { endpoints, slowestEndpoints: this.slowestOf(rows, 10) };
  }

  /**
   * Get slowest endpoints (at least 5 calls), by average response time.
   */
  async getSlowestEndpoints(limit = 10, timeRange = "24h") {
    const { startDate, endDate } = this.getTimeRange(timeRange);
    return this.slowestOf(await this.endpointStats(startDate, endDate), limit);
  }

  slowestOf(rows, limit) {
    return rows
      .filter((r) => r.requestCount >= 5)
      .sort((a, b) => b.avgResponseTime - a.avgResponseTime)
      .slice(0, limit)
      .map((r) => ({
        endpoint: r.endpoint,
        method: r.method,
        request_count: r.requestCount,
        avg_response_time: r.avgResponseTime,
        max_response_time: r.maxResponseTime,
      }));
  }

  async endpointStats(startDate, endDate) {
    const rows = await prisma.$queryRaw`
      SELECT
        endpoint, method,
        COUNT(*)                                                         AS "requestCount",
        ROUND(AVG("responseTime"))                                       AS "avgResponseTime",
        MIN("responseTime")                                              AS "minResponseTime",
        MAX("responseTime")                                              AS "maxResponseTime",
        percentile_disc(0.5)  WITHIN GROUP (ORDER BY "responseTime")     AS "p50ResponseTime",
        percentile_disc(0.95) WITHIN GROUP (ORDER BY "responseTime")     AS "p95ResponseTime",
        percentile_disc(0.99) WITHIN GROUP (ORDER BY "responseTime")     AS "p99ResponseTime",
        COUNT(*) FILTER (WHERE "isFailed")                               AS "errorCount",
        COUNT(*) FILTER (WHERE "isSlowRequest")                          AS "slowCount"
      FROM "RequestLog"
      WHERE "createdAt" >= ${startDate} AND "createdAt" <= ${endDate}
      GROUP BY endpoint, method`;
    const n = (v) => (v == null ? 0 : Number(v));
    return rows.map((r) => ({
      endpoint: r.endpoint,
      method: r.method,
      requestCount: n(r.requestCount),
      avgResponseTime: n(r.avgResponseTime),
      minResponseTime: n(r.minResponseTime),
      maxResponseTime: n(r.maxResponseTime),
      p50ResponseTime: n(r.p50ResponseTime),
      p95ResponseTime: n(r.p95ResponseTime),
      p99ResponseTime: n(r.p99ResponseTime),
      errorCount: n(r.errorCount),
      slowCount: n(r.slowCount),
    }));
  }

  /**
   * Get error statistics
   */
  async getErrorStats(timeRange = "24h") {
    const { startDate, endDate } = this.getTimeRange(timeRange);

    const failedRequests = await prisma.requestLog.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        isFailed: true,
      },
      select: {
        endpoint: true,
        method: true,
        statusCode: true,
        errorType: true,
      }
    });

    // Group by endpoint
    const byEndpoint = {};
    failedRequests.forEach(req => {
      const key = `${req.endpoint}|${req.method}|${req.statusCode}`;
      if (!byEndpoint[key]) {
        byEndpoint[key] = {
          endpoint: req.endpoint,
          method: req.method,
          status_code: req.statusCode,
          error_count: 0,
        };
      }
      byEndpoint[key].error_count++;
    });

    const errorsByEndpoint = Object.values(byEndpoint)
      .sort((a, b) => b.error_count - a.error_count)
      .slice(0, 20);

    // Group by error type
    const byType = {};
    failedRequests.forEach(req => {
      if (req.errorType) {
        if (!byType[req.errorType]) {
          byType[req.errorType] = { errorType: req.errorType, count: 0 };
        }
        byType[req.errorType].count++;
      }
    });

    const errorsByType = Object.values(byType)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Group by status code
    const byStatusCode = {};
    failedRequests.forEach(req => {
      if (!byStatusCode[req.statusCode]) {
        byStatusCode[req.statusCode] = { statusCode: req.statusCode, count: 0 };
      }
      byStatusCode[req.statusCode].count++;
    });

    const errorsByStatusCode = Object.values(byStatusCode)
      .sort((a, b) => b.count - a.count);

    return {
      errorsByEndpoint,
      errorsByType,
      errorsByStatusCode,
    };
  }

  /**
   * Get user activity statistics
   */
  async getUserActivity(limit = 20, timeRange = "24h") {
    // BB-112: aggregated in the database (was loading every row in the range into memory)
    const { startDate, endDate } = this.getTimeRange(timeRange);
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 500);

    const rows = await prisma.$queryRaw`
      SELECT
        r."userId"                                   AS user_id,
        u.username                                   AS username,
        u.email                                      AS email,
        u.role::text                                 AS role,
        u."isSystemAgent"                            AS is_system_agent,
        MAX(c.name)                                  AS company_name,
        COUNT(*)                                     AS request_count,
        COUNT(*) FILTER (WHERE r."isFailed")         AS failed_count,
        ROUND(AVG(r."responseTime"))                 AS avg_response_time,
        MAX(r."createdAt")                           AS last_seen
      FROM "RequestLog" r
      LEFT JOIN "User" u    ON u.id = r."userId"
      LEFT JOIN "Company" c ON c.id = r."companyId"
      WHERE r."createdAt" >= ${startDate} AND r."createdAt" <= ${endDate} AND r."userId" IS NOT NULL
      GROUP BY r."userId", u.username, u.email, u.role, u."isSystemAgent"
      ORDER BY request_count DESC
      LIMIT ${take}`;

    return rows.map((r) => ({
      ...r,
      request_count: Number(r.request_count),
      failed_count: Number(r.failed_count),
      avg_response_time: r.avg_response_time == null ? null : Number(r.avg_response_time),
    }));
  }

  /**
   * Get company metrics
   */
  async getCompanyMetrics(limit = 20, timeRange = "24h") {
    const { startDate, endDate } = this.getTimeRange(timeRange);

    const requests = await prisma.requestLog.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        companyId: { not: null },
      },
      include: {
        company: {
          select: { name: true }
        }
      },
      select: {
        companyId: true,
        userId: true,
        responseTime: true,
        isFailed: true,
        company: true,
      }
    });

    const grouped = {};
    requests.forEach(req => {
      if (!grouped[req.companyId]) {
        grouped[req.companyId] = {
          company_id: req.companyId,
          company_name: req.company?.name,
          request_count: 0,
          unique_users: new Set(),
          failed_count: 0,
          totalResponseTime: 0,
        };
      }
      
      grouped[req.companyId].request_count++;
      grouped[req.companyId].totalResponseTime += req.responseTime;
      if (req.userId) grouped[req.companyId].unique_users.add(req.userId);
      if (req.isFailed) grouped[req.companyId].failed_count++;
    });

    const companyMetrics = Object.values(grouped)
      .map(company => ({
        company_id: company.company_id,
        company_name: company.company_name,
        request_count: company.request_count,
        active_users: company.unique_users.size,
        failed_count: company.failed_count,
        avg_response_time: Math.round(company.totalResponseTime / company.request_count),
      }))
      .sort((a, b) => b.request_count - a.request_count)
      .slice(0, limit);

    return companyMetrics;
  }

  /**
   * Get hourly trends
   */
  async getHourlyTrends(timeRange = "24h") {
    const { startDate, endDate } = this.getTimeRange(timeRange);

    const requests = await prisma.requestLog.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate }
      },
      select: {
        createdAt: true,
        responseTime: true,
        isFailed: true,
        isSlowRequest: true,
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    // Group by hour
    const grouped = {};
    requests.forEach(req => {
      const hour = new Date(req.createdAt);
      hour.setMinutes(0, 0, 0);
      const hourKey = hour.toISOString();
      
      if (!grouped[hourKey]) {
        grouped[hourKey] = {
          hour: hour,
          request_count: 0,
          totalResponseTime: 0,
          error_count: 0,
          slow_count: 0,
        };
      }
      
      grouped[hourKey].request_count++;
      grouped[hourKey].totalResponseTime += req.responseTime;
      if (req.isFailed) grouped[hourKey].error_count++;
      if (req.isSlowRequest) grouped[hourKey].slow_count++;
    });

    const trends = Object.values(grouped)
      .map(group => ({
        hour: group.hour,
        request_count: group.request_count,
        avg_response_time: Math.round(group.totalResponseTime / group.request_count),
        error_count: group.error_count,
        slow_count: group.slow_count,
      }))
      .sort((a, b) => a.hour - b.hour);

    return trends;
  }

  /**
   * Get security alerts
   */
  async getSecurityAlerts(timeRange = "24h") {
    // BB-112: aggregated in the database. Failed logins now cover every sign-in
    // failure status (401/403/404/429) on the user and system-admin sign-in
    // endpoints; B. Buddy's expected 403s are left out of "unauthorized access".
    // Richer graded signals: GET /api/system-admin/security/signals.
    const { startDate, endDate } = this.getTimeRange(timeRange);
    const signInEndpoints = [
      "/api/account/login",
      "/api/account/sign-in",
      "/api/system-admin/auth/login",
      "/api/system-admin/auth/2fa/verify",
      "/api/system-admin/auth/2fa/setup",
    ];

    const [failedLogins, highRequestRates, unauthorizedAccess] = await Promise.all([
      prisma.$queryRaw`
        SELECT r."ipAddress" AS ip_address, COUNT(*) AS failed_attempts, MAX(r."createdAt") AS last_attempt
        FROM "RequestLog" r
        WHERE r."createdAt" >= ${startDate} AND r."createdAt" <= ${endDate}
          AND r.endpoint IN (${Prisma.join(signInEndpoints)})
          AND r."statusCode" IN (401, 403, 404, 429)
        GROUP BY r."ipAddress"
        HAVING COUNT(*) > 5
        ORDER BY failed_attempts DESC
        LIMIT 20`,
      prisma.$queryRaw`
        SELECT r."ipAddress" AS ip_address, COUNT(*) AS request_count, COUNT(DISTINCT r.endpoint) AS unique_endpoints
        FROM "RequestLog" r
        WHERE r."createdAt" >= ${startDate} AND r."createdAt" <= ${endDate}
        GROUP BY r."ipAddress"
        HAVING COUNT(*) > 1000
        ORDER BY request_count DESC
        LIMIT 20`,
      prisma.$queryRaw`
        SELECT r.endpoint, r.method, r."ipAddress" AS ip_address, r."userId" AS user_id, COUNT(*) AS attempt_count
        FROM "RequestLog" r
        WHERE r."createdAt" >= ${startDate} AND r."createdAt" <= ${endDate}
          AND r."statusCode" = 403 AND r."isSystemAgent" = false
        GROUP BY r.endpoint, r.method, r."ipAddress", r."userId"
        ORDER BY attempt_count DESC
        LIMIT 20`,
    ]);

    const num = (rows, keys) => rows.map((r) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k, Number(r[k])])) }));
    return {
      failedLogins: num(failedLogins, ["failed_attempts"]),
      highRequestRates: num(highRequestRates, ["request_count", "unique_endpoints"]),
      unauthorizedAccess: num(unauthorizedAccess, ["attempt_count"]),
    };
  }

  /**
   * Get raw request logs with filters
   */
  async getRequestLogs(filters = {}, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const where = {
      ...(filters.startDate && filters.endDate
        ? { createdAt: { gte: new Date(filters.startDate), lte: new Date(filters.endDate) } }
        : {}),
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.systemAdminId ? { systemAdminId: filters.systemAdminId } : {}), // BB-110
      ...(filters.companyId ? { companyId: filters.companyId } : {}),
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.endpoint ? { endpoint: { contains: filters.endpoint } } : {}),
      ...(filters.method ? { method: filters.method } : {}),
      ...(filters.statusCode ? { statusCode: parseInt(filters.statusCode) } : {}),
      ...(filters.isFailed === "true" ? { isFailed: true } : {}),
      ...(filters.isSlowRequest === "true" ? { isSlowRequest: true } : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.requestLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: {
            select: { username: true, email: true, role: true },
          },
          company: {
            select: { name: true },
          },
          systemAdmin: {
            select: { username: true, name: true },
          },
        },
      }),
      prisma.requestLog.count({ where }),
    ]);

    return {
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Helper: Convert time range to start/end dates
   */
  getTimeRange(range) {
    const now = new Date();
    let startDate;

    switch (range) {
      case "1h":
        startDate = new Date(now.getTime() - 1 * 60 * 60 * 1000);
        break;
      case "6h":
        startDate = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        break;
      case "24h":
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "7d":
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "30d":
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    return { startDate, endDate: now };
  }
}

module.exports = new AnalyticsService();