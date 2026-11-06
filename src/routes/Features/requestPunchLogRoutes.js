// src/routes/Features/requestPunchLogRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");
const { blockSystemAgent } = require("@utils/systemAgent");
const {
  submitRequestPunchLog,
  checkConflict,
  viewMyRequestedPunchLogs,
  viewAllRequestedPunchLogs,
  approveRequestedPunchLog,
  rejectRequestedPunchLog,
  deleteRequestedPunchLog,
} = require("@controllers/Features/requestPunchLogController");

// Employee routes
router.post(
  "/check-conflict",
  authenticate,
  blockSystemAgent,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  checkConflict
);

router.post(
  "/submit",
  authenticate,
  blockSystemAgent,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  submitRequestPunchLog
);

router.get(
  "/my-requests",
  authenticate,
  blockSystemAgent,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  viewMyRequestedPunchLogs
);

router.delete(
  "/delete/:id",
  authenticate,
  authorizeRoles("employee", "admin", "superadmin"),
  deleteRequestedPunchLog
);

// Approver routes
router.get(
  "/all-requests",
  authenticate,
  authorizeRoles("admin", "supervisor", "manager", "superadmin"),
  viewAllRequestedPunchLogs
);

router.patch(
  "/approve/:id",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  approveRequestedPunchLog
);

router.patch(
  "/reject/:id",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  rejectRequestedPunchLog
);

module.exports = router;