// src/routes/Features/punchFacePhotoRoutes.js
//
// BB-141: face photos (proof of the punch). Mounted at /api/face-photos.
// Admins, supervisors and superadmins of the company, same as cutoff approvals.

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const { getCutoffFacePhotos, getFacePhotoUrl } = require("@controllers/Features/punchFacePhotoController");

const approvers = [authenticate, authorizeRoles("admin", "supervisor", "superadmin")];

router.get("/cutoff/:cutoffPeriodId", ...approvers, getCutoffFacePhotos);
router.get("/:id/url", ...approvers, getFacePhotoUrl);

module.exports = router;
