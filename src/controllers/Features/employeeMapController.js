// src/controllers/Features/employeeMapController.js
//
// BB-128 (part 1): GET /api/employee-map — clock-in / clock-out locations for
// the Employee Map (heat layer + points + work sites). Read-only.
// BB-128 (part 2): the response includes layers.breadcrumbs (GPS tracks). Uploads go
// through the mobile endpoint POST /api/timelogs/location-breadcrumbs.
// BB-128 map views (2026-11-25): one endpoint per tab, each loaded on its own:
//   /punches (clock-in/out), /routes (breadcrumb tracks), /live (admins only).
// The combined GET / stays until the client has switched to the tabs.

const { buildEmployeeMap, buildPunchMap, buildRoutesMap, EmployeeMapError } = require("@services/Locations/employeeMapService");
const { buildLiveMap } = require("@services/Locations/liveMapService");

const handle = (label, build) => async (req, res) => {
  try {
    return res.json({ data: await build(req.user, req.query) });
  } catch (err) {
    if (err instanceof EmployeeMapError) return res.status(err.status).json({ message: err.message });
    console.error(`[BB-128] ${label} error:`, err);
    return res.status(500).json({ message: "Failed to load the Employee Map." });
  }
};

const getEmployeeMap = handle("getEmployeeMap", buildEmployeeMap);
const getPunchMap = handle("getPunchMap", buildPunchMap);
const getRoutesMap = handle("getRoutesMap", buildRoutesMap);
const getLiveMap = handle("getLiveMap", buildLiveMap);

module.exports = { getEmployeeMap, getPunchMap, getRoutesMap, getLiveMap };
