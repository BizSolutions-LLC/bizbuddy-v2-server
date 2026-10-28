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
router.get("/device-token", getDeviceToken);
router.post("/device-token", updateDeviceToken);
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
