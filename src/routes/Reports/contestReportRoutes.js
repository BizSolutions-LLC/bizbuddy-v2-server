// src/routes/Reports/contestReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getContestReport } = require("@controllers/Reports/contestReportController");

/**
 * @route   GET /api/reports/contests?format=pdf|xlsx|csv&scope=mine|team&from=YYYY-MM-DD&to=YYYY-MM-DD&status=all|pending,approved,rejected
 * @desc    BB-119 Contest Time Logs report (punch corrections). from/to filter on the punch date (company time zone).
 * @access  scope=mine (default): any signed-in user, own contests.
 *          scope=team: Admin, Superadmin (whole company), Supervisor (own department + direct reports).
 */
router.get(
  "/contests",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getContestReport
);

module.exports = router;
