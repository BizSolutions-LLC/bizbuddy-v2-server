// src/routes/Features/employeeMapRoutes.js
//
// BB-128 (part 1): Employee Map. Mounted at /api/employee-map.
// Supervisors (department + direct reports) and admins only — checked in the service.
// GPS breadcrumbs (part 2, needs mobile) will add routes here later.

const express = require("express");
const router = express.Router();

const authenticate = require("@middlewares/authMiddleware");
const { getEmployeeMap } = require("@controllers/Features/employeeMapController");

router.get("/", authenticate, getEmployeeMap);

module.exports = router;
