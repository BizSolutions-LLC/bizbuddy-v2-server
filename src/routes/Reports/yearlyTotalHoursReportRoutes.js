// src/routes/Reports/yearlyTotalHoursReportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getYearlyTotalHoursReport } = require("@controllers/Reports/yearlyTotalHoursReportController");

/**
 * @route   GET /api/reports/yearly-total-hours/:companyId?year=YYYY&groupBy=month|quarter|year&periods=...&columns=...
 * @desc    Download the yearly total-hours Summary workbook (.xlsx) for a company.
 *          periods: Jan..Dec or Q1..Q4 (default all; ignored for year); columns: driver,regular,ot,average (default none).
 * @access  Admin, Supervisor, Superadmin — admin/supervisor limited to own companyId.
 */
router.get(
  "/yearly-total-hours/:companyId",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getYearlyTotalHoursReport
);

module.exports = router;
