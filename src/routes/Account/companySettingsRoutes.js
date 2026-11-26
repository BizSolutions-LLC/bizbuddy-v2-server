// src/routes/Account/companySettingsRoutes.js

const express = require("express");
const router = express.Router();

const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");

// BB-151: company-wide settings are changed by admins only.
const adminOnly = authorizeRoles("admin", "superadmin");

const { 
    getSettings, 
    updateSettings,
    getCheckSettings,
    updateCheckSettings,
    getCheckTemplates,
    generateTestCheckPDF,
    getSettingsHistory,
 } = require("@controllers/Account/companySettingsController");

 const {
    getSettingsNotification,
    updateSettingsNotification,
  } = require('@controllers/Company/notificationSettingsController');

router.get("/", authenticate, getSettings);
router.patch("/", authenticate, updateSettings); // role rule inside (supervisor: cutoffPageView only)
router.get("/history", authenticate, adminOnly, getSettingsHistory); // BB-151
router.get("/check-settings", authenticate, getCheckSettings);
router.put("/check-settings", authenticate, adminOnly, updateCheckSettings);
router.get("/check-templates", authenticate, getCheckTemplates);
router.post("/check-test-pdf", authenticate, adminOnly, generateTestCheckPDF);

router.get('/notification-settings', authenticate, getSettingsNotification);
router.put('/notification-settings', authenticate, adminOnly, updateSettingsNotification);

module.exports = router;
