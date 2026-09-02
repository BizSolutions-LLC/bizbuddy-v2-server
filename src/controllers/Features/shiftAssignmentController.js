// src/controllers/Features/shiftAssignmentController.js

const { prisma } = require("@config/connection");
const {
    notifyEmployeeShiftAssigned,
    notifyManagementShiftAssignment,
    notifyEmployeeShiftReplaced,
  } = require("@services/shiftNotificationService");

/**
 * Helper: Check for time overlaps between shifts
 */
function hasTimeOverlap(shift1, shift2) {
  const getMinutes = (time) => {
    const d = new Date(time);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };

  const start1 = getMinutes(shift1.startTime);
  const end1 = getMinutes(shift1.endTime);
  const start2 = getMinutes(shift2.startTime);
  const end2 = getMinutes(shift2.endTime);

  return start1 < end2 && end1 > start2;
}

/**
 * Helper: Check for conflicts
 */
async function checkShiftConflicts(userIds, dates, newShift, companyId) {
  const conflicts = [];

  for (const userId of userIds) {
    for (const date of dates) {
      // Find existing shifts for this user on this date
      const existingShifts = await prisma.userShift.findMany({
        where: {
          userId: userId,
          assignedDate: new Date(date),
        },
        include: {
          shift: true,
          user: {
            select: {
              email: true,
              profile: { select: { firstName: true, lastName: true } },
            },
          },
        },
      });

      for (const existing of existingShifts) {
        // Check time overlap
        const existingStart = existing.customStartTime || existing.shift.startTime;
        const existingEnd = existing.customEndTime || existing.shift.endTime;

        if (
          hasTimeOverlap(
            { startTime: existingStart, endTime: existingEnd },
            newShift
          )
        ) {
          conflicts.push({
            existingShiftId: existing.id,
            userId: userId,
            userName: `${existing.user.profile?.firstName || ""} ${
              existing.user.profile?.lastName || ""
            }`.trim(),
            userEmail: existing.user.email,
            date: date,
            existingShift: {
              name: existing.shift.shiftName,
              start: existingStart,
              end: existingEnd,
            },
            newShift: {
              name: newShift.shiftName,
              start: newShift.startTime,
              end: newShift.endTime,
            },
          });
        }
      }
    }
  }

  return conflicts;
}

/**
 * Assign shifts to employees (simple, direct)
 */
const assignShifts = async (req, res) => {
  try {
    const {
      shiftId,
      userIds, // Array of user IDs
      dates, // Array of date strings: ["2026-02-17", "2026-02-18"]
      replaceConflicts = false,
      notes,
    } = req.body;

    const { companyId, id: assignedBy } = req.user;

    // Validation
    if (!shiftId || !userIds || !dates || userIds.length === 0 || dates.length === 0) {
      return res.status(400).json({
        message: "Missing required fields: shiftId, userIds, dates",
      });
    }

    // Get shift details
    const shift = await prisma.shift.findFirst({
      where: { id: shiftId, companyId },
    });

    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

    // Verify users belong to company
    const users = await prisma.user.findMany({
      where: {
        id: { in: userIds },
        companyId,
        status: "active",
      },
      select: {
        id: true,
        email: true,
        profile: { select: { firstName: true, lastName: true } },
      },
    });

    if (users.length === 0) {
      return res.status(400).json({ message: "No valid users found" });
    }

    // Check for conflicts
    const conflicts = await checkShiftConflicts(
      users.map((u) => u.id),
      dates,
      shift,
      companyId
    );

    // If conflicts exist and user didn't choose to replace
    if (conflicts.length > 0 && !replaceConflicts) {
      return res.status(409).json({
        message: "Shift conflicts detected",
        conflicts: conflicts,
        suggestion: "Set replaceConflicts=true to replace existing shifts",
      });
    }

    // If replacing, delete conflicting shifts first
    if (replaceConflicts && conflicts.length > 0) {
      const conflictIds = conflicts.map((c) => c.existingShiftId);
      await prisma.userShift.deleteMany({
        where: { id: { in: conflictIds } },
      });

      const replacementNotifications = conflicts.map(conflict =>
        notifyEmployeeShiftReplaced({
          user: users.find(u => u.id === conflict.userId),
          oldShift: { 
            id: conflict.existingShift.id, 
            shiftName: conflict.existingShift.name 
          },
          newShift: shift,
          date: conflict.date,
          companyId,
        })
      );
      await Promise.all(replacementNotifications);
    }

    // Create assignments
    const assignments = [];
    for (const date of dates) {
      for (const user of users) {
        assignments.push({
          userId: user.id,
          shiftId: shiftId,
          assignedDate: new Date(date),
          createdFrom: "manual",
          status: "scheduled",
          notes: notes || null,
        });
      }
    }

    const created = await prisma.userShift.createMany({
      data: assignments,
      skipDuplicates: true,
    });

    try {
        // Notify each employee
        const employeeNotifications = users.map(user =>
          notifyEmployeeShiftAssigned({
            user,
            shift,
            dates,
            assignedBy,
            companyId,
          })
        );
  
        // Notify management
        const managementNotification = notifyManagementShiftAssignment({
          companyId,
          shift,
          assignedCount: created.count,
          dates,
          assignmentType: 'individual',
          assignedBy,
        });
  
        await Promise.all([...employeeNotifications, managementNotification]);
      } catch (notifError) {
        console.error('Error sending notifications:', notifError);
        // Don't fail the request if notifications fail
      }

    return res.status(201).json({
      message: "Shifts assigned successfully",
      data: {
        assignedCount: created.count,
        targetUsers: users.length,
        dates: dates.length,
        conflictsResolved: replaceConflicts ? conflicts.length : 0,
      },
    });
  } catch (error) {
    console.error("Error assigning shifts:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Bulk assign to department or all employees
 */
const bulkAssignShifts = async (req, res) => {
  try {
    const {
      shiftId,
      dates,
      assignmentType, // 'department' or 'all'
      departmentId, // Required if assignmentType='department'
      replaceConflicts = false,
      notes,
    } = req.body;

    const { companyId } = req.user;

    // Validation
    if (!shiftId || !dates || dates.length === 0 || !assignmentType) {
      return res.status(400).json({
        message: "Missing required fields: shiftId, dates, assignmentType",
      });
    }

    if (assignmentType === "department" && !departmentId) {
      return res.status(400).json({
        message: "departmentId required for department assignment",
      });
    }

    // Get shift
    const shift = await prisma.shift.findFirst({
      where: { id: shiftId, companyId },
    });

    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

    // Get target users
    let users;
    if (assignmentType === "all") {
      users = await prisma.user.findMany({
        where: { companyId, status: "active" },
        select: {
          id: true,
          email: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      });
    } else {
      // Department
      users = await prisma.user.findMany({
        where: {
          companyId,
          departmentId,
          status: "active",
        },
        select: {
          id: true,
          email: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      });
    }

    if (users.length === 0) {
      return res.status(400).json({ message: "No users found for assignment" });
    }

    // Check conflicts
    const conflicts = await checkShiftConflicts(
      users.map((u) => u.id),
      dates,
      shift,
      companyId
    );

    if (conflicts.length > 0 && !replaceConflicts) {
      return res.status(409).json({
        message: "Shift conflicts detected",
        conflicts: conflicts.slice(0, 10), // Only show first 10
        totalConflicts: conflicts.length,
        suggestion: "Set replaceConflicts=true to replace existing shifts",
      });
    }

    // Replace conflicts if requested
    if (replaceConflicts && conflicts.length > 0) {
      const conflictIds = conflicts.map((c) => c.existingShiftId);
      await prisma.userShift.deleteMany({
        where: { id: { in: conflictIds } },
      });
    }

    // Create assignments
    const assignments = [];
    for (const date of dates) {
      for (const user of users) {
        assignments.push({
          userId: user.id,
          shiftId: shiftId,
          assignedDate: new Date(date),
          createdFrom: "bulk",
          status: "scheduled",
          notes: notes || null,
        });
      }
    }

    const created = await prisma.userShift.createMany({
      data: assignments,
      skipDuplicates: true,
    });

    try {
        // Notify each employee
        const employeeNotifications = users.map(user =>
          notifyEmployeeShiftAssigned({
            user,
            shift,
            dates,
            assignedBy: req.user.id,
            companyId,
          })
        );
  
        // Notify management
        const managementNotification = notifyManagementShiftAssignment({
          companyId,
          shift,
          assignedCount: created.count,
          dates,
          assignmentType,
          assignedBy: req.user.id,
        });
  
        await Promise.all([...employeeNotifications, managementNotification]);
      } catch (notifError) {
        console.error('Error sending notifications:', notifError);
      }

    return res.status(201).json({
      message: "Bulk assignment completed successfully",
      data: {
        assignedCount: created.count,
        targetUsers: users.length,
        dates: dates.length,
        assignmentType,
        conflictsResolved: replaceConflicts ? conflicts.length : 0,
      },
    });
  } catch (error) {
    console.error("Error in bulk assign:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Get shift assignments with filters
 */
const getAssignments = async (req, res) => {
  try {
    const { startDate, endDate, userId, departmentId, status } = req.query;
    const { companyId } = req.user;

    const where = {
      user: { companyId, status: "active" },
    };

    if (startDate || endDate) {
      where.assignedDate = {};
      if (startDate) where.assignedDate.gte = new Date(startDate);
      if (endDate) where.assignedDate.lte = new Date(endDate);
    }

    if (userId) where.userId = userId;
    if (status) where.status = status;
    if (departmentId) where.user.departmentId = departmentId;

    const assignments = await prisma.userShift.findMany({
      where,
      include: {
        shift: true,
        user: {
          select: {
            id: true,
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: [{ assignedDate: "asc" }],
    });

    return res.status(200).json({
      message: "Assignments retrieved successfully",
      data: assignments,
    });
  } catch (error) {
    console.error("Error getting assignments:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Delete shift assignments
 */
const deleteAssignments = async (req, res) => {
  try {
    const { assignmentIds } = req.body;
    const { companyId } = req.user;

    if (!Array.isArray(assignmentIds) || assignmentIds.length === 0) {
      return res.status(400).json({ message: "assignmentIds array required" });
    }

    const deleted = await prisma.userShift.deleteMany({
      where: {
        id: { in: assignmentIds },
        user: { companyId }, // Security check
      },
    });

    return res.status(200).json({
      message: "Assignments deleted successfully",
      deletedCount: deleted.count,
    });
  } catch (error) {
    console.error("Error deleting assignments:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  assignShifts,
  bulkAssignShifts,
  getAssignments,
  deleteAssignments,
  hasTimeOverlap,
};