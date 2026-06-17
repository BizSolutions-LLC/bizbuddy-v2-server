// src/routes/Deductions/deductionsRoutes.js

const express = require("express");
const router = express.Router();
const {
  getUnemploymentTaxSettings,
  updateUnemploymentTaxSettings,
  updateFutaRate,
  getFutaRate,
  getFutaBalance,
  deductFutaBalance,
  updateFutaBalance,
} = require("@controllers/Deductions/deductionsController");
const authenticate = require("@middlewares/authMiddleware");

router.get("/settings", authenticate, getUnemploymentTaxSettings);
router.put("/settings", authenticate, updateUnemploymentTaxSettings);
router.get("/futa/rate", authenticate, getFutaRate);
router.put("/futa/rate", authenticate, updateFutaRate);
router.get("/futa/employees/:userId", authenticate, getFutaBalance);
router.post("/futa/employees/:userId/deduct", authenticate, deductFutaBalance);
router.put("/futa/employees/:userId", authenticate, updateFutaBalance);

module.exports = router;
