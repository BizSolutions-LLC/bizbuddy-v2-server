// src/routes/Features/dailyTaskReportRoutes.js
//
// BB-129: clock-out documentation (Daily Task Report). Mounted at /api/task-reports.
//   /me…   — the signed-in employee's own reports (B. Buddy blocked)
//   /team  — supervisors (department + direct reports) and admins, view only
//   /:id   — one submitted report (owner, or supervisor/admin in scope)
// The /me and /team routes must stay above /:id.

const express = require("express");
const router = express.Router();

const authenticate = require("@middlewares/authMiddleware");
const { blockSystemAgent } = require("@utils/systemAgent");
const c = require("@controllers/Features/dailyTaskReportController");

router.get("/me", authenticate, blockSystemAgent, c.listMine);
router.get("/me/:date", authenticate, blockSystemAgent, c.getMine);
router.put("/me/:date", authenticate, blockSystemAgent, c.saveMine);
router.get("/me/:date/pdf", authenticate, blockSystemAgent, c.getMinePdf);

router.get("/team", authenticate, c.listTeam);
router.get("/:id", authenticate, c.getOne);
router.get("/:id/pdf", authenticate, c.getOnePdf);

module.exports = router;
