// src/routes/Reports/leaveReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getLeaveReport } = require("@controllers/Reports/leaveReportController");

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
