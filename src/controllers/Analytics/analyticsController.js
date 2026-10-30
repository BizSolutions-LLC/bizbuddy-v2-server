// src/controllers/Analytics/analyticsController.js

const analyticsService = require("@services/Analytics/analyticsService");
const { getLoggerStats } = require("@middlewares/requestLogger");
const { cachedHandler, MINUTE } = require("@utils/ttlCache");

// BB-114: the aggregate endpoints below are served from a shared 1-minute
// cache (adds `cache: { hit, cachedAt, expiresAt }`; ?refresh=1 forces a
// reload). Raw request logs and logger health stay live.
class AnalyticsController {
  /**
   * GET /api/analytics/system/overview
   * Dashboard overview statistics
   */
  getOverview = cachedHandler("system.overview", MINUTE, (req) => {
    const { timeRange = "24h" } = req.query;
    return analyticsService.getOverview(timeRange);
  });

  /**
   * GET /api/analytics/system/performance
   * Performance metrics by endpoint
   */
  getPerformance = cachedHandler("system.performance", MINUTE, async (req) => {
    const { limit = 20, timeRange = "24h" } = req.query;

    const [metrics, slowest] = await Promise.all([
      analyticsService.getPerformanceMetrics(parseInt(limit), timeRange),
      analyticsService.getSlowestEndpoints(10, timeRange),
    ]);

    return {
      endpoints: metrics,
      slowestEndpoints: slowest,
    };
  });

  /**
   * GET /api/analytics/system/errors
   * Error tracking and analysis
   */
  getErrors = cachedHandler("system.errors", MINUTE, (req) => {
    const { timeRange = "24h" } = req.query;
    return analyticsService.getErrorStats(timeRange);
  });

  /**
   * GET /api/analytics/system/users
   * User activity metrics (API usage)
   */
  getUserActivity = cachedHandler("system.users", MINUTE, (req) => {
    const { limit = 20, timeRange = "24h" } = req.query;
    return analyticsService.getUserActivity(parseInt(limit), timeRange);
  });

  /**
   * GET /api/analytics/system/companies
   * Company-level metrics (API usage)
   */
  getCompanyMetrics = cachedHandler("system.companies", MINUTE, (req) => {
    const { limit = 20, timeRange = "24h" } = req.query;
    return analyticsService.getCompanyMetrics(parseInt(limit), timeRange);
  });

  /**
   * GET /api/analytics/system/trends
   * Hourly trends
   */
  getTrends = cachedHandler("system.trends", MINUTE, (req) => {
    const { timeRange = "24h" } = req.query;
    return analyticsService.getHourlyTrends(timeRange);
  });

  /**
   * GET /api/analytics/system/security
   * Security monitoring and alerts
   */
  getSecurityAlerts = cachedHandler("system.security", MINUTE, (req) => {
    const { timeRange = "24h" } = req.query;
    return analyticsService.getSecurityAlerts(timeRange);
  });

  /**
   * GET /api/analytics/system/requests
   * Raw request logs (paginated, filterable)
   */
  async getRequestLogs(req, res, next) {
    try {
      const { page = 1, limit = 50, ...filters } = req.query;

      const result = await analyticsService.getRequestLogs(
        filters,
        parseInt(page),
        parseInt(limit)
      );

      res.status(200).json({
        success: true,
        data: result.logs,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/analytics/system/logger-health
   * Logger system health check
   */
  async getLoggerHealth(req, res, next) {
    try {
      const stats = getLoggerStats();

      res.status(200).json({
        success: true,
        data: {
          status: parseFloat(stats.successRate) > 90 ? "healthy" : "degraded",
          ...stats,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AnalyticsController();