// src/routes/Features/contestPolicyRoutes.js

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");
const { blockSystemAgent } = require("@utils/systemAgent");
const { 
    submitContestPolicy,
    viewContestTimeLogs,
    viewAllContestTimeLogs,
    deleteContestRequest,
    rejectContestRequest,
    approveContestRequest
} = require("@controllers/Features/contestPolicyController");

router.post("/submit", authenticate, blockSystemAgent, authorizeRoles("employee", "admin", "supervisor", "superadmin"), submitContestPolicy);
router.get("/view-contestTimeLogs", authenticate, blockSystemAgent, authorizeRoles("employee", "admin", "supervisor", "superadmin"), viewContestTimeLogs);
router.get("/view-allContestTimeLogs", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), viewAllContestTimeLogs);
router.delete("/delete/:id", authenticate, authorizeRoles("admin", "superadmin", "manager"), deleteContestRequest);
router.patch("/reject/:id", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), rejectContestRequest);
router.patch("/approve/:id", authenticate, authorizeRoles("admin", "supervisor", "superadmin"), approveContestRequest);

module.exports = router;