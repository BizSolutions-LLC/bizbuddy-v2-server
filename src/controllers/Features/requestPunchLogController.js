// src/controllers/Features/requestPunchLogController.js

const { prisma } = require("@config/connection");
const { createNotification } = require("@services/notificationService");
const moment = require("moment-timezone");
const { resolvePunchType, applyTrainingFlatHours, VALID_PUNCH_TYPES, isDriverSegmentPunchType } = require("@utils/punchTypeUtils");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");

function parseClockTime(str, companyTimezone) {
  if (/Z$|[+-]\d{2}:\d{2}$/.test(str)) {
    return new Date(str);
  }
  return moment.tz(str, companyTimezone).toDate();
}

// Returns the first TimeLog that overlaps [clockIn, clockOut) for the given user.
// A null timeOut (currently clocked in) is always treated as a conflict.
async function findOverlappingLog(userId, clockIn, clockOut) {
  return prisma.timeLog.findFirst({
    where: {
      userId,
      AND: [
        { timeIn: { lt: clockOut } },
        {
          OR: [
            { timeOut: { gt: clockIn } },
            { timeOut: null },
          ],
        },
      ],
    },
  });
}

// Creates the actual TimeLog for an approved (or auto-approved) request and computes
// its derived hour fields. Shared by the single-approve endpoint (approveRequestedPunchLog)
// and the CSV bulk-import path (BB-077) so both stay in lock-step instead of drifting apart.
// autoLunchDeductionMinutes: 0 — a manually-requested/approved punch has no break
// data one way or the other, so computeTimeLogSummary's default "no break logged ->
// deduct minimumLunchMinutes anyway" rule (meant for real device clock-ins) must not
// apply here. The employee's claimed span is taken at face value; any break deduction
// is the approver's explicit call (e.g. editing hours before approving), not an
// automatic system assumption (BB-065).
async function createTimeLogFromRequest({ userId, companyId, timeIn, timeOut, requestedPunchType, reason }) {
  const punchType = resolvePunchType({ punchType: requestedPunchType, reason });

  let newTimeLog = await prisma.timeLog.create({
    data: {
      userId,
      timeIn,
      timeOut,
      status: false, // Completed
      punchType,
      coffeeBreaks: [],
      lunchBreak: {},
      autoLunchDeductionMinutes: 0,
    },
  });

  if (punchType === "TRAINING") {
    newTimeLog = await applyTrainingFlatHours(newTimeLog.id, companyId);
  } else {
    // Eager compute of derived fields (netWorkedHours, etc.) so the TimeLog isn't left
    // with null hours until the next cutoff-period sweep. Non-fatal — creation itself
    // is already persisted even if this fails.
    try {
      const derived = await computeTimeLogSummary(newTimeLog.id);
      if (derived) Object.assign(newTimeLog, derived);
    } catch (computeErr) {
      console.error(`[createTimeLogFromRequest] computeTimeLogSummary failed for ${newTimeLog.id}:`, computeErr.message);
    }
  }

  return newTimeLog;
}

const submitRequestPunchLog = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      requestedDate,
      requestedClockIn,
      requestedClockOut,
      approverId,
      reason,
      description,
      punchType,
    } = req.body;

    // Validation
    if (!requestedDate || !requestedClockIn || !requestedClockOut || !approverId) {
      return res.status(400).json({
        message: "Missing required fields: requestedDate, requestedClockIn, requestedClockOut, approverId"
      });
    }

    // punchType is optional — omitted/REGULAR/TRAINING behave exactly as before.
    // Driver/Aide correction types (BB-065) are only meaningful for DayCare companies —
    // BNC doesn't use this concept at all, so reject rather than silently accept.
    if (punchType !== undefined && punchType !== null) {
      if (!VALID_PUNCH_TYPES.includes(punchType)) {
        return res.status(400).json({ message: `Invalid punchType: ${punchType}` });
      }
      if (isDriverSegmentPunchType(punchType) && BNC_COMPANY_IDS.has(req.user.companyId)) {
        return res.status(400).json({ message: "Driver/Aide punch types are not available for this company." });
      }
    }

    // Resolve company timezone — used to correctly interpret naive clock strings from older clients
    const company = await prisma.company.findUnique({
      where: { id: req.user.companyId },
      select: { timeZone: true },
    });
    const companyTimezone = company?.timeZone || "UTC";

    // Parse clock times — naive strings (no offset) are interpreted in company timezone
    const clockIn  = parseClockTime(requestedClockIn,  companyTimezone);
    const clockOut = parseClockTime(requestedClockOut, companyTimezone);

    if (isNaN(clockIn) || isNaN(clockOut)) {
      return res.status(400).json({ message: "Invalid requestedClockIn or requestedClockOut." });
    }

    // Block submission if the requested time range overlaps an existing punch log
    const conflictingLog = await findOverlappingLog(userId, clockIn, clockOut);
    if (conflictingLog) {
      return res.status(409).json({
        message: "Your requested time conflicts with an existing punch log for this period.",
        conflictingLogId: conflictingLog.id,
        conflictingTimeIn: conflictingLog.timeIn,
        conflictingTimeOut: conflictingLog.timeOut,
      });
    }

    // Check for duplicate pending request
    const existingRequest = await prisma.requestedTimeLog.findFirst({
      where: {
        userId,
        requestedDate: new Date(requestedDate),
        status: "PENDING",
      },
    });

    if (existingRequest) {
      return res.status(409).json({
        message: "You already have a pending request for this date."
      });
    }

    if (clockIn >= clockOut) {
      return res.status(400).json({ message: "Clock-in time must be before clock-out time." });
    }

    // Compute estimatedDuration/estimatedNetHours server-side rather than trusting the
    // client-sent values — web and mobile were independently computing these (one
    // applying the standard lunch deduction, one not), producing inconsistent hours
    // for identical clock-in/out spans in the approver's pending queue (BB-065).
    // Deliberately NOT deducting a lunch break here: unlike a real clock-in/out, a
    // manual request has no break data one way or the other, so the claimed span is
    // taken at face value. Any deduction is the approver's explicit call, not an
    // automatic system assumption.
    const grossMinutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60000);
    const estimatedDuration = grossMinutes;
    const estimatedNetHours = +(grossMinutes / 60).toFixed(2);

    // Create the request
    const newRequest = await prisma.requestedTimeLog.create({
      data: {
        userId,
        approverId,
        requestedDate: new Date(requestedDate),
        requestedClockIn: clockIn,
        requestedClockOut: clockOut,
        reason,
        description,
        estimatedDuration,
        estimatedNetHours,
        requestedPunchType: punchType || null,
        status: "PENDING",
        submittedAt: new Date(),
      },
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
    });

    console.log("[✅ Punch log request created]", newRequest);

    // Notify management
    try {
      const employeeName = newRequest.user?.profile
        ? `${newRequest.user.profile.firstName || ''} ${newRequest.user.profile.lastName || ''}`.trim()
        : newRequest.user?.email || 'An employee';
      const dateStr = new Date(requestedDate).toLocaleDateString();
      const managementUsers = await prisma.user.findMany({
        where: { companyId: req.user.companyId, role: { in: ['admin', 'superadmin', 'supervisor'] }, status: 'active' },
        select: { id: true, departmentId: true },
      });
      await Promise.all(managementUsers.map(manager =>
        createNotification({
          userId: manager.id,
          companyId: req.user.companyId,
          departmentId: manager.departmentId,
          notificationCode: 'CONTEST_REQUEST_SUBMITTED',
          title: 'Time Correction Request',
          message: `${employeeName} submitted a time correction request for ${dateStr}.`,
          payload: { requestId: newRequest.id, requestedDate, requesterId: userId },
        })
      ));
    } catch (notifError) {
      console.error('❌ Failed to send punch log submission notification:', notifError);
    }

    return res.status(201).json({
      message: "Punch log request submitted successfully.",
      data: newRequest,
    });
  } catch (error) {
    console.error("❌ Error submitting punch log request:", error);
    return res.status(500).json({ 
      message: "Internal server error.", 
      error: error.message 
    });
  }
};

const viewMyRequestedPunchLogs = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, limit = 50, offset = 0 } = req.query;

    let where = { userId };

    if (status && status !== "ALL") {
      where.status = status;
    }

    const requests = await prisma.requestedTimeLog.findMany({
      where,
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
      orderBy: { submittedAt: "desc" },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    const totalCount = await prisma.requestedTimeLog.count({ where });

    return res.status(200).json({
      message: "Requested punch logs fetched successfully.",
      data: {
        requests,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: parseInt(offset) + parseInt(limit) < totalCount,
        },
      },
    });
  } catch (error) {
    console.error("❌ Error fetching requested punch logs:", error);
    return res.status(500).json({ 
      message: "Internal server error.", 
      error: error.message 
    });
  }
};

const viewAllRequestedPunchLogs = async (req, res) => {
  try {
    const user = req.user;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;

    let whereClause = {};

    // 🔹 Supervisor: show only their department/team
    if (user.role === "supervisor") {
      whereClause = {
        user: {
          departmentId: user.departmentId,
          companyId: user.companyId,
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
        user: {
          companyId: user.companyId,
        },
      };
    }

    if (status && status !== "ALL") whereClause.status = status;

    const [requests, total] = await Promise.all([
      prisma.requestedTimeLog.findMany({
        where: whereClause,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              role: true,
              departmentId: true,
              profile: {
                select: { firstName: true, lastName: true },
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
        orderBy: { submittedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.requestedTimeLog.count({ where: whereClause }),
    ]);

    const formattedData = requests.map((req) => ({
      id: req.id,
      status: req.status,
      reason: req.reason,
      description: req.description,
      requestedDate: req.requestedDate,
      requestedClockIn: req.requestedClockIn,
      requestedClockOut: req.requestedClockOut,
      estimatedDuration: req.estimatedDuration,
      estimatedNetHours: req.estimatedNetHours,
      requestedPunchType: req.requestedPunchType,
      submittedAt: req.submittedAt,
      approvedAt: req.approvedAt,
      userDisplayName: req.user?.profile
        ? `${req.user.profile.firstName} ${req.user.profile.lastName}`
        : req.user?.email,
      approverDisplayName: req.approver?.profile
        ? `${req.approver.profile.firstName} ${req.approver.profile.lastName}`
        : req.approver?.email,
    }));

    return res.status(200).json({
      message: "Requested punch logs retrieved successfully.",
      data: formattedData,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (error) {
    console.error("❌ Error fetching all requested punch logs:", error);
    return res.status(500).json({ 
      message: "Internal server error.", 
      error: error.message 
    });
  }
};

const approveRequestedPunchLog = async (req, res) => {
  try {
    const { id } = req.params;
    const approverId = req.user.id;

    const request = await prisma.requestedTimeLog.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!request) {
      return res.status(404).json({ message: "Request not found." });
    }

    // Security check
    if (
      req.user.role !== "superadmin" &&
      request.user.companyId !== req.user.companyId
    ) {
      return res.status(403).json({ message: "Unauthorized." });
    }

    // Guard against race conditions — recheck overlap at approval time
    const conflictingLog = await findOverlappingLog(
      request.userId,
      request.requestedClockIn,
      request.requestedClockOut,
    );
    if (conflictingLog) {
      return res.status(409).json({
        message: "Cannot approve: the requested time now conflicts with an existing punch log.",
        conflictingLogId: conflictingLog.id,
      });
    }

    const newTimeLog = await createTimeLogFromRequest({
      userId: request.userId,
      companyId: request.user.companyId,
      timeIn: request.requestedClockIn,
      timeOut: request.requestedClockOut,
      requestedPunchType: request.requestedPunchType,
      reason: request.reason,
    });

    // Update request status
    const updatedRequest = await prisma.requestedTimeLog.update({
      where: { id },
      data: {
        status: "APPROVED",
        approverId,
        approvedAt: new Date(),
        createdTimeLogId: newTimeLog.id, // Link to created log
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        approver: {
          select: {
            id: true,
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    // Notify the requesting employee
    try {
      const dateStr = new Date(request.requestedDate).toLocaleDateString();
      const reqUser = await prisma.user.findUnique({
        where: { id: request.userId },
        select: { companyId: true, departmentId: true },
      });
      await createNotification({
        userId: request.userId,
        companyId: reqUser?.companyId || req.user.companyId,
        departmentId: reqUser?.departmentId || null,
        notificationCode: 'CONTEST_REQUEST_APPROVED',
        title: 'Time Correction Approved',
        message: `Your time correction request for ${dateStr} has been approved.`,
        payload: { requestId: id, requestedDate: request.requestedDate },
      });
    } catch (notifError) {
      console.error('❌ Failed to send punch log approval notification:', notifError);
    }

    return res.status(200).json({
      message: "Punch log request approved and time log created successfully.",
      data: {
        request: updatedRequest,
        timeLog: newTimeLog,
      },
    });
  } catch (error) {
    console.error("❌ Error approving request:", error);
    return res.status(500).json({ 
      message: "Internal server error.", 
      error: error.message 
    });
  }
};

const rejectRequestedPunchLog = async (req, res) => {
  try {
    const { id } = req.params;
    const approverId = req.user.id;
    const { rejectionReason } = req.body;

    const request = await prisma.requestedTimeLog.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!request) {
      return res.status(404).json({ message: "Request not found." });
    }

    if (
      req.user.role !== "superadmin" &&
      request.user.companyId !== req.user.companyId
    ) {
      return res.status(403).json({ message: "Unauthorized." });
    }

    const updated = await prisma.requestedTimeLog.update({
      where: { id },
      data: {
        status: "REJECTED",
        approverId,
        approvedAt: new Date(),
        rejectionReason: rejectionReason || "Rejected by approver",
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        approver: {
          select: {
            id: true,
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    // Notify the requesting employee
    try {
      const dateStr = new Date(request.requestedDate).toLocaleDateString();
      const reqUser = await prisma.user.findUnique({
        where: { id: request.userId },
        select: { companyId: true, departmentId: true },
      });
      await createNotification({
        userId: request.userId,
        companyId: reqUser?.companyId || req.user.companyId,
        departmentId: reqUser?.departmentId || null,
        notificationCode: 'CONTEST_REQUEST_REJECTED',
        title: 'Time Correction Rejected',
        message: `Your time correction request for ${dateStr} has been rejected.`,
        payload: { requestId: id, requestedDate: request.requestedDate },
      });
    } catch (notifError) {
      console.error('❌ Failed to send punch log rejection notification:', notifError);
    }

    return res.status(200).json({
      message: "Punch log request rejected successfully.",
      data: updated,
    });
  } catch (error) {
    console.error("❌ Error rejecting request:", error);
    return res.status(500).json({ 
      message: "Internal server error.", 
      error: error.message 
    });
  }
};

const deleteRequestedPunchLog = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const request = await prisma.requestedTimeLog.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!request) {
      return res.status(404).json({ message: "Request not found." });
    }

    // Only allow deletion if: own request, or admin/superadmin
    if (
      request.userId !== user.id &&
      user.role !== "admin" &&
      user.role !== "superadmin"
    ) {
      return res.status(403).json({ message: "Unauthorized." });
    }

    await prisma.requestedTimeLog.delete({ where: { id } });

    return res.status(200).json({ 
      message: "Punch log request deleted successfully." 
    });
  } catch (error) {
    console.error("❌ Error deleting request:", error);
    return res.status(500).json({ 
      message: "Internal server error.", 
      error: error.message 
    });
  }
};

const checkConflict = async (req, res) => {
  try {
    const userId = req.user.id;
    const { requestedClockIn, requestedClockOut } = req.body;

    if (!requestedClockIn || !requestedClockOut) {
      return res.status(400).json({ message: "Missing required fields: requestedClockIn, requestedClockOut" });
    }

    const company = await prisma.company.findUnique({
      where: { id: req.user.companyId },
      select: { timeZone: true },
    });
    const companyTimezone = company?.timeZone || "UTC";

    const clockIn  = parseClockTime(requestedClockIn,  companyTimezone);
    const clockOut = parseClockTime(requestedClockOut, companyTimezone);

    if (isNaN(clockIn) || isNaN(clockOut)) {
      return res.status(400).json({ message: "Invalid requestedClockIn or requestedClockOut." });
    }

    if (clockIn >= clockOut) {
      return res.status(400).json({ message: "Clock-in time must be before clock-out time." });
    }

    const conflictingLog = await findOverlappingLog(userId, clockIn, clockOut);

    return res.status(200).json({
      hasConflict: !!conflictingLog,
      conflictingLogId: conflictingLog?.id || null,
      conflictingTimeIn: conflictingLog?.timeIn || null,
      conflictingTimeOut: conflictingLog?.timeOut || null,
    });
  } catch (error) {
    console.error("❌ Error checking punch log conflict:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

module.exports = {
  submitRequestPunchLog,
  checkConflict,
  viewMyRequestedPunchLogs,
  viewAllRequestedPunchLogs,
  approveRequestedPunchLog,
  rejectRequestedPunchLog,
  deleteRequestedPunchLog,
  // Shared with punchLogImportService.js (BB-077 CSV bulk import)
  parseClockTime,
  findOverlappingLog,
  createTimeLogFromRequest,
};