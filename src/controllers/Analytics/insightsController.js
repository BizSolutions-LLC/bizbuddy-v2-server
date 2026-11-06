// src/controllers/Analytics/insightsController.js
//
// BB-112: User Activity Analytics, Security Monitor and Live Server endpoints
// for the system-admin dashboard. Read-only.

const activity = require("@services/Analytics/userActivityService");
const security = require("@services/Analytics/securityMonitorService");
const server = require("@services/Analytics/serverMonitorService");
const capacity = require("@services/Analytics/capacityService");
const capacityReports = require("@services/Analytics/capacityReportService");
const { cachedHandler, MINUTE } = require("@utils/ttlCache");

const handle = (fn) => async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await fn(req.query) });
  } catch (error) {
    next(error);
  }
};

// BB-114: heavy RequestLog aggregates are served from a shared cache
// (adds `cache: { hit, cachedAt, expiresAt }`; ?refresh=1 forces a reload).
const cached = (name, ttlMs, fn) => cachedHandler(name, ttlMs, (req) => fn(req.query));

module.exports = {
  /** GET /api/system-admin/activity/overview  Query: days (30), companyId?, refresh? — cached 15 min */
  getActivityOverview: cached("activity.overview", 15 * MINUTE, activity.getOverview),
  /** GET /api/system-admin/activity/features  Query: days (30), companyId?, refresh? — cached 15 min */
  getFeatureUsage: cached("activity.features", 15 * MINUTE, activity.getFeatureUsage),
  /** GET /api/system-admin/activity/peak-hours  Query: days (30), companyId?, refresh? — cached 15 min */
  getPeakHours: cached("activity.peakHours", 15 * MINUTE, activity.getPeakHours),
  /** GET /api/system-admin/activity/inactive  Query: days (30), companyId?, limit (200), refresh? — cached 15 min */
  getInactiveUsers: cached("activity.inactive", 15 * MINUTE, activity.getInactiveUsers),
  /** GET /api/system-admin/security/signals  Query: timeRange (1h | 6h | 24h | 7d | 30d), refresh? — cached 2 min */
  getSecuritySignals: cached("security.signals", 2 * MINUTE, security.getSignals),
  /** GET /api/system-admin/server/logs  Query: after (0), level?, q?, limit (500), poll? */
  getServerLogs: handle(server.getLogs),
  /** GET /api/system-admin/server/health  Query: poll? */
  getServerHealth: handle(server.getHealth),
  /** GET /api/system-admin/capacity  Query: days (7, max 30), refresh? — gauges + verdicts, cached 1 min */
  getCapacity: cached("capacity", MINUTE, capacity.getCapacity),
  /** GET /api/system-admin/capacity/history  Query: days (7, max 30), refresh? — chart points, cached 1 min */
  getCapacityHistory: cached("capacity.history", MINUTE, capacity.getHistory),
  /** GET /api/system-admin/capacity/reports — BB-113 Baseline, saved periods, the running period */
  listCapacityReports: handle(capacityReports.listReports),
  /** POST /api/system-admin/capacity/reports/baseline  Body: { endsAt } — BB-113 save the Baseline */
  saveCapacityBaseline: async (req, res, next) => {
    try {
      res.status(200).json({ success: true, data: await capacityReports.saveBaseline(req.body, req.systemAdmin) });
    } catch (error) {
      next(error);
    }
  },
  /** POST /api/system-admin/capacity/reports/current — BB-113 save the running period to date */
  saveCurrentCapacityPeriod: async (req, res, next) => {
    try {
      res.status(200).json({ success: true, data: await capacityReports.saveCurrentPeriod(req.systemAdmin) });
    } catch (error) {
      next(error);
    }
  },
  /** POST /api/system-admin/capacity/reports/periods/:number — BB-113 build or rebuild one period */
  saveCapacityPeriod: async (req, res, next) => {
    try {
      res.status(200).json({ success: true, data: await capacityReports.savePeriod(req.params.number, req.systemAdmin) });
    } catch (error) {
      next(error);
    }
  },
  /** GET /api/system-admin/capacity/reports/:number/pdf — BB-113 a report as a PDF (0 = Baseline) */
  downloadCapacityReport: async (req, res, next) => {
    try {
      const { buffer, filename } = await capacityReports.getReportPdf(req.params.number);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  },
};
