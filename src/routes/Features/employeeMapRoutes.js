// src/routes/Features/employeeMapRoutes.js
//
// BB-128: Employee Map. Mounted at /api/employee-map.
// Map: supervisors (department + direct reports) and admins see their scope;
// other employees see only themselves (checked in the service).
// Part 2: GPS breadcrumb tracks are a layer of this map; uploads go through
// POST /api/timelogs/location-breadcrumbs (mobile developer's endpoint).
// Map views (2026-11-25): one endpoint per tab, loaded separately.
//   /punches  clock-in / clock-out pins (same scope as the map)
//   /routes   breadcrumb tracks (same scope as the map)
//   /live     employees clocked in right now: admins + superadmins only
//             (B. Buddy included); 404 for anyone else
//   POST /live/locate, /live/:employeeId/locate  "Locate now" (phase 3b, 2026-11-26):
//             silent push asking the phone(s) for a fresh point; same access as /live
// GET / (combined) stays until the client has switched.

const express = require("express");
const router = express.Router();

const authenticate = require("@middlewares/authMiddleware");
const {
  getEmployeeMap,
  getPunchMap,
  getRoutesMap,
  getLiveMap,
  locateNow,
  locateEveryone,
} = require("@controllers/Features/employeeMapController");

router.get("/", authenticate, getEmployeeMap);
router.get("/punches", authenticate, getPunchMap);
router.get("/routes", authenticate, getRoutesMap);
router.get("/live", authenticate, getLiveMap);
router.post("/live/locate", authenticate, locateEveryone);
router.post("/live/:employeeId/locate", authenticate, locateNow);

module.exports = router;
