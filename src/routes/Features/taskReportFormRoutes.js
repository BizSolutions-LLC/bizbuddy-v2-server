// src/routes/Features/taskReportFormRoutes.js
//
// BB-129: custom clock-out documentation forms. Mounted at /api/task-report-forms.
//   /assignments…  — admin: which form goes to whom (phase 2)
//   /me…           — the signed-in employee answering their own punches (phase 2; B. Buddy blocked)
//   /responses/:id — one answer set: owner, or supervisor/admin in scope (phase 2)
//   / and /:id…    — admin form builder (phase 1)
// The named routes must stay above /:id.

const express = require("express");
const router = express.Router();

const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const { blockSystemAgent } = require("@utils/systemAgent");
const c = require("@controllers/Features/taskReportFormController");

const adminOnly = [authenticate, authorizeRoles("admin", "superadmin")];
const self = [authenticate, blockSystemAgent];

// Assignments (admin)
router.get("/assignments", ...adminOnly, c.listAssignments);
router.put("/assignments", ...adminOnly, c.setAssignment);
router.delete("/assignments/:id", ...adminOnly, c.removeAssignment);

// Employee: own questionnaires
router.get("/me/pending", ...self, c.myPending);
router.get("/me/responses", ...self, c.myResponses);
router.get("/me/punch/:timeLogId", ...self, c.myOpen);
router.put("/me/punch/:timeLogId", ...self, c.mySave);

// One answer set (owner / supervisor / admin)
router.get("/responses/:id", authenticate, c.getResponse);
router.get("/responses/:id/pdf", authenticate, c.getResponsePdf);

// Form builder (admin)
router.get("/", ...adminOnly, c.list);
router.post("/", ...adminOnly, c.create);
router.get("/:id", ...adminOnly, c.getOne);
router.patch("/:id", ...adminOnly, c.update);
router.delete("/:id", ...adminOnly, c.remove);
router.post("/:id/duplicate", ...adminOnly, c.duplicate);
router.post("/:id/archive", ...adminOnly, c.archive);
router.post("/:id/restore", ...adminOnly, c.restore);

module.exports = router;
