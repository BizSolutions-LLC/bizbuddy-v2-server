// src/controllers/Features/employeeMapController.js
//
// BB-128 (part 1): GET /api/employee-map — clock-in / clock-out locations for
// the Employee Map (heat layer + points + work sites). Read-only.

const { buildEmployeeMap, EmployeeMapError } = require("@services/Locations/employeeMapService");

const getEmployeeMap = async (req, res) => {
  try {
    return res.json({ data: await buildEmployeeMap(req.user, req.query) });
  } catch (err) {
    if (err instanceof EmployeeMapError) return res.status(err.status).json({ message: err.message });
    console.error("[BB-128] getEmployeeMap error:", err);
    return res.status(500).json({ message: "Failed to load the Employee Map." });
  }
};

module.exports = { getEmployeeMap };
