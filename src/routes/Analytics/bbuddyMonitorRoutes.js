// src/routes/Analytics/bbuddyMonitorRoutes.js
//
// BB-110: mounted at /api/system-admin/bbuddy — system-admin tier only.

const express = require("express");
const router = express.Router();
const verifySystemAdmin = require("@middlewares/systemAdminAuth");
const {
  getActivity,
  getSummary,
  getAccounts,
  setupAccount,
  getAgents,
  createAgent,
  updateAgent,
  removeAgent,
} = require("@controllers/Analytics/bbuddyMonitorController");

router.use(verifySystemAdmin);

router.get("/activity", getActivity);
router.get("/summary", getSummary);
router.get("/accounts", getAccounts);
router.post("/accounts/:companyId", setupAccount); // BB-107
router.get("/agents", getAgents);
router.post("/agents", createAgent);
router.put("/agents/:id", updateAgent);
router.delete("/agents/:id", removeAgent);

module.exports = router;
