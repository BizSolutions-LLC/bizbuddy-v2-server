// src/routes/Features/analyticsRoutes.js

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");

// ========== EXISTING BUSINESS ANALYTICS ==========
const { getAdminAnalytics, getAdminAnalyticsDashboard } = require("@controllers/Features/adminAnalyticsController");
const { getSuperAdminAnalytics, getSuperadminAnalyticsDashboard } = require("@controllers/Features/superAdminAnalyticsController");
const { getEmployeeAnalytics } = require("@controllers/Features/employeeAnalyticsController");

// ========== NEW SYSTEM ANALYTICS ==========
const analyticsController = require("@controllers/Analytics/analyticsController");
const verifySystemAdmin = require("@middlewares/systemAdminAuth");

// ========== SYSTEM ADMIN AUTH ROUTES (No auth required for these) ==========
const systemAdminAuthRoutes = require("@routes/Analytics/systemAdminAuthRoutes");
router.use("/system-admin/auth", systemAdminAuthRoutes);

// ========== EXISTING ROUTES (Keep as is) ==========
router.get("/admin", authenticate, authorizeRoles("admin", "superadmin"), getAdminAnalytics);
router.get("/super", authenticate, authorizeRoles("superadmin"), getSuperAdminAnalytics);
router.get("/employee", authenticate, authorizeRoles("employee", "admin", "superadmin", "supervisor"), getEmployeeAnalytics);
router.get("/admin-dashboard", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), getAdminAnalyticsDashboard);
// BB-133: platform-wide data (MRR, every company) — superadmin only at the route,
// not just inside the handler.
router.get("/super-dashboard", authenticate, authorizeRoles("superadmin"), getSuperadminAnalyticsDashboard);

// ========== NEW SYSTEM ANALYTICS ROUTES (System Admin only) ==========
// All system analytics require system admin authentication
router.get("/system/overview", verifySystemAdmin, analyticsController.getOverview);
router.get("/system/performance", verifySystemAdmin, analyticsController.getPerformance);
router.get("/system/errors", verifySystemAdmin, analyticsController.getErrors);
router.get("/system/users", verifySystemAdmin, analyticsController.getUserActivity);
router.get("/system/companies", verifySystemAdmin, analyticsController.getCompanyMetrics);
router.get("/system/trends", verifySystemAdmin, analyticsController.getTrends);
router.get("/system/security", verifySystemAdmin, analyticsController.getSecurityAlerts);
router.get("/system/requests", verifySystemAdmin, analyticsController.getRequestLogs);
router.get("/system/logger-health", verifySystemAdmin, analyticsController.getLoggerHealth);

module.exports = router;