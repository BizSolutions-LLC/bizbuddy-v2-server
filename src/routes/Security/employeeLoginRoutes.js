// src/routes/Security/employeeLoginRoutes.js
//
// BB-137: Employee Logins. Mounted at /api/employee-logins.
// Admins only (B. Buddy is an admin account, so it is included). Anyone else gets
// a plain 404, as if the route didn't exist: employees must never learn about it.

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const c = require("@controllers/Security/employeeLoginController");

function adminsOnlyElse404(req, res, next) {
  if (req.user && ["admin", "superadmin"].includes(req.user.role)) return next();
  return res.status(404).json({ message: "Not found." });
}

const admins = [authenticate, adminsOnlyElse404];

router.get("/", ...admins, c.getLogins);
router.get("/shared-devices", ...admins, c.getSharedDevices);
router.get("/employees/:userId", ...admins, c.getEmployeeLogins);

module.exports = router;
