// src/routes/Features/employeeRoutes.js

const express = require("express");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const { blockSystemAgent, protectSystemAgentTarget } = require("@utils/systemAgent");
const {
  getAllEmployees,
  getMyTeam,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  updateEmployeePresence,
  changeEmployeePassword,
  getEmployeeById,
  bulkCreateEmployees,
} = require("@controllers/Features/employeeController");

router.get("/", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), getAllEmployees);
router.get("/team", authenticate, authorizeRoles("admin", "superadmin", "supervisor"), getMyTeam);
router.post("/bulk", authenticate, authorizeRoles("admin", "superadmin"), bulkCreateEmployees);
router.post("/", authenticate, authorizeRoles("admin", "superadmin"), createEmployee);
router.put("/:id", authenticate, authorizeRoles("admin", "superadmin"), protectSystemAgentTarget(), updateEmployee);
router.delete("/:id", authenticate, authorizeRoles("admin", "superadmin"), protectSystemAgentTarget(), deleteEmployee);
router.put("/me/presence", authenticate, blockSystemAgent, updateEmployeePresence);
router.put("/me/password", authenticate, blockSystemAgent, changeEmployeePassword);
router.get("/:id/detail", authenticate, authorizeRoles("employee", "admin", "superadmin", "supervisor"), getEmployeeById);

module.exports = router;
