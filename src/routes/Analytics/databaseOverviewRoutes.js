// src/routes/Analytics/databaseOverviewRoutes.js
//
// BB-110: mounted at /api/system-admin/database — read-only, any system admin.

const express = require("express");
const router = express.Router();
const verifySystemAdmin = require("@middlewares/systemAdminAuth");
const {
  getStorage,
  getBusiness,
  getGrowth,
  getCleanupCandidates,
} = require("@controllers/Analytics/databaseOverviewController");

router.use(verifySystemAdmin);

router.get("/storage", getStorage);
router.get("/business", getBusiness);
router.get("/growth", getGrowth);
router.get("/cleanup-candidates", getCleanupCandidates);

module.exports = router;
