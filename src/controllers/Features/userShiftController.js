// src/controllers/Features/userShiftController.js

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { buildOtProjection } = require("@services/Schedules/otProjectionService"); // BB-135

// Existing: Get current user's shifts
const getUserShifts = async (req, res) => {
  try {
    const userId = req.user.id;
    const userShifts = await prisma.userShift.findMany({
      where: { userId },
      include: {
        shift: true,
      },
      orderBy: { assignedDate: "desc" },
    });
    
    const formattedShifts = userShifts.map((shift) => ({
      ...shift,
      assignedDate: shift.assignedDate.toISOString().slice(0, 10),
      shift: {
        ...shift.shift,
        startTime: shift.shift.startTime.toISOString(),
        endTime: shift.shift.endTime.toISOString(),
      },
    }));

    return res.status(200).json({
      message: "User shifts retrieved successfully.",
      data: formattedShifts 
    });
  } catch (error) {
    console.error("Error fetching user shifts:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// Existing: Get company employees (with role check added)
const getCompanyEmployees = async (req, res) => {
  try {
    const { companyId, role } = req.user;
    
    const whereClause = { 
      ...HUMAN_ONLY,
      companyId,
      status: 'active' // Only active employees
    };

    // Get current month date range
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const employees = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        email: true,
        role: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
          }
        },
        // Include shift count for current month
        UserShift: {
          where: {
            assignedDate: {
              gte: monthStart,
              lte: monthEnd
            }
          },
          select: {
            id: true
          }
        }
      },
      orderBy: [
        { profile: { firstName: 'asc' } },
        { email: 'asc' }
      ],
    });

    // Transform data to include shift count
    const employeesWithShiftCount = employees.map(emp => ({
      id: emp.id,
      email: emp.email,
      role: emp.role,
      profile: emp.profile,
      shiftCount: emp.UserShift.length,
      hasShifts: emp.UserShift.length > 0
    }));
    
    return res.status(200).json({
      message: "Company employees retrieved successfully.",
      data: employeesWithShiftCount,
    });
  } catch (error) {
    console.error("Error fetching company employees:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// NEW: Get specific employee's shifts
const getEmployeeShifts = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { companyId, role, id: requesterId } = req.user;

    // Verify employee belongs to same company
    const employee = await prisma.user.findUnique({
      where: { id: employeeId }, // ✅ Just use employeeId directly (it's already a string)
      select: { 
        companyId: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
          }
        }
      }
    });

    if (!employee) {
      return res.status(404).json({ message: "Employee not found." });
    }

    if (employee.companyId !== companyId) {
      return res.status(403).json({ message: "Access denied. Employee not in your company." });
    }

    // Fetch shifts
    const userShifts = await prisma.userShift.findMany({
      where: { userId: employeeId }, // ✅ No parseInt
      include: {
        shift: true,
      },
      orderBy: { assignedDate: "desc" },
    });

    const formattedShifts = userShifts.map((shift) => ({
      ...shift,
      assignedDate: shift.assignedDate.toISOString().slice(0, 10),
      shift: {
        ...shift.shift,
        startTime: shift.shift.startTime.toISOString(),
        endTime: shift.shift.endTime.toISOString(),
      },
    }));

    return res.status(200).json({
      message: "Employee shifts retrieved successfully.",
      data: {
        employee: {
          id: employeeId, // ✅ No parseInt
          name: `${employee.profile?.firstName || ''} ${employee.profile?.lastName || ''}`.trim(),
        },
        shifts: formattedShifts,
      }
    });
  } catch (error) {
    console.error("Error fetching employee shifts:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// NEW: Get shifts for multiple employees (for comparison view)
const getBulkEmployeeShifts = async (req, res) => {
  try {
    const { employeeIds, startDate, endDate } = req.body;
    const { companyId, role, id: requesterId } = req.user;

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ message: "employeeIds array is required." });
    }

    if (employeeIds.length > 10) {
      return res.status(400).json({ message: "Maximum 10 employees can be fetched at once." });
    }

    // Verify all employees belong to same company
    const employees = await prisma.user.findMany({
      where: {
        ...HUMAN_ONLY,
        id: { in: employeeIds }, // ✅ No parseInt - employeeIds are already strings
        companyId,
      },
      select: {
        id: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
          }
        }
      }
    });

    if (employees.length !== employeeIds.length) {
      return res.status(403).json({ message: "One or more employees not found or not in your company." });
    }

    // Build date filter
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    // Fetch shifts for all employees
    const whereClause = {
      userId: { in: employeeIds }, // ✅ No parseInt
    };
    if (Object.keys(dateFilter).length > 0) {
      whereClause.assignedDate = dateFilter;
    }

    const userShifts = await prisma.userShift.findMany({
      where: whereClause,
      include: {
        shift: true,
        user: {
          select: {
            id: true,
            profile: {
              select: {
                firstName: true,
                lastName: true,
              }
            }
          }
        }
      },
      orderBy: [
        { userId: 'asc' },
        { assignedDate: 'asc' }
      ],
    });

    // Group by employee
    const shiftsGrouped = {};
    employees.forEach(emp => {
      shiftsGrouped[emp.id] = {
        employee: {
          id: emp.id,
          name: `${emp.profile?.firstName || ''} ${emp.profile?.lastName || ''}`.trim(),
        },
        shifts: []
      };
    });

    userShifts.forEach(shift => {
      if (shiftsGrouped[shift.userId]) {
        shiftsGrouped[shift.userId].shifts.push({
          ...shift,
          assignedDate: shift.assignedDate.toISOString().slice(0, 10),
          shift: {
            ...shift.shift,
            startTime: shift.shift.startTime.toISOString(),
            endTime: shift.shift.endTime.toISOString(),
          },
          user: undefined,
        });
      }
    });

    return res.status(200).json({
      message: "Bulk employee shifts retrieved successfully.",
      data: Object.values(shiftsGrouped),
    });
  } catch (error) {
    console.error("Error fetching bulk employee shifts:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// BB-135: GET /api/usershifts/range?from=YYYY-MM-DD&to=YYYY-MM-DD[&departmentId=]
// Every human employee's shifts in the company for a date range (Schedules List
// sheet view). Flat list, same row format as /employee/:employeeId. All statuses,
// cancelled included (the client hides them). Supervisors see the whole company,
// the same as the other schedule endpoints.
const RANGE_MAX_DAYS = 62;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRangeDay(value) {
  if (typeof value !== "string" || !DAY_RE.test(value)) return null;
  // UTC midnight matches the @db.Date column exactly (no time-zone shift).
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

const getShiftsInRange = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { from, to, departmentId, includeOt } = req.query;
    // BB-135 Roster OT warning: "1" / "true" turns it on; anything else = off.
    const wantOt = ["1", "true"].includes(String(includeOt ?? "").toLowerCase());

    const fromDate = parseRangeDay(from);
    const toDate = parseRangeDay(to);
    if (!fromDate || !toDate) {
      return res.status(400).json({ message: "from and to are required as YYYY-MM-DD." });
    }
    if (toDate < fromDate) {
      return res.status(400).json({ message: "to must be on or after from." });
    }
    const days = Math.round((toDate - fromDate) / 86400000) + 1;
    if (days > RANGE_MAX_DAYS) {
      return res.status(400).json({ message: `The range can be at most ${RANGE_MAX_DAYS} days.` });
    }

    if (departmentId) {
      const department = await prisma.department.findFirst({
        where: { id: String(departmentId), companyId },
        select: { id: true },
      });
      if (!department) {
        return res.status(403).json({ message: "Access denied. Department not in your company." });
      }
    }

    const userShifts = await prisma.userShift.findMany({
      where: {
        assignedDate: { gte: fromDate, lte: toDate },
        user: {
          ...HUMAN_ONLY,
          companyId,
          ...(departmentId && { departmentId: String(departmentId) }),
        },
      },
      include: { shift: true },
      orderBy: [{ userId: "asc" }, { assignedDate: "asc" }, { shift: { startTime: "asc" } }],
    });

    const data = userShifts.map((us) => ({
      ...us,
      assignedDate: us.assignedDate.toISOString().slice(0, 10),
      customStartTime: us.customStartTime ? us.customStartTime.toISOString() : null,
      customEndTime: us.customEndTime ? us.customEndTime.toISOString() : null,
      shift: {
        ...us.shift,
        startTime: us.shift.startTime.toISOString(),
        endTime: us.shift.endTime.toISOString(),
      },
    }));

    const body = { message: "User shifts retrieved successfully.", data };
    if (wantOt) {
      body.otProjection = await buildOtProjection({
        companyId,
        from,
        to,
        departmentId: departmentId ? String(departmentId) : null,
      });
    }
    return res.status(200).json(body);
  } catch (error) {
    console.error("[BB-135] Error fetching shifts in range:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getCompanyScheduleStats = async (req, res) => {
  try {
    const { companyId } = req.user;

    // Get all active employees in the company
    const totalEmployees = await prisma.user.count({
      where: { 
        ...HUMAN_ONLY,
        companyId,
        status: 'active' // Only count active employees
      }
    });

    // Get current month date range
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // Get unique employees who have shifts this month
    const employeesWithShifts = await prisma.userShift.findMany({
      where: {
        user: { 
          companyId,
          status: 'active'
        },
        assignedDate: {
          gte: monthStart,
          lte: monthEnd
        }
      },
      select: {
        userId: true
      },
      distinct: ['userId']
    });

    const employeesWithShiftsCount = employeesWithShifts.length;
    const employeesWithoutShiftsCount = totalEmployees - employeesWithShiftsCount;

    // Get total shifts count for this month
    const totalShiftsThisMonth = await prisma.userShift.count({
      where: {
        user: { 
          companyId,
          status: 'active'
        },
        assignedDate: {
          gte: monthStart,
          lte: monthEnd
        }
      }
    });

    // Calculate coverage percentage
    const coverageRate = totalEmployees > 0 
      ? ((employeesWithShiftsCount / totalEmployees) * 100).toFixed(1) 
      : '0.0';

    return res.status(200).json({
      message: "Company schedule stats retrieved successfully.",
      data: {
        totalEmployees,
        withShifts: employeesWithShiftsCount,
        withoutShifts: employeesWithoutShiftsCount,
        totalShiftsThisMonth,
        coverage: parseFloat(coverageRate),
        month: monthStart.toISOString(),
      }
    });
  } catch (error) {
    console.error("Error fetching company schedule stats:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};


const updateUserShift = async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId } = req.user;
    const { shiftId } = req.body;

    if (!shiftId) {
      return res.status(400).json({ message: "shiftId is required." });
    }

    const userShift = await prisma.userShift.findUnique({
      where: { id },
      select: { id: true, user: { select: { companyId: true } } },
    });

    if (!userShift) {
      return res.status(404).json({ message: "Shift assignment not found." });
    }

    if (userShift.user.companyId !== companyId) {
      return res.status(403).json({ message: "Access denied." });
    }

    const shift = await prisma.shift.findFirst({ where: { id: shiftId, companyId } });

    if (!shift) {
      return res.status(400).json({ message: "Shift not found." });
    }

    const updated = await prisma.userShift.update({
      where: { id },
      data: { shiftId },
      include: { shift: true },
    });

    return res.status(200).json({
      message: "Shift updated successfully.",
      data: {
        ...updated,
        assignedDate: updated.assignedDate.toISOString().slice(0, 10),
        shift: {
          ...updated.shift,
          startTime: updated.shift.startTime.toISOString(),
          endTime: updated.shift.endTime.toISOString(),
        },
      },
    });
  } catch (error) {
    console.error("Error updating user shift:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const deleteUserShift = async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId } = req.user;

    const userShift = await prisma.userShift.findUnique({
      where: { id },
      select: { id: true, user: { select: { companyId: true } } },
    });

    if (!userShift) {
      return res.status(404).json({ message: "Shift assignment not found." });
    }

    if (userShift.user.companyId !== companyId) {
      return res.status(403).json({ message: "Access denied." });
    }

    await prisma.userShift.delete({ where: { id } });

    return res.status(200).json({
      message: "Shift removed successfully.",
      data: { id },
    });
  } catch (error) {
    console.error("Error deleting user shift:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = {
  getUserShifts,
  getCompanyEmployees,
  getEmployeeShifts,
  getBulkEmployeeShifts,
  getCompanyScheduleStats,
  getShiftsInRange, // BB-135
  updateUserShift,
  deleteUserShift,
};