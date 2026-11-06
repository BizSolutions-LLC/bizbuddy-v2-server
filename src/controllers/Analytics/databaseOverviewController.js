// src/controllers/Analytics/databaseOverviewController.js
//
// BB-110: read-only database overview endpoints for the system-admin dashboard.

const overview = require("@services/Analytics/databaseOverviewService");

/** GET /api/system-admin/database/storage — size and estimated rows per table, grouped by category */
async function getStorage(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await overview.getStorage() });
  } catch (error) {
    next(error);
  }
}

/** GET /api/system-admin/database/business — companies, active employees, per-company activity */
async function getBusiness(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await overview.getBusiness() });
  } catch (error) {
    next(error);
  }
}

/** GET /api/system-admin/database/growth — rows added in the last 7 / 30 days */
async function getGrowth(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await overview.getGrowth() });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/system-admin/database/cleanup-candidates
 * Query (days): requestLogDays, auditLogDays, notificationDays, emailLogDays, activityDays
 * Counts only — nothing is deleted.
 */
async function getCleanupCandidates(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await overview.getCleanupCandidates(req.query) });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getStorage,
  getBusiness,
  getGrowth,
  getCleanupCandidates,
};
