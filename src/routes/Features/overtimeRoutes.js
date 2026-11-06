// src/routes/Features/overtimeRoutes.js

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const { blockSystemAgent } = require("@utils/systemAgent");
const { submitOvertime, getMyOT, getPendingOT, approveOT, rejectOT, deleteOT, getAllOT, detectSmartOvertime, getThresholdStatus } = require("@controllers/Features/overtimeController");

router.post("/submit", authenticate, blockSystemAgent, authorizeRoles("employee", "admin", "supervisor", "superadmin"), submitOvertime);
router.get("/threshold-status", authenticate, blockSystemAgent, authorizeRoles("employee", "admin", "supervisor", "superadmin"), getThresholdStatus);
router.get("/smart-detect", authenticate, blockSystemAgent, authorizeRoles("employee", "admin", "supervisor", "superadmin"), detectSmartOvertime);
router.get("/my", authenticate, blockSystemAgent, authorizeRoles("employee", "admin", "supervisor", "superadmin"), getMyOT);
router.get("/pending", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), getPendingOT);
router.put("/:id/approve", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), approveOT);
router.put("/:id/reject", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), rejectOT);
router.delete("/:id", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), deleteOT);
router.get("/", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), getAllOT);

module.exports = router;
