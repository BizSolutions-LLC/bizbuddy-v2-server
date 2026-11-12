// src/routes/Account/accountRoutes.js

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { blockSystemAgent } = require("@utils/systemAgent");
const {
  getUserEmail,
  getUserProfile,
  signIn,
  signOut,
  updateProfile,
  changePassword,
  getDeviceToken,
  updateDeviceToken,
  getUserExportData
} = require("@controllers/Account/accountSigninController");
const {
  getAllSubscriptionPlans,
  checkCompanyName,
  checkUsername,
  signUp,
  getApprover,
} = require("@controllers/Account/accountSignupController");
const {
  requestPasswordReset,
  verifyResetToken,
  resetPassword,
} = require("@controllers/Account/resetPasswordController");
const deleteAccountController = require("@controllers/Account/accountDeleteController");

router.get("/user-export-data", getUserExportData);
router.get("/get-user-email", getUserEmail);
router.get("/profile", getUserProfile);
router.get("/approver", authenticate, getApprover);
router.put("/profile", authenticate, blockSystemAgent, updateProfile);
router.put("/change-password", authenticate, blockSystemAgent, changePassword);
// BB-117: the device-token endpoints use the signed-in user. The app already
// sends the login header; a call without it still works the old way (userId in
// the body) for now and is logged, so we can see whether old app versions remain
// before closing it. A header that is present but invalid is rejected as usual.
const loginIfPresent = (req, res, next) => {
  if (req.headers["authorization"]) return authenticate(req, res, next);
  console.warn(`[BB-117] ${req.method} /account/device-token without login header (userId ${req.body?.userId || req.query?.userId || "none"})`);
  return next();
};
router.get("/device-token", loginIfPresent, getDeviceToken);
router.post("/device-token", loginIfPresent, updateDeviceToken);
router.get("/sign-in", signIn);   // legacy — kept for backwards compatibility
router.post("/sign-in", signIn);  // legacy — kept for backwards compatibility
router.post("/login", signIn);    // new — use this going forward
router.post("/sign-out", authenticate, signOut);
router.get("/plans", getAllSubscriptionPlans);
router.get("/check-company-name", checkCompanyName);
router.get("/check-username", checkUsername);
router.post("/sign-up", signUp);
router.delete("/delete", authenticate, blockSystemAgent, deleteAccountController);

router.post("/reset-password", requestPasswordReset);
router.get("/reset-password/verify", verifyResetToken);
router.put("/reset-password", resetPassword);

module.exports = router;
