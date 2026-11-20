// src/routes/Features/employeeMapRoutes.js
//
// BB-128: Employee Map. Mounted at /api/employee-map.
// Map: supervisors (department + direct reports) and admins see their scope;
// other employees see only themselves (checked in the service).
// Part 2: GPS breadcrumb tracks are a layer of this map; uploads go through
// POST /api/timelogs/location-breadcrumbs (mobile developer's endpoint).

const express = require("express");
const router = express.Router();

const authenticate = require("@middlewares/authMiddleware");
const { getEmployeeMap } = require("@controllers/Features/employeeMapController");

router.get("/", authenticate, getEmployeeMap);

module.exports = router;
