// src/routes/Features/leaveRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");
const {
  submitLeaveRequest,
  getUserLeaves,
  getPendingLeavesForApprover,
  approveLeave,
  rejectLeave,
  previewApproval,
  getLeaveDays,
  getApprovers,
  getLeavesForApprover,
  deleteLeave,
  getBalance,
  listBalances,
  getAffectedSchedules,
} = require("@controllers/Features/leaveController");

const { getAvailablePolicies } = require("@controllers/Features/leavePolicyController");

router.get(
  "/policies",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getAvailablePolicies
);

router.post(
  "/submit",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  submitLeaveRequest
);
router.get(
  "/my",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getUserLeaves
);
router.get(
  "/pending",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getPendingLeavesForApprover
);
router.get(
  "/",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getLeavesForApprover
);
router.put(
  "/:id/approve",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  approveLeave
);
router.put(
  "/:id/reject",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  rejectLeave
);
router.get(
  "/:id/preview",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  previewApproval
);
router.get(
  "/:id/days",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getLeaveDays
);
router.get(
  "/approvers",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getApprovers
);
router.delete(
  "/:id",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  deleteLeave
);

router.get(
  "/affected-schedules",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getAffectedSchedules
);

router.get(
  "/balance",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getBalance
);

router.get(
  "/balances",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  listBalances
);

module.exports = router;
