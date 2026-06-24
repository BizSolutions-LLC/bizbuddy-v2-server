// src/routes/Features/leaveBalanceRoutes.js

const router = require("express").Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const {
  adjustBalance,
  listMatrix,
  getTransactions,
} = require("@controllers/Features/leaveBalanceController");

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

module.exports = router;
