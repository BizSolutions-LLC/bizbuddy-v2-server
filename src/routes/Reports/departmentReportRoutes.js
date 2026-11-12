// src/routes/Reports/departmentReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getDepartmentsReport } = require("@controllers/Reports/departmentReportController");

/**
 * @route   GET /api/reports/departments?format=pdf|xlsx|csv
 * @desc    BB-119 Departments report: headcounts plus each department's time & pay
 *          settings (PDF on the shared report layout, or a clean CSV).
 * @access  Admin, Superadmin (every department), Supervisor (own department).
 */
router.get(
  "/departments",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getDepartmentsReport
);

module.exports = router;
