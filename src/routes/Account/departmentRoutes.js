// src/routes/Account/departmentRoutes.js

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const {
  getFixedHoursMembers,
  updateFixedHoursMembers,
  createDepartment,
  getAllDepartments,
  getDepartmentById,
  updateDepartment,
  deleteDepartment,
  assignUsersToDepartment,
  removeUsersFromDepartment,
  getUsersInDepartment,
} = require("@controllers/Account/departmentController");

router.post("/create", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), createDepartment);
router.get("/", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), getAllDepartments);
router.get("/:id", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), getDepartmentById);
router.put("/update/:id", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), updateDepartment);
router.delete("/delete/:id", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), deleteDepartment);
router.put("/:id/assign-users", authenticate, authorizeRoles("admin", "superadmin"), assignUsersToDepartment);
router.put("/:id/remove-users", authenticate, authorizeRoles("admin", "superadmin"), removeUsersFromDepartment);
// BB-089: per-employee fixed-hours switches
router.get("/:id/fixed-hours-members", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), getFixedHoursMembers);
router.put("/:id/fixed-hours-members", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), updateFixedHoursMembers);
router.get("/:id/employees", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), getUsersInDepartment);

module.exports = router;
