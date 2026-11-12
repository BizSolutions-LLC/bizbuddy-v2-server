// src/routes/Reports/leaveReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getLeaveReport, getLeaveTemplateReport } = require("@controllers/Reports/leaveReportController");
const { getLeaveRequestsReport } = require("@controllers/Reports/leaveRequestsReportController");
const { getLeaveCalendarReport } = require("@controllers/Reports/leaveCalendarReportController");

/**
 * @route   GET /api/reports/leave/calendar?month=YYYY-MM&status=all|pending,approved,rejected,cancelled
 * @desc    BB-119 Leave Calendar PDF: month grid (actual leave days) + list of every leave in the month.
 *          month defaults to this month (company time zone); "pending" includes pending_secondary.
 * @access  Admin, Superadmin (whole company), Supervisor (own department + direct reports).
 */
router.get(
  "/leave/calendar",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getLeaveCalendarReport
);

/**
 * @route   GET /api/reports/leave/requests?format=pdf|xlsx|csv&from=YYYY-MM-DD&to=YYYY-MM-DD&status=all|pending,approved,...
 * @desc    BB-119 Leave Requests report (PDF on the shared report layout, or a clean CSV).
 *          from/to are optional (company time zone); status defaults to all.
 * @access  Admin, Superadmin (whole company), Supervisor (own department + direct reports).
 */
router.get(
  "/leave/requests",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getLeaveRequestsReport
);

/**
 * @route   GET /api/reports/leave/template?year=YYYY&quarters=Q1,Q2|months=Jan,Feb&policyIds=&departmentId=&userIds=&includeInactive=
 * @desc    BB-106 Leave Report workbook (.xlsx), docs/LeaveReport_Template.csv layout, one sheet per leave type.
 * @access  Admin, Superadmin (whole company), Supervisor (own department only).
 */
router.get(
  "/leave/template",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getLeaveTemplateReport
);

/**
 * @route   GET /api/reports/leave?type=summary|activity|expiration|requests|ledger&from=&to=&...
 * @desc    BB-098 leave reports as JSON (the client builds the files).
 * @access  Admin, Superadmin (whole company), Supervisor (own department only).
 */
router.get(
  "/leave",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getLeaveReport
);

module.exports = router;
