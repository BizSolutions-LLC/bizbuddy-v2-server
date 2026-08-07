// src/routes/Payroll/payrollExportRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const { getPayrollExportByCutoffPeriod } = require("@controllers/Payroll/payrollExportController");

/**
 * @route   GET /api/payroll-export/by-cutoff-period/:id
 * @desc    Fetch the merged payroll export JSON (PayrollExportBatch) for the
 *          company+period a given CutoffPeriod belongs to.
 * @access  Admin, Supervisor, Superadmin — not typical employee users, since
 *          the payload spans every department that has processed for the period.
 */
router.get(
  "/by-cutoff-period/:id",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getPayrollExportByCutoffPeriod
);

module.exports = router;
