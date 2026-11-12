// src/routes/Reports/punchLogReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getPunchLogReport } = require("@controllers/Reports/punchLogReportController");

/**
 * @route   GET /api/reports/punch-logs?format=pdf|xlsx|csv|payroll&scope=mine|team
 *            &from=YYYY-MM-DD&to=YYYY-MM-DD | &cutoffPeriodIds=a,b
 *            &departmentId=&employeeIds=a,b&punchType=&status=active|completed
 * @desc    BB-119 Punch Logs report — one shared, read-only builder for the employee
 *          and company pages. Locked/processed cutoffs use reviewed hours; open
 *          cutoffs and date ranges use live data. Needs a date range or cutoff periods.
 * @access  scope=mine (default): any signed-in user, own punches.
 *          scope=team: Admin, Superadmin (whole company), Supervisor (own department + direct reports).
 */
router.get(
  "/punch-logs",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getPunchLogReport
);

module.exports = router;
