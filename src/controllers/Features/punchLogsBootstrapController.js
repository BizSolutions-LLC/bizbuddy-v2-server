// src/controllers/Features/punchLogsBootstrapController.js
//
// Aggregates the mount-time, load-once data for the employee punch-logs page into
// one call. Additive only — the 6 individual endpoints this replaces on web
// (company-settings, employment-details/me, leaves/approvers, account/approver,
// location/assigned, request-punch-log/my-requests) stay unchanged for mobile.
//
// Deliberately excludes:
//  - /api/overtime/threshold-status — live/computed, not load-once
//  - /api/timelogs/user (+ /api/usershifts/) — both re-scope to whatever date
//    range the user has selected, not just the initial mount; folding usershifts
//    in here would go stale the moment a custom date range is applied outside the
//    bootstrap's window.

const { prisma } = require("@config/connection");
const { getVisibleCutoffPeriods } = require("@services/Cutoff/cutoffPeriodVisibilityService");
const { getEligibleApprovers, getDirectSupervisors } = require("@services/Approvers/approverResolutionService");
const { getAssignedLocations } = require("@services/Locations/assignedLocationsService");

const getPunchLogsBootstrap = async (req, res) => {
  try {
    const { id: userId, companyId, role } = req.user;

    const [company, employmentDetail, approversRaw, supervisorsRaw, locations, pendingRequests] = await Promise.all([
      prisma.company.findFirst({
        where: { id: companyId },
        select: {
          id: true,
          defaultShiftHours: true,
          minimumLunchMinutes: true,
          otBasis: true,
          dailyOtThresholdHours: true,
          weeklyOtThresholdHours: true,
          cutoffOtThresholdHours: true,
          timeZone: true,
        },
      }),
      prisma.employmentDetail.findUnique({
        where: { userId },
        select: { departmentId: true, department: { select: { id: true, name: true } } },
      }),
      getEligibleApprovers({ id: userId, companyId }),
      getDirectSupervisors({ id: userId, companyId }),
      getAssignedLocations(userId),
      prisma.requestedTimeLog.findMany({
        where: { userId, status: "PENDING" },
        select: {
          id: true,
          status: true,
          requestedDate: true,
          estimatedNetHours: true,
          description: true,
          submittedAt: true,
          requestedClockIn: true,
          requestedClockOut: true,
          reason: true,
          approver: { select: { email: true, profile: { select: { firstName: true, lastName: true } } } },
        },
        orderBy: { submittedAt: "desc" },
        take: 10,
      }),
    ]);

    const cutoffPeriods = await getVisibleCutoffPeriods({
      companyId,
      role,
      departmentId: employmentDetail?.departmentId,
    });

    return res.status(200).json({
      data: {
        companySettings: company && {
          id: company.id,
          defaultShiftHours: company.defaultShiftHours,
          minimumLunchMinutes: company.minimumLunchMinutes,
          otBasis: company.otBasis,
          dailyOtThresholdHours: company.dailyOtThresholdHours,
          weeklyOtThresholdHours: company.weeklyOtThresholdHours,
          cutoffOtThresholdHours: company.cutoffOtThresholdHours,
          timezone: company.timeZone,
        },
        employmentDetails: {
          departmentId: employmentDetail?.departmentId ?? null,
          department: employmentDetail?.department ?? null,
        },
        cutoffPeriods,
        approvers: approversRaw.map(({ id, name, email, role }) => ({ id, name, email, role })),
        supervisors: (supervisorsRaw || []).map(({ id, name, jobTitle, role }) => ({ id, name, jobTitle, role })),
        locations,
        pendingRequests,
      },
    });
  } catch (error) {
    console.error("❌ getPunchLogsBootstrap:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

module.exports = { getPunchLogsBootstrap };
