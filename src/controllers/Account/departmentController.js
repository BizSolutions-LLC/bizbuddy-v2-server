// src/controllers/Account/departmentController.js

const { prisma } = require("@config/connection");

const createDepartment = async (req, res) => {
  try {
    let { name, supervisorId, paidBreak } = req.body;
    const companyId = req.user.companyId;

    // Validate required fields
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Department name is required." });
    }

    name = name.trim();

    const existingDept = await prisma.department.findFirst({
      where: { 
        companyId, 
        name: { equals: name, mode: "insensitive" } 
      },
    });

    if (existingDept) {
      return res.status(409).json({ error: "A department with this name already exists." });
    }

    // Validate supervisor if provided
    if (supervisorId && supervisorId !== "none" && supervisorId !== "") {
      const supervisor = await prisma.user.findFirst({
        where: { 
          id: supervisorId, 
          companyId, 
          role: "supervisor" 
        },
      });

      if (!supervisor) {
        return res.status(400).json({ error: "Invalid supervisor ID." });
      }
    }

    // Prepare department data
    const departmentData = {
      name,
      companyId,
      paidBreak: Boolean(paidBreak), // Ensure boolean value, default to false if not provided
    };

    // Add supervisor if valid
    if (supervisorId && supervisorId !== "none" && supervisorId !== "") {
      departmentData.supervisorId = supervisorId;
    }

    // Create the department
    const newDepartment = await prisma.department.create({
      data: departmentData,
      include: {
        supervisor: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                firstName: true,
                lastName: true
              }
            }
          }
        }
      }
    });

    return res.status(201).json({ 
      data: newDepartment, 
      message: "Department created successfully." 
    });

  } catch (error) {
    console.error("Error in createDepartment:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * GET /api/departments/all
 * Retrieves all departments for the current company.
 */
const getAllDepartments = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(400).json({ error: "No company associated with the user." });
    }
    const departments = await prisma.department.findMany({
      where: { companyId },
      include: {
        supervisor: {
          select: {
            id: true,
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        users: {
          select: {
            id: true,
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        _count: { select: { users: true } },
      },
    });
    return res.status(200).json({ data: departments, message: "Departments retrieved successfully." });
  } catch (error) {
    console.error("Error in getAllDepartments:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * GET /api/departments/:id
 * Retrieves a department by its ID.
 */
const getDepartmentById = async (req, res) => {
  try {
    const departmentId = req.params.id;
    const companyId = req.user.companyId;
    if (!departmentId) {
      return res.status(400).json({ error: "Invalid department ID." });
    }
    const department = await prisma.department.findFirst({
      where: { id: departmentId, companyId },
      include: {
        supervisor: { select: { id: true, firstName: true, lastName: true, email: true } },
        users: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    if (!department) {
      return res.status(404).json({ error: "Department not found." });
    }
    return res.status(200).json({ data: department, message: "Department retrieved successfully." });
  } catch (error) {
    console.error("Error in getDepartmentById:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * PUT /api/departments/update/:id
 * Updates an existing department.
 */
const updateDepartment = async (req, res) => {
  try {
    const departmentId = req.params.id;
    let {
      name,
      supervisorId,
      paidBreak,
      coffeeBreakMaxCount,
      coffeeBreakMinutes,
      coffeeBreakPaid,
      autoLunchEntitled,
      autoBreakLunchMinutes,
      autoBreakLunchAfterHours,
      autoBreakLunchDeductible,
      autoCoffeeEntitled,
      autoBreakCoffeeMinutes,
      autoBreakCoffeeCount,
      autoBreakCoffeeDeductible,
      fixedHoursEnabled,
      fixedHoursPerCutoff,
    } = req.body;
    const companyId = req.user.companyId;

    if (!departmentId) {
      return res.status(400).json({ error: "Invalid department ID." });
    }

    const department = await prisma.department.findFirst({ 
      where: { id: departmentId, companyId } 
    });
    
    if (!department) {
      return res.status(404).json({ error: "Department not found." });
    }

    // Name validation (if name is being updated)
    if (name) {
      name = name.trim();
      const duplicateDept = await prisma.department.findFirst({
        where: { 
          companyId, 
          name: { equals: name, mode: "insensitive" }, 
          NOT: { id: departmentId } 
        },
      });
      if (duplicateDept) {
        return res.status(409).json({ error: "Another department with this name exists." });
      }
    }

    // Supervisor validation (if supervisor is being updated)
    if (supervisorId !== undefined && supervisorId !== null && supervisorId !== "" && supervisorId !== "none") {
      const supervisor = await prisma.user.findFirst({
        where: { id: supervisorId, companyId, role: "supervisor" },
      });
      if (!supervisor) {
        return res.status(400).json({ error: "Invalid supervisor ID." });
      }
    }

    // Prepare update data - only include fields that are being updated
    const updateData = {};
    
    if (name !== undefined) {
      updateData.name = name;
    }
    
    if (supervisorId !== undefined) {
      if (supervisorId === null || supervisorId === "" || supervisorId === "none") {
        updateData.supervisorId = null;
      } else {
        updateData.supervisorId = supervisorId;
      }
    }
    
    if (paidBreak !== undefined) {
      updateData.paidBreak = Boolean(paidBreak);
    }

    if (coffeeBreakMaxCount !== undefined && coffeeBreakMaxCount !== null) {
      const val = Number(coffeeBreakMaxCount);
      if (!Number.isInteger(val) || val < 0 || val > 5) {
        return res.status(400).json({ error: "coffeeBreakMaxCount must be an integer between 0 and 5." });
      }
      updateData.coffeeBreakMaxCount = val;
    }

    if (coffeeBreakMinutes !== undefined && coffeeBreakMinutes !== null) {
      const val = Number(coffeeBreakMinutes);
      if (!Number.isInteger(val) || val < 0 || val > 30) {
        return res.status(400).json({ error: "coffeeBreakMinutes must be an integer between 0 and 30." });
      }
      updateData.coffeeBreakMinutes = val;
    }

    if (coffeeBreakPaid !== undefined) {
      updateData.coffeeBreakPaid = Boolean(coffeeBreakPaid);
    }

    if (autoLunchEntitled !== undefined) {
      updateData.autoLunchEntitled = Boolean(autoLunchEntitled);
    }

    if (autoBreakLunchMinutes !== undefined && autoBreakLunchMinutes !== null) {
      const val = Math.max(1, parseInt(autoBreakLunchMinutes) || 60);
      updateData.autoBreakLunchMinutes = val;
    }

    if (autoBreakLunchAfterHours !== undefined && autoBreakLunchAfterHours !== null) {
      const val = Math.max(0.5, parseFloat(autoBreakLunchAfterHours) || 4);
      updateData.autoBreakLunchAfterHours = val;
    }

    if (autoBreakLunchDeductible !== undefined) {
      updateData.autoBreakLunchDeductible = Boolean(autoBreakLunchDeductible);
    }

    if (autoCoffeeEntitled !== undefined) {
      updateData.autoCoffeeEntitled = Boolean(autoCoffeeEntitled);
    }

    if (autoBreakCoffeeMinutes !== undefined && autoBreakCoffeeMinutes !== null) {
      const val = Math.max(1, parseInt(autoBreakCoffeeMinutes) || 15);
      updateData.autoBreakCoffeeMinutes = val;
    }

    if (autoBreakCoffeeCount !== undefined && autoBreakCoffeeCount !== null) {
      const val = Math.min(10, Math.max(1, parseInt(autoBreakCoffeeCount) || 1));
      updateData.autoBreakCoffeeCount = val;
    }

    if (autoBreakCoffeeDeductible !== undefined) {
      updateData.autoBreakCoffeeDeductible = Boolean(autoBreakCoffeeDeductible);
    }

    // BB-089: fixed-hours department (e.g. SV = 80h per cutoff)
    if (fixedHoursEnabled !== undefined) {
      updateData.fixedHoursEnabled = Boolean(fixedHoursEnabled);
    }

    if (fixedHoursPerCutoff !== undefined && fixedHoursPerCutoff !== null) {
      const val = Number(fixedHoursPerCutoff);
      if (!Number.isFinite(val) || val <= 0 || val > 999) {
        return res.status(400).json({ error: "fixedHoursPerCutoff must be a number greater than 0 and at most 999." });
      }
      updateData.fixedHoursPerCutoff = val.toFixed(2);
    }

    const updatedDepartment = await prisma.department.update({
      where: { id: departmentId },
      data: updateData,
      include: {
        supervisor: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                firstName: true,
                lastName: true
              }
            }
          }
        }
      }
    });

    return res.status(200).json({ 
      data: updatedDepartment, 
      message: "Department updated successfully." 
    });
  } catch (error) {
    console.error("Error in updateDepartment:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * DELETE /api/departments/delete/:id
 * Deletes a department.
 */
const deleteDepartment = async (req, res) => {
  try {
    const departmentId = req.params.id;
    const companyId = req.user.companyId;
    if (!departmentId) {
      return res.status(400).json({ error: "Invalid department ID." });
    }
    const department = await prisma.department.findFirst({ where: { id: departmentId, companyId } });
    if (!department) {
      return res.status(404).json({ error: "Department not found." });
    }
    await prisma.department.delete({ where: { id: departmentId } });
    return res.status(200).json({ message: "Department deleted successfully." });
  } catch (error) {
    console.error("Error in deleteDepartment:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * PUT /api/departments/:id/assign-users
 * Assigns a list of users to a department.
 */
const assignUsersToDepartment = async (req, res) => {
  try {
    const departmentId = req.params.id;
    const { userIds } = req.body;
    const companyId = req.user.companyId;
    const requesterRole = req.user.role;
    const requesterId = req.user.id;
    if (!departmentId) {
      return res.status(400).json({ error: "Invalid department ID." });
    }
    const department = await prisma.department.findFirst({ where: { id: departmentId, companyId } });
    if (!department) {
      return res.status(404).json({ error: "Department not found." });
    }
    if (requesterRole === "supervisor" && department.supervisorId !== requesterId) {
      return res.status(403).json({ error: "You are not authorized to assign users for this department." });
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: "A non-empty array of user IDs is required." });
    }
    const validUsers = await prisma.user.findMany({
      where: { id: { in: userIds }, companyId, role: { not: "superadmin" } },
      select: { id: true },
    });
    const validUserIds = validUsers.map((user) => user.id);
    const invalidUserIds = userIds.filter((id) => !validUserIds.includes(id));
    if (invalidUserIds.length > 0) {
      return res.status(400).json({ error: `Users with IDs ${invalidUserIds.join(", ")} were not found.` });
    }
    await prisma.user.updateMany({
      where: { id: { in: validUserIds }, companyId },
      data: { departmentId },
    });
    // Removed auto‑assignment of supervisor to avoid interfering with regular member assignment.
    return res.status(200).json({ data: { assignedUserIds: validUserIds }, message: "Users assigned successfully." });
  } catch (error) {
    console.error("Error in assignUsersToDepartment:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * PUT /api/departments/:id/remove-users
 * Removes a list of users from a department.
 */
const removeUsersFromDepartment = async (req, res) => {
  try {
    const departmentId = req.params.id;
    const { userIds } = req.body;
    const companyId = req.user.companyId;
    if (!departmentId) {
      return res.status(400).json({ error: "Invalid department ID." });
    }
    const department = await prisma.department.findFirst({ where: { id: departmentId, companyId } });
    if (!department) {
      return res.status(404).json({ error: "Department not found." });
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: "A non-empty array of user IDs is required." });
    }
    const assignedUsers = await prisma.user.findMany({
      where: { id: { in: userIds }, departmentId, companyId },
      select: { id: true },
    });
    const assignedUserIds = assignedUsers.map((user) => user.id);
    const notAssignedUserIds = userIds.filter((id) => !assignedUserIds.includes(id));
    if (notAssignedUserIds.length > 0) {
      return res.status(400).json({ error: `Users with IDs ${notAssignedUserIds.join(", ")} are not assigned to this department.` });
    }
    await prisma.user.updateMany({
      where: { id: { in: assignedUserIds }, companyId },
      data: { departmentId: null },
    });
    return res.status(200).json({ data: { removedUserIds: assignedUserIds }, message: "Users removed successfully." });
  } catch (error) {
    console.error("Error in removeUsersFromDepartment:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * GET /api/departments/:id/users
 * Retrieves all users assigned to a department.
 */
const getUsersInDepartment = async (req, res) => {
  try {
    const departmentId = req.params.id;
    const companyId = req.user.companyId;
    if (!departmentId) {
      return res.status(400).json({ error: "Invalid department ID." });
    }
    const department = await prisma.department.findFirst({ where: { id: departmentId, companyId } });
    if (!department) {
      return res.status(404).json({ error: "Department not found." });
    }
    const users = await prisma.user.findMany({
      where: { departmentId, companyId },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: { id: "asc" },
    });
    return res.status(200).json({ data: users, message: "Users retrieved successfully." });
  } catch (error) {
    console.error("Error in getUsersInDepartment:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * GET /api/departments/:id/fixed-hours-members
 * BB-089: the department's employees with their own fixed-hours switch. An
 * employee is only paid fixed hours while the department's master switch
 * (fixedHoursEnabled) is also on.
 */
const getFixedHoursMembers = async (req, res) => {
  try {
    const departmentId = req.params.id;
    const companyId = req.user.companyId;

    const department = await prisma.department.findFirst({
      where: { id: departmentId, companyId },
      select: { id: true, name: true, fixedHoursEnabled: true, fixedHoursPerCutoff: true },
    });
    if (!department) {
      return res.status(404).json({ error: "Department not found." });
    }

    const users = await prisma.user.findMany({
      where: { departmentId, companyId, status: { not: "deleted" } },
      select: {
        id: true,
        email: true,
        employeeId: true,
        role: true,
        status: true,
        fixedHoursEnabled: true,
        profile: { select: { firstName: true, lastName: true } },
      },
    });

    const members = users
      .map((u) => ({
        userId:            u.id,
        firstName:         u.profile?.firstName || "",
        lastName:          u.profile?.lastName || "",
        email:             u.email,
        employeeId:        u.employeeId,
        role:              u.role,
        status:            u.status,
        fixedHoursEnabled: u.fixedHoursEnabled,
        // what actually applies right now — both switches on and user active
        isOnFixedHours:    department.fixedHoursEnabled && u.fixedHoursEnabled && u.status === "active",
      }))
      .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

    return res.status(200).json({
      data: { department, members },
      message: "Fixed-hours members retrieved successfully.",
    });
  } catch (error) {
    console.error("Error in getFixedHoursMembers:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/**
 * PUT /api/departments/:id/fixed-hours-members
 * BB-089: turn fixed hours on/off for one or more employees of this department.
 * Body: { userIds: string[], enabled: boolean }
 * Open cutoffs pick the change up on their next review load / lock / finalize.
 */
const updateFixedHoursMembers = async (req, res) => {
  try {
    const departmentId = req.params.id;
    const companyId = req.user.companyId;
    const { userIds, enabled } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0 || !userIds.every((id) => typeof id === "string")) {
      return res.status(400).json({ error: "userIds must be a non-empty array of user IDs." });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false." });
    }

    const department = await prisma.department.findFirst({ where: { id: departmentId, companyId } });
    if (!department) {
      return res.status(404).json({ error: "Department not found." });
    }

    const uniqueIds = [...new Set(userIds)];
    const users = await prisma.user.findMany({
      where: { id: { in: uniqueIds }, departmentId, companyId },
      select: { id: true },
    });
    if (users.length !== uniqueIds.length) {
      const found = new Set(users.map((u) => u.id));
      const invalid = uniqueIds.filter((id) => !found.has(id));
      return res.status(400).json({ error: `Users not in this department: ${invalid.join(", ")}.` });
    }

    const result = await prisma.user.updateMany({
      where: { id: { in: uniqueIds } },
      data: { fixedHoursEnabled: enabled },
    });

    return res.status(200).json({
      data: { updatedCount: result.count, userIds: uniqueIds, fixedHoursEnabled: enabled },
      message: `Fixed hours ${enabled ? "enabled" : "disabled"} for ${result.count} employee(s).`,
    });
  } catch (error) {
    console.error("Error in updateFixedHoursMembers:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

module.exports = {
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
};
