// src/routes/Reports/employeeReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getEmployeesReport } = require("@controllers/Reports/employeeReportController");

/**
 * @route   GET /api/reports/employees?format=pdf|xlsx|csv
 * @desc    BB-119 Employees report (PDF on the shared report layout, or a clean CSV).
 * @access  Admin, Superadmin (whole company), Supervisor (own department + direct reports).
 */
router.get(
  "/employees",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getEmployeesReport
);

module.exports = router;
