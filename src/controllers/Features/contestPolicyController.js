const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");

// BB-123: guard requested times. The server only sees two instants, so it can
// reject impossible requests (backwards, 24h+) but not a plausible wrong-zone one.
const MAX_CONTEST_SHIFT_MS = 24 * 60 * 60 * 1000;

/** Returns an error message, or null when the requested times are acceptable. */
function validateRequestedTimes(clockIn, clockOut) {
  const inDate  = new Date(clockIn);
  const outDate = new Date(clockOut);
  if (Number.isNaN(inDate.getTime()) || Number.isNaN(outDate.getTime())) {
    return "Requested clock-in and clock-out must be valid dates.";
  }
  if (outDate <= inDate) {
    return "Requested clock-out must be after the requested clock-in. For an overnight shift, the clock-out falls on the next day.";
  }
  if (outDate - inDate >= MAX_CONTEST_SHIFT_MS) {
    return "Requested shift must be shorter than 24 hours.";
  }
  return null;
}

// BB-123: a contest may not touch a locked/processed cutoff. Approving one changes
// the TimeLog but never the reviewed TimeLogApproval rows, which left stale hours
// in a locked cutoff (Robert Ramirez, PadPro, Oct 2026).
const LOCKED_CUTOFF_STATUSES = ["locked", "processed"];

function fmtPeriod(p) {
  // periodStart/periodEnd are stored as UTC-midnight calendar dates
  const f = (d) => moment.utc(d).format("MMM D, YYYY");
  return `${f(p.periodStart)} – ${f(p.periodEnd)}`;
}

/**
 * Returns the locked/processed CutoffPeriod that blocks this contest, or null.
 * Checks (1) the cutoff the time log is already reviewed in, and (2) the cutoff
 * covering the recorded and requested clock-in dates (company zone) for the
 * employee's department or company-wide, so a punch can't be moved into or out
 * of a locked period.
 */
async function findLockedCutoffForContest(timeLogId, requestedClockIn) {
  const viaApproval = await prisma.timeLogApproval.findFirst({
    where: {
      timeLogId,
      cutoffPeriod: { status: { in: LOCKED_CUTOFF_STATUSES } },
    },
    select: { cutoffPeriod: { select: { id: true, status: true, periodStart: true, periodEnd: true } } },
  });
  if (viaApproval?.cutoffPeriod) return viaApproval.cutoffPeriod;

  const log = await prisma.timeLog.findUnique({
    where: { id: timeLogId },
    select: {
      timeIn: true,
      user: { select: { companyId: true, departmentId: true, company: { select: { timeZone: true } } } },
    },
  });
  if (!log?.user?.companyId) return null;

  const tz = log.user.company?.timeZone && moment.tz.zone(log.user.company.timeZone)
    ? log.user.company.timeZone
    : "America/Los_Angeles";

  const dates = [log.timeIn, requestedClockIn].filter(Boolean);
  for (const d of dates) {
    // Calendar day in the company zone; periodStart/End are UTC-midnight dates.
    const day = moment(d).tz(tz).format("YYYY-MM-DD");
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const period = await prisma.cutoffPeriod.findFirst({
      where: {
        companyId: log.user.companyId,
        status: { in: LOCKED_CUTOFF_STATUSES },
        OR: [{ departmentId: log.user.departmentId || null }, { departmentId: null }],
        periodStart: { lte: dayDate },
        periodEnd:   { gte: dayDate },
      },
      select: { id: true, status: true, periodStart: true, periodEnd: true },
    });
    if (period) return period;
  }
  return null;
}

const submitContestPolicy = async (req, res) => {
  try {
    const {
      timeLogId,
      approverId,
      reason,
      description,
      currentClockIn,
      currentClockOut,
      requestedClockIn,
      requestedClockOut,
      submittedAt,
    } = req.body;

    if (!timeLogId || !requestedClockIn || !requestedClockOut) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const timesError = validateRequestedTimes(requestedClockIn, requestedClockOut);
    if (timesError) {
      return res.status(400).json({ message: timesError });
    }

    const lockedCutoff = await findLockedCutoffForContest(timeLogId, requestedClockIn);
    if (lockedCutoff) {
      return res.status(400).json({
        code: "CUTOFF_LOCKED",
        message: `This punch is in a ${lockedCutoff.status} cutoff period (${fmtPeriod(lockedCutoff)}), so it can't be contested. Please contact your admin.`,
      });
    }

    // BB-123: one pending contest per punch. A second one could be approved after
    // the first and silently overwrite it. Rejected/approved contests don't block.
    const pendingContest = await prisma.contestTimeLog.findFirst({
      where:  { timeLogId, status: "PENDING" },
      select: { id: true, submittedAt: true },
    });
    if (pendingContest) {
      return res.status(400).json({
        code: "CONTEST_PENDING",
        message: "A contest for this punch is already pending. Wait for a decision, or ask your approver to reject it before filing a new one.",
        contestId: pendingContest.id,
      });
    }

    const newContest = await prisma.contestTimeLog.create({
      data: {
        timeLogId,
        approverId,
        reason,
        description,
        currentClockIn: currentClockIn ? new Date(currentClockIn) : null,
        currentClockOut: currentClockOut ? new Date(currentClockOut) : null,
        requestedClockIn: new Date(requestedClockIn),
        requestedClockOut: new Date(requestedClockOut),
        submittedAt: submittedAt ? new Date(submittedAt) : new Date(),
        requestDate: new Date(),
        status: "PENDING",
      },
    });

    console.log("[✅ Contest created]", newContest);

    return res.status(201).json({
      message: "Contest submitted successfully.",
      data: newContest,
    });
  } catch (error) {
    console.error("❌ Error submitting contest:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

const viewContestTimeLogs = async (req, res) => {
    try {
      const user = req.user;
      const { status, limit = 50, offset = 0 } = req.query;
  
      // Always restrict to current user's own records
      let where = {
        timeLog: { userId: user.id },
      };
  
      // Optional status filtering
      if (status && status !== "ALL") {
        where.status = status;
      }
  
      const contestLogs = await prisma.contestTimeLog.findMany({
        where,
        include: {
          timeLog: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  profile: {
                    select: { firstName: true, lastName: true },
                  },
                },
              },
            },
          },
          approver: {
            select: {
              id: true,
              email: true,
              profile: {
                select: { firstName: true, lastName: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: parseInt(limit),
        skip: parseInt(offset),
      });
  
      const totalCount = await prisma.contestTimeLog.count({ where });
  
      return res.status(200).json({
        message: "Contest logs fetched successfully.",
        data: {
          contestLogs,
          pagination: {
            total: totalCount,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: parseInt(offset) + parseInt(limit) < totalCount,
          },
        },
      });
    } catch (error) {
      console.error("Error fetching contest logs:", error);
      return res.status(500).json({ message: "Internal server error." });
    }
  };

  const viewAllContestTimeLogs = async (req, res) => {
    try {
      const user = req.user;
  
      let whereClause = {};
  
      // 🔹 Supervisor: show only their department/team
      if (user.role === "supervisor") {
        whereClause = {
          timeLog: {
            user: {
              departmentId: user.departmentId,
              companyId: user.companyId,
            },
          },
        };
      }
  
      // 🔹 Admin/Manager/Owner/Superadmin: show entire company
      else if (
        user.role === "admin" ||
        user.role === "manager" ||
        user.role === "owner" ||
        user.role === "superadmin"
      ) {
        whereClause = {
          timeLog: {
            user: {
              companyId: user.companyId,
            },
          },
        };
      }
  
      const contestRequests = await prisma.contestTimeLog.findMany({
        where: whereClause,
        include: {
          timeLog: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  role: true,
                  departmentId: true,
                  profile: {
                    select: {
                      firstName: true,
                      lastName: true,
                    },
                  },
                },
              },
            },
          },
          approver: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
        orderBy: {
          submittedAt: "desc",
        },
      });
  
      const formattedData = contestRequests.map((contest) => ({
        id: contest.id,
        status: contest.status,
        reason: contest.reason,
        description: contest.description,
        currentClockIn: contest.currentClockIn,
        currentClockOut: contest.currentClockOut,
        requestedClockIn: contest.requestedClockIn,
        requestedClockOut: contest.requestedClockOut,
        submittedAt: contest.submittedAt,
        userDisplayName:
          contest.timeLog?.user?.profile
            ? `${contest.timeLog.user.profile.firstName} ${contest.timeLog.user.profile.lastName}`
            : contest.timeLog?.user?.email,
        approverDisplayName:
          contest.approver?.profile
            ? `${contest.approver.profile.firstName} ${contest.approver.profile.lastName}`
            : contest.approver?.email,
      }));
  
      return res.status(200).json({
        message: "Contest time logs retrieved successfully.",
        total: formattedData.length,
        data: formattedData,
      });
    } catch (error) {
      console.error("❌ Error fetching contest time logs:", error);
      return res
        .status(500)
        .json({ message: "Internal server error.", error: error.message });
    }
  };

  const deleteContestRequest = async (req, res) => {
    try {
      const { id } = req.params;
      const user = req.user;
  
      // Confirm the record exists and belongs to same company
      const contest = await prisma.contestTimeLog.findUnique({
        where: { id },
        include: {
          timeLog: {
            include: {
              user: true,
            },
          },
        },
      });
  
      if (!contest) {
        return res.status(404).json({ message: "Contest request not found." });
      }
  
      // Ensure same company (unless superadmin)
      if (
        user.role !== "superadmin" &&
        contest.timeLog?.user?.companyId !== user.companyId
      ) {
        return res.status(403).json({
          message: "You are not authorized to delete this contest request.",
        });
      }
  
      // Perform deletion
      await prisma.contestTimeLog.delete({
        where: { id },
      });
  
      return res.status(200).json({ message: "Contest request deleted successfully." });
    } catch (error) {
      console.error("❌ Error deleting contest request:", error);
      return res
        .status(500)
        .json({ message: "Internal server error.", error: error.message });
    }
  };

  const rejectContestRequest = async (req, res) => {
    try {
      const { id } = req.params;
      const approverId = req.user.id;
  
      // Check if the record exists
      const contest = await prisma.contestTimeLog.findUnique({
        where: { id },
        include: {
          timeLog: {
            include: {
              user: true,
            },
          },
        },
      });
  
      if (!contest) {
        return res.status(404).json({ message: "Contest request not found." });
      }
  
      // Verify access: same company or superadmin
      if (
        req.user.role !== "superadmin" &&
        contest.timeLog?.user?.companyId !== req.user.companyId
      ) {
        return res.status(403).json({ message: "Unauthorized to reject this contest request." });
      }
  
      // Update record to mark as rejected
      const updated = await prisma.contestTimeLog.update({
        where: { id },
        data: {
          status: "REJECTED",
          approverId,
          approvedAt: new Date(),
          approvedReason: "Rejected by admin/supervisor",
        },
        include: {
          timeLog: {
            include: {
              user: true,
            },
          },
          approver: true,
        },
      });
  
      return res.status(200).json({
        message: "Contest request rejected successfully.",
        data: updated,
      });
    } catch (error) {
      console.error("❌ Error rejecting contest request:", error);
      return res.status(500).json({
        message: "Internal server error.",
        error: error.message,
      });
    }
  };

  const approveContestRequest = async (req, res) => {
    try {
      const { id } = req.params;
      const approverId = req.user.id;
  
      // 1. Find the contest request
      const contest = await prisma.contestTimeLog.findUnique({
        where: { id },
        include: { timeLog: { include: { user: true } } },
      });
  
      if (!contest) {
        return res.status(404).json({ message: "Contest request not found." });
      }
  
      // 2. Security check
      if (
        req.user.role !== "superadmin" &&
        contest.timeLog?.user?.companyId !== req.user.companyId
      ) {
        return res.status(403).json({ message: "Unauthorized to approve this contest request." });
      }

      // BB-123: never write impossible times to the time log (covers requests
      // submitted before the submit check existed).
      const timesError = validateRequestedTimes(contest.requestedClockIn, contest.requestedClockOut);
      if (timesError) {
        return res.status(400).json({
          message: `${timesError} Reject this request and ask the employee to resubmit.`,
        });
      }

      const lockedCutoff = await findLockedCutoffForContest(contest.timeLogId, contest.requestedClockIn);
      if (lockedCutoff) {
        return res.status(400).json({
          code: "CUTOFF_LOCKED",
          message: `This punch is in a ${lockedCutoff.status} cutoff period (${fmtPeriod(lockedCutoff)}). Reopen the cutoff before approving, or reject this request.`,
        });
      }
  
      // 3. ✅ KEY FIX: Update the actual TimeLog with the corrected times
      await prisma.timeLog.update({
        where: { id: contest.timeLogId },
        data: {
          timeIn:  contest.requestedClockIn,
          timeOut: contest.requestedClockOut,
        },
      });

      // Recompute derived fields against the contested (corrected) times
      try {
        await computeTimeLogSummary(contest.timeLogId);
      } catch (computeErr) {
        console.error(`[approveContest] computeTimeLogSummary failed for ${contest.timeLogId}:`, computeErr.message);
      }

      // 4. Mark the contest itself as APPROVED
      const updated = await prisma.contestTimeLog.update({
        where: { id },
        data: {
          status: "APPROVED",
          approverId,
          approvedAt: new Date(),
          approvedReason: "Approved by admin/supervisor",
        },
        include: {
          timeLog: { include: { user: true } },
          approver: true,
        },
      });
  
      return res.status(200).json({
        message: "Contest request approved. Punch log times have been updated.",
        data: updated,
      });
    } catch (error) {
      console.error("❌ Error approving contest request:", error);
      return res.status(500).json({ message: "Internal server error.", error: error.message });
    }
  };
  
  
module.exports = { 
    submitContestPolicy,
    viewContestTimeLogs,
    viewAllContestTimeLogs,
    deleteContestRequest,
    rejectContestRequest,
    approveContestRequest
};
