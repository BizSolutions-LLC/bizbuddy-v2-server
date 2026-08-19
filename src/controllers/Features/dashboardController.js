// src/controllers/Features/dashboardController.js

const { prisma } = require("@config/connection");
const { leaveVisibilityWhere } = require("@utils/leaveUtils");

const getSidebarStats = async (req, res) => {
  try {
    const { companyId } = req.user;

    // Current month range for unscheduled employees
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const requester = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { departmentId: true },
    });

    const [
      totalActiveEmployees,
      employeesWithShifts,
      pendingContestLogs,
      pendingOvertimeRequests,
      pendingLeaveRequests,
      pendingDeletionRequests,
      lockedCutoffPeriods,
      activeSubscription,
    ] = await Promise.all([
      // Total active employees in company
      prisma.user.count({
        where: { companyId, status: "active" },
      }),

      // Employees who have at least one shift this month
      prisma.userShift.findMany({
        where: {
          user: { companyId, status: "active" },
          assignedDate: { gte: monthStart, lte: monthEnd },
        },
        select: { userId: true },
        distinct: ["userId"],
      }),

      // Pending contest logs for company
      prisma.contestTimeLog.count({
        where: {
          status: "PENDING",
          timeLog: { user: { companyId } },
        },
      }),

      // Pending overtime requests for company
      prisma.overtime.count({
        where: { companyId, status: "pending" },
      }),

      // Pending leave requests this management user can see (department-scoped
      // for supervisors, company-wide for admin/superadmin) — includes
      // pending_secondary, previously undercounted here.
      prisma.leave.count({
        where: {
          ...leaveVisibilityWhere(companyId, req.user.role, req.user.id, requester?.departmentId),
          status: { in: ["pending", "pending_secondary"] },
        },
      }),

      // Pending account deletion requests for company
      prisma.accountDeletionRequest.count({
        where: { companyId, status: "pending" },
      }),

      // Locked cutoff periods for company
      prisma.cutoffPeriod.count({
        where: { companyId, status: "locked" },
      }),

      // Active subscription for company
      prisma.subscription.findFirst({
        where: { companyId, active: true },
        orderBy: { createdAt: "desc" },
        select: { endDate: true },
      }),
    ]);

    const unscheduledEmployees = Math.max(0, totalActiveEmployees - employeesWithShifts.length);

    return res.status(200).json({
      data: {
        unscheduledEmployees,
        pendingContestLogs: pendingContestLogs ?? 0,
        pendingOvertimeRequests: pendingOvertimeRequests ?? 0,
        pendingLeaveRequests: pendingLeaveRequests ?? 0,
        pendingDeletionRequests: pendingDeletionRequests ?? 0,
        lockedCutoffPeriods: lockedCutoffPeriods ?? 0,
        subscriptionEndDate: activeSubscription?.endDate ?? null,
      },
    });
  } catch (error) {
    console.error("❌ Error in getSidebarStats:", error);
    // Return zeroed-out data on failure — client should never crash on this endpoint
    return res.status(200).json({
      data: {
        unscheduledEmployees: 0,
        pendingContestLogs: 0,
        pendingOvertimeRequests: 0,
        pendingLeaveRequests: 0,
        pendingDeletionRequests: 0,
        lockedCutoffPeriods: 0,
        subscriptionEndDate: null,
      },
    });
  }
};

module.exports = { getSidebarStats };
