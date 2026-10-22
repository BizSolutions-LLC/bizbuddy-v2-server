// src/routes/Features/leaveBalanceRoutes.js

const router = require("express").Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const {
  adjustBalance,
  listMatrix,
  getTransactions,
} = require("@controllers/Features/leaveBalanceController");
const {
  previewSetup,
  applySetup,
} = require("@controllers/Features/leaveCreditSetupController");

router.post(
  "/adjust",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  adjustBalance
);

router.get(
  "/matrix",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  listMatrix
);

router.get(
  "/transactions",
  authenticate,
  authorizeRoles("employee", "admin", "supervisor", "superadmin"),
  getTransactions
);

// BB-098: leave credit setup — preview is read-only, apply saves settings,
// converts balances into fiscal-year lots (first time) and expires past ones.
router.post(
  "/credit-setup/preview",
  authenticate,
  authorizeRoles("admin", "superadmin"),
  previewSetup
);

router.post(
  "/credit-setup/apply",
  authenticate,
  authorizeRoles("admin", "superadmin"),
  applySetup
);

module.exports = router;
