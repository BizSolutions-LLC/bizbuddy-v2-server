// src/routes/Reports/yearlyTotalHoursReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getYearlyTotalHoursReport } = require("@controllers/Reports/yearlyTotalHoursReportController");

/**
 * @route   GET /api/reports/yearly-total-hours/:companyId?year=YYYY
 * @desc    Download the yearly total-hours Summary workbook (.xlsx) for a company.
 * @access  Admin, Supervisor, Superadmin — admin/supervisor limited to own companyId.
 */
router.get(
  "/yearly-total-hours/:companyId",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getYearlyTotalHoursReport
);

module.exports = router;
