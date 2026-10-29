// src/routes/Analytics/systemAdminRoutes.js

const express = require("express");
const router = express.Router();
const verifySystemAdmin = require("@middlewares/systemAdminAuth");
const analyticsController = require("@controllers/Analytics/analyticsController");
const { provisionCompany, checkProvision, listPlans } = require("@controllers/Superadmin/provisionController");

// Auth routes (no middleware required)
const authRoutes = require("@routes/Analytics/systemAdminAuthRoutes");
router.use("/auth", authRoutes);

// Protected routes (require system admin auth)
router.get("/overview", verifySystemAdmin, analyticsController.getOverview);
router.get("/performance", verifySystemAdmin, analyticsController.getPerformance);
router.get("/errors", verifySystemAdmin, analyticsController.getErrors);
router.get("/users", verifySystemAdmin, analyticsController.getUserActivity);
router.get("/companies", verifySystemAdmin, analyticsController.getCompanyMetrics);
router.get("/trends", verifySystemAdmin, analyticsController.getTrends);
router.get("/security", verifySystemAdmin, analyticsController.getSecurityAlerts);
router.get("/requests", verifySystemAdmin, analyticsController.getRequestLogs);
router.get("/logger-health", verifySystemAdmin, analyticsController.getLoggerHealth);

// BB-110: B. Buddy activity monitor + support staff management
router.use("/bbuddy", require("@routes/Analytics/bbuddyMonitorRoutes"));

// BB-112: User Activity Analytics + Security Monitor (read-only)
const insights = require("@controllers/Analytics/insightsController");
router.get("/activity/overview", verifySystemAdmin, insights.getActivityOverview);
router.get("/activity/features", verifySystemAdmin, insights.getFeatureUsage);
router.get("/activity/peak-hours", verifySystemAdmin, insights.getPeakHours);
router.get("/activity/inactive", verifySystemAdmin, insights.getInactiveUsers);
router.get("/security/signals", verifySystemAdmin, insights.getSecuritySignals);
// BB-112: Live Server (watch-only: live log lines + health snapshot)
router.get("/server/logs", verifySystemAdmin, insights.getServerLogs);
router.get("/server/health", verifySystemAdmin, insights.getServerHealth);
// BB-112: Capacity (server / database / API hotspots gauges, read-only)
router.get("/capacity", verifySystemAdmin, insights.getCapacity);
router.get("/capacity/history", verifySystemAdmin, insights.getCapacityHistory);
// BB-113: Performance reports — Baseline + 30-day periods (saved snapshots + PDF)
router.get("/capacity/reports", verifySystemAdmin, insights.listCapacityReports);
router.post("/capacity/reports/baseline", verifySystemAdmin, insights.saveCapacityBaseline);
router.post("/capacity/reports/current", verifySystemAdmin, insights.saveCurrentCapacityPeriod);
router.post("/capacity/reports/periods/:number", verifySystemAdmin, insights.saveCapacityPeriod);
router.get("/capacity/reports/:number/pdf", verifySystemAdmin, insights.downloadCapacityReport);

// BB-110: read-only database overview
router.use("/database", require("@routes/Analytics/databaseOverviewRoutes"));

// BB-110: system-admin accounts (owner only)
const { requireOwner } = verifySystemAdmin;
const adminMgmt = require("@controllers/Analytics/systemAdminManagementController");
router.get("/admins", verifySystemAdmin, requireOwner, adminMgmt.getAdmins);
router.post("/admins", verifySystemAdmin, requireOwner, adminMgmt.createAdmin);
router.put("/admins/:id", verifySystemAdmin, requireOwner, adminMgmt.updateAdmin);
router.post("/admins/:id/reset-2fa", verifySystemAdmin, requireOwner, adminMgmt.reset2fa);
router.post("/admins/:id/reset-password", verifySystemAdmin, requireOwner, adminMgmt.resetPassword);

// BB-107: "Add company" (all system admins; every call is recorded with the admin)
router.post("/provision-company/check", verifySystemAdmin, checkProvision);
router.post("/provision-company", verifySystemAdmin, provisionCompany);
router.get("/subscription-plans", verifySystemAdmin, listPlans);

module.exports = router;