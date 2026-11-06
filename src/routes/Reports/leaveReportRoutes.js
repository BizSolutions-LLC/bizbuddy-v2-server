// src/routes/Reports/leaveReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getLeaveReport, getLeaveTemplateReport } = require("@controllers/Reports/leaveReportController");

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
