// src/routes/index.js

const express = require("express");
const router = express.Router();

const accountRoutes = require("@routes/Account/accountRoutes");
const companyRoutes = require("@routes/Superadmin/companyRoutes");
const departmentsRoutes = require("@routes/Account/departmentRoutes");
const employeeRoutes = require("@routes/Features/employeeRoutes");
const userPresenceRoutes = require("@routes/Features/userPresenceRoutes");
const leavesRoutes = require("@routes/Features/leaveRoutes");
const locationRoutes = require("@routes/Features/locationRoutes");
const payrollRoutes = require("@routes/Features/payrollRoutes");
const timeLogsRoutes = require("@routes/Features/timeLogRoutes.js");
const shiftRoutes = require("@routes/Features/shiftRoutes");
const shiftAssignmentRoutes = require("@routes/Features/shiftAssignmentRoutes");
const shiftSchedulesRoutes = require("@routes/Features/shiftScheduleRoutes");
const userShiftRoutes = require("@routes/Features/userShiftRoutes");
const employeeLocationRestrictionRoutes = require("@routes/Features/employeeLocationRestrictionRoutes");
const analyticsRoutes = require("@routes/Features/analyticsRoutes");
const paymentsRoutes = require("@routes/Account/paymentRoutes");
const subscriptionPlansRoutes = require("@routes/Superadmin/subscriptionPlanRoutes");
const subscriptionsRoutes = require("@routes/Superadmin/subscriptionRoutes");
const leavePolicyRoutes = require("@routes/Features/leavePolicyRoutes");
const leaveBalanceRoutes = require("@routes/Features/leaveBalanceRoutes");
const overtimeRoutes = require("@routes/Features/overtimeRoutes");
const companySettingsRoutes = require("@routes/Account/companySettingsRoutes");
const employmentDetailRoutes = require("@routes/Features/employmentDetailRoutes");
const accountDeletionRoutes = require("@routes/Features/accountDeletionRoutes");
const conflictRoutes = require("@routes/Features/conflictRoutes");
const contestPolicyRoutes = require("@routes/Features/contestPolicyRoutes");
const requestPunchRoutes = require("@routes/Features/requestPunchLogRoutes");
const companyInformationRoutes = require("@routes/PayrollSystem/companyInformationRoutes");
const deductionsRoutes = require("@routes/Deductions/deductionsRoutes");
const payrollSystemRoutes = require("@routes/PayrollSystem/payrollSystemRoutes");
const employeePayrollDetailsRoutes = require("@routes/PayrollSystem/employeePayrollDetailsRoutes");
const cutOffDetailsRoutes = require("@routes/Features/cutoffPeriodRoutes");
const notificationRoutes = require('./notificationRoutes');
const systemAdminRoutes = require("@routes/Analytics/systemAdminRoutes");
const cutoffRoutes = require("./Cutoff/cutoffRoutes");
const dashboardRoutes = require("@routes/Features/dashboardRoutes");
const feedbackRoutes = require("@routes/Features/feedbackRoutes");
const punchLogsBootstrapRoutes = require("@routes/Features/punchLogsBootstrapRoutes");
const payrollExportRoutes = require("@routes/Payroll/payrollExportRoutes");

const testRoutes = require("@routes/testRoutes");

router.use("/account", accountRoutes);
router.use("/company", companyRoutes);
router.use("/departments", departmentsRoutes);
router.use("/payments", paymentsRoutes);
router.use("/subscription-plans", subscriptionPlansRoutes);
router.use("/subscriptions", subscriptionsRoutes);
router.use("/employee", employeeRoutes);
router.use("/timelogs", timeLogsRoutes);
router.use("/presence", userPresenceRoutes);
router.use("/leaves", leavesRoutes);
router.use("/location", locationRoutes);
router.use("/payroll", payrollRoutes);
router.use("/shifts", shiftRoutes);
router.use("/shift-assignments", shiftAssignmentRoutes);
router.use("/shiftschedules", shiftSchedulesRoutes);
router.use("/usershifts", userShiftRoutes);
router.use("/employee-location-restriction", employeeLocationRestrictionRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/leave-policies", leavePolicyRoutes);
router.use("/leave-balances", leaveBalanceRoutes);
router.use("/overtime", overtimeRoutes);
router.use("/company-settings", companySettingsRoutes);
router.use("/employment-details", employmentDetailRoutes);
router.use("/account-deletion", accountDeletionRoutes);
router.use("/conflicts", conflictRoutes);
router.use("/contest-policy", contestPolicyRoutes);
router.use("/request-punch-log", requestPunchRoutes);
router.use("/payroll-system", payrollSystemRoutes);
router.use("/company-information", companyInformationRoutes);
router.use("/deductions", deductionsRoutes);
router.use("/employee-payroll-details", employeePayrollDetailsRoutes);
router.use("/cutoff-periods", cutOffDetailsRoutes);
router.use('/notifications', notificationRoutes);
router.use("/cutoff", cutoffRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/feedback", feedbackRoutes);
router.use("/punch-logs", punchLogsBootstrapRoutes);
router.use("/payroll-export", payrollExportRoutes);

router.use("/analytics", analyticsRoutes);
router.use("/system-admin", systemAdminRoutes);
router.use("/test", testRoutes);

router.get("/", (req, res) => {
    res.status(200).json({ message: "Server is up and running!" });
});

module.exports = router;