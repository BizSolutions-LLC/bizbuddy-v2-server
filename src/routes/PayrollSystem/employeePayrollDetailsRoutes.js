// src/routes/PayrollSystem/employeePayrollDetailsRoutes.js

const express = require("express");
const router = express.Router();
const {
  getEmployeePayrollDetails,
  upsertEmployeePayrollDetails,
  resetEmployeePayrollDetails,
  getAllEmployeesWithPayrollDetails,
} = require("@controllers/PayrollSystem/employeePayrollDetailsController");
const authenticate = require("@middlewares/authMiddleware");
const { protectSystemAgentTarget } = require("@utils/systemAgent");

// Get all employees with payroll details (for Create Paycheck page)
router.get("/employees-with-details", authenticate, getAllEmployeesWithPayrollDetails);

// Get single employee payroll details
router.get("/employees/:userId/payroll-details", authenticate, getEmployeePayrollDetails);

// Create or update employee payroll details
router.put("/employees/:userId/payroll-details", authenticate, protectSystemAgentTarget("userId"), upsertEmployeePayrollDetails);

// Reset employee payroll details to defaults
router.delete("/employees/:userId/payroll-details", authenticate, protectSystemAgentTarget("userId"), resetEmployeePayrollDetails);

module.exports = router;