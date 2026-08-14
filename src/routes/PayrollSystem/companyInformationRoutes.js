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
} = require("@controllers/PayrollSystem/companyInformationController");
const authenticate = require("@middlewares/authMiddleware");

// Company & Config
router.get("/company-settings", authenticate, getCompanySettings);
router.put("/payroll-config", authenticate, updatePayrollConfig);
router.put("/company-info", authenticate, updateCompanyInfo);

// Earning Types
router.post("/earning-types", authenticate, createEarningType);
router.put("/earning-types/:id", authenticate, updateEarningType);
router.delete("/earning-types/:id", authenticate, deleteEarningType);

// Deduction Types
router.post("/deduction-types", authenticate, createDeductionType);
router.put("/deduction-types/:id", authenticate, updateDeductionType);
router.delete("/deduction-types/:id", authenticate, deleteDeductionType);

// Federal Tax Rates (brackets, per company)
router.get("/federal-tax-rates", authenticate, listFederalTaxRates);
router.post("/federal-tax-rates", authenticate, createFederalTaxRate);
router.put("/federal-tax-rates/:id", authenticate, updateFederalTaxRate);
router.delete("/federal-tax-rates/:id", authenticate, deleteFederalTaxRate);

module.exports = router;