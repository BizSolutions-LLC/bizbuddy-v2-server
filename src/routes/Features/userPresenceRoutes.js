// src/routes/Features/userPresenceRoutes.js

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { blockSystemAgent } = require("@utils/systemAgent");
const { getUserPresence, updateUserPresence } = require("../../controllers/Features/userPresenceController");

router.get("/", authenticate, getUserPresence);
router.put("/", authenticate, blockSystemAgent, updateUserPresence);

module.exports = router;
