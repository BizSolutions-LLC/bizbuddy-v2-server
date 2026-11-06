// src/routes/Company/setupGuideRoutes.js
//
// BB-115: "Set up your business" guide. Admin + superadmin only (B. Buddy is
// an admin, so support staff see it too). Always the caller's own company.

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");

const {
  getSetupChecklist,
  skipStep,
  unskipStep,
  reviewStep,
  unreviewStep,
  dismissGuide,
  reopenGuide,
} = require("@controllers/Company/setupGuideController");

const guard = [authenticate, authorizeRoles("admin", "superadmin")];

router.get("/checklist", ...guard, getSetupChecklist);
router.post("/checklist/dismiss", ...guard, dismissGuide);
router.post("/checklist/reopen", ...guard, reopenGuide);
router.post("/checklist/steps/:key/skip", ...guard, skipStep);
router.delete("/checklist/steps/:key/skip", ...guard, unskipStep);
router.post("/checklist/steps/:key/review", ...guard, reviewStep);
router.delete("/checklist/steps/:key/review", ...guard, unreviewStep);

module.exports = router;
