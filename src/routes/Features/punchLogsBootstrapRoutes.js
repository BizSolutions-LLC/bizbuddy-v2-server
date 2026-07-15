// src/routes/Features/punchLogsBootstrapRoutes.js

const express = require("express");
const router = express.Router();

const authenticate = require("@middlewares/authMiddleware");
const { getPunchLogsBootstrap } = require("@controllers/Features/punchLogsBootstrapController");

router.get("/bootstrap", authenticate, getPunchLogsBootstrap);

module.exports = router;
