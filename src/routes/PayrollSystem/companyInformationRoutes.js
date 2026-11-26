// src/routes/PayrollSystem/companySettingsRoutes.js

const express = require("express");
const router = express.Router();
const {
  getCompanySettings,
  updatePayrollConfig,
  updateCompanyInfo,
  createEarningType,
  updateEarningType,
  deleteEarningType,
  createDeductionType,
  updateDeductionType,
  deleteDeductionType,
  listFederalTaxRates,
  createFederalTaxRate,
  updateFederalTaxRate,
  deleteFederalTaxRate,
  listStateTaxRates,
  createStateTaxRate,
  updateStateTaxRate,
  deleteStateTaxRate,
} = require("@controllers/PayrollSystem/companyInformationController");
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");

// BB-151: reads stay open to signed-in users; every change is admin only.
const adminOnly = authorizeRoles("admin", "superadmin");

// Company & Config
router.get("/company-settings", authenticate, getCompanySettings);
router.put("/payroll-config", authenticate, adminOnly, updatePayrollConfig);
router.put("/company-info", authenticate, adminOnly, updateCompanyInfo);

// Earning Types
router.post("/earning-types", authenticate, adminOnly, createEarningType);
router.put("/earning-types/:id", authenticate, adminOnly, updateEarningType);
router.delete("/earning-types/:id", authenticate, adminOnly, deleteEarningType);

// Deduction Types
router.post("/deduction-types", authenticate, adminOnly, createDeductionType);
router.put("/deduction-types/:id", authenticate, adminOnly, updateDeductionType);
router.delete("/deduction-types/:id", authenticate, adminOnly, deleteDeductionType);

// Federal Tax Rates (brackets, per company)
router.get("/federal-tax-rates", authenticate, listFederalTaxRates);
router.post("/federal-tax-rates", authenticate, adminOnly, createFederalTaxRate);
router.put("/federal-tax-rates/:id", authenticate, adminOnly, updateFederalTaxRate);
router.delete("/federal-tax-rates/:id", authenticate, adminOnly, deleteFederalTaxRate);

// State Tax Rates (brackets, per company)
router.get("/state-tax-rates", authenticate, listStateTaxRates);
router.post("/state-tax-rates", authenticate, adminOnly, createStateTaxRate);
router.put("/state-tax-rates/:id", authenticate, adminOnly, updateStateTaxRate);
router.delete("/state-tax-rates/:id", authenticate, adminOnly, deleteStateTaxRate);

module.exports = router;