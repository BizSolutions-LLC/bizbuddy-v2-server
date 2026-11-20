// src/routes/Features/userShiftRoutes.js

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");

const {
    getUserShifts,
    getCompanyEmployees,
    getEmployeeShifts,
    getBulkEmployeeShifts,
    getCompanyScheduleStats,
    getShiftsInRange,
    updateUserShift,
    deleteUserShift,
  } = require("@controllers/Features/userShiftController");

router.get("/", authenticate, getUserShifts);
router.get("/company-employees", authenticate, getCompanyEmployees);

// router.get("/company-employees", authenticate, authorizeRoles('admin', 'supervisor', 'superadmin'), getCompanyEmployees);
router.get("/employee/:employeeId", authenticate, authorizeRoles('admin', 'supervisor', 'superadmin'), getEmployeeShifts);
router.post("/bulk", authenticate, authorizeRoles('admin', 'supervisor', 'superadmin'), getBulkEmployeeShifts);
router.get("/company-stats", authenticate, authorizeRoles('admin', 'supervisor', 'superadmin'), getCompanyScheduleStats);
// BB-135: whole company's shifts for a date range (Schedules List sheet view)
router.get("/range", authenticate, authorizeRoles('admin', 'supervisor', 'superadmin'), getShiftsInRange);
router.put("/:id", authenticate, authorizeRoles('admin', 'supervisor', 'superadmin'), updateUserShift);
router.delete("/:id", authenticate, authorizeRoles('admin', 'supervisor', 'superadmin'), deleteUserShift);


module.exports = router;
