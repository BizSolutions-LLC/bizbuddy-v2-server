// src/routes/Analytics/systemAdminAuthRoutes.js

const express = require("express");
const router = express.Router();
const verifySystemAdmin = require("@middlewares/systemAdminAuth");
const {
  login,
  confirmSetup,
  verifyMfa,
  logout,
  verify,
  changePassword,
  regenerateRecoveryCodes,
} = require("@controllers/Analytics/systemAdminAuthController");

// BB-110: two-step sign-in — password, then authenticator code
// POST /api/system-admin/auth/login
router.post("/login", login);

// POST /api/system-admin/auth/2fa/setup   (first sign-in: confirm the scanned authenticator)
router.post("/2fa/setup", confirmSetup);

// POST /api/system-admin/auth/2fa/verify  (6-digit code or recovery code)
router.post("/2fa/verify", verifyMfa);

// POST /api/system-admin/auth/logout
router.post("/logout", logout);

// GET /api/system-admin/auth/verify
router.get("/verify", verify);

// Signed-in self-service
router.put("/password", verifySystemAdmin, changePassword);
router.post("/2fa/recovery-codes", verifySystemAdmin, regenerateRecoveryCodes);

module.exports = router;
