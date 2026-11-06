// src/controllers/Features/overtimeController.js

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { createNotification } = require("@services/notificationService");
const moment = require("moment-timezone");

// Derives the active cutoff period window from a seed definition
function computeActiveCutoffPeriod(seedStartDate, durationDays, tz) {
  const today = moment().tz(tz).startOf("day");
  let current = moment.tz(seedStartDate, tz).startOf("day");
  while (current.clone().add(durationDays, "days").isSameOrBefore(today)) {
    current = current.clone().add(durationDays, "days");
  }
  return {
    periodStart: current.toDate(),
    periodEnd:   current.clone().add(durationDays - 1, "days").endOf("day").toDate(),
  };
}

// Returns accumulated hours, already-submitted OT, and eligible hours for the period
async function computeOtEligibility(userId, companyId) {
  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: {
      timeZone:              true,
      otBasis:               true,
      dailyOtThresholdHours:  true,
      weeklyOtThresholdHours: true,
      cutoffOtThresholdHours: true,
      companyCutoffSettings:  true,
    },
  });

  const tz        = company.timeZone || "UTC";
  const basis     = company.otBasis  || "daily";
  let periodStart, periodEnd, threshold;

  if (basis === "daily") {
    periodStart = moment().tz(tz).startOf("day").toDate();
    periodEnd   = moment().tz(tz).endOf("day").toDate();
    threshold   = parseFloat(company.dailyOtThresholdHours  || 8);
  } else if (basis === "weekly") {
    periodStart = moment().tz(tz).startOf("isoWeek").toDate();
    periodEnd   = moment().tz(tz).endOf("isoWeek").toDate();
    threshold   = parseFloat(company.weeklyOtThresholdHours || 40);
  } else {
    // cutoff
    if (!company.companyCutoffSettings) return null; // caller handles 400
    const active = computeActiveCutoffPeriod(
      company.companyCutoffSettings.seedStartDate,
      company.companyCutoffSettings.durationDays,
      tz
    );
    periodStart = active.periodStart;
    periodEnd   = active.periodEnd;
    threshold   = parseFloat(company.cutoffOtThresholdHours || 80);
  }

  const logs = await prisma.timeLog.findMany({
    where: {
      userId,
      status:  false, // completed
      timeIn:  { gte: periodStart, lte: periodEnd },
      timeOut: { not: null },
    },
    select: {
      id:             true,
      timeIn:         true,
      timeOut:        true,
      netWorkedHours: true,
      punchType:      true,
    },
    orderBy: { timeIn: "asc" },
  });

  const accumulatedHours = logs.reduce(
    (sum, l) => sum + parseFloat(l.netWorkedHours || 0), 0
  );

  const existingOT = await prisma.overtime.findMany({
    where: {
      requesterId: userId,
      status:      { in: ["pending", "approved"] },
      createdAt:   { gte: periodStart, lte: periodEnd },
    },
    select: { requestedHours: true },
  });
  const alreadySubmittedHours = existingOT.reduce(
    (sum, ot) => sum + parseFloat(ot.requestedHours || 0), 0
  );

  const otEligibleHours = Math.max(0, accumulatedHours - threshold - alreadySubmittedHours);

  return {
    basis,
    threshold,
    periodStart,
    periodEnd,
    accumulatedHours:      parseFloat(accumulatedHours.toFixed(2)),
    alreadySubmittedHours: parseFloat(alreadySubmittedHours.toFixed(2)),
    otEligibleHours:       parseFloat(otEligibleHours.toFixed(2)),
    eligible:              otEligibleHours > 0,
    logs,
  };
}

function format(ot) {
  return {
    ...ot,
    createdAt: ot.createdAt.toISOString(),
    updatedAt: ot.updatedAt.toISOString(),
  };
}

function calculateLateHours(timeLog, userShift) {
  if (!timeLog?.timeIn || !userShift?.shift?.startTime) return null;

  const punchIn = new Date(timeLog.timeIn);
  const shiftRef = new Date(userShift.shift.startTime);
  const shiftStart = new Date(punchIn);
  shiftStart.setHours(shiftRef.getHours(), shiftRef.getMinutes(), 0, 0);

  if (punchIn <= shiftStart) return 0;

  const minsLate = (punchIn - shiftStart) / 60000;
  return +(minsLate / 60).toFixed(2); // two-decimal hours
}

const submitOvertime = async (req, res) => {
  try {
    const {
      timeLogId,
      approverId,
      requesterReason,
      requestedHours,
      lateHours: lateHoursFromBody,
      originalClockOut,
      projectedClockOut,
      totalProjectedHours,
    } = req.body;

    if (!timeLogId || !approverId) {
      return res
        .status(400)
        .json({ message: "timeLogId and approverId are required." });
    }

    if (!requestedHours || parseFloat(requestedHours) <= 0) {
      return res
        .status(400)
        .json({ message: "requestedHours must be greater than 0." });
    }

    // ── Threshold eligibility gate ────────────────────────────────────────────
    const eligibility = await computeOtEligibility(req.user.id, req.user.companyId);
    if (eligibility === null) {
      return res.status(400).json({
        message: "No cutoff period configured. Set up company cutoff settings before submitting OT.",
      });
    }
    if (!eligibility.eligible) {
      return res.status(400).json({
        message: `Accumulated hours (${eligibility.accumulatedHours}h) have not reached the ${eligibility.basis} OT threshold (${eligibility.threshold}h).`,
        data: { accumulatedHours: eligibility.accumulatedHours, threshold: eligibility.threshold, basis: eligibility.basis },
      });
    }
    if (parseFloat(requestedHours) > eligibility.otEligibleHours) {
      return res.status(400).json({
        message: `Requested hours (${requestedHours}h) exceed the available OT excess (${eligibility.otEligibleHours}h).`,
        data: { otEligibleHours: eligibility.otEligibleHours },
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Validate timeLog exists and belongs to user
    const timeLog = await prisma.timeLog.findUnique({
      where: { id: timeLogId },
      include: {
        user: {
          include: {
            department: true,
            employmentDetail: true,
          },
        },
      },
    });

    if (!timeLog || timeLog.userId !== req.user.id) {
      return res.status(404).json({ message: "TimeLog not found." });
    }

    // Validate approver
    const approver = await prisma.user.findFirst({
      where: {
        ...HUMAN_ONLY,
        id: approverId,
        companyId: req.user.companyId,
        role: { in: ["admin", "supervisor", "superadmin"] },
        status: "active",
      },
    });

    if (!approver) {
      return res.status(400).json({ message: "Invalid or inactive approver." });
    }

    if (approverId === req.user.id) {
      return res
        .status(400)
        .json({ message: "You cannot approve your own overtime request." });
    }

    // Calculate late hours if not provided
    let lateHours = null;
    if (lateHoursFromBody != null) {
      lateHours = Number(lateHoursFromBody);
    } else {
      const dayStart = new Date(timeLog.timeIn);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const userShift = await prisma.userShift.findFirst({
        where: {
          userId: req.user.id,
          assignedDate: { gte: dayStart, lte: dayEnd },
        },
        include: { shift: true },
      });

      const calcLate = calculateLateHours(timeLog, userShift);
      lateHours = calcLate != null ? calcLate : 0;
    }

    // Determine user's department
    const userDepartmentId =
      timeLog.user.departmentId || timeLog.user.employmentDetail?.departmentId;

    // Create overtime request
    const newOT = await prisma.overtime.create({
      data: {
        timeLogId,
        requesterId: req.user.id,
        approverId,
        requesterReason: requesterReason?.trim() || null,
        requestedHours: parseFloat(requestedHours),
        lateHours,
        companyId: req.user.companyId,
        departmentId: userDepartmentId || null,
      },
      include: {
        timeLog: {
          select: {
            timeIn: true,
            timeOut: true,
          },
        },
        requester: {
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
    });

    // Log the activity for audit trail
    await prisma.userActivity.create({
      data: {
        userId: req.user.id,
        activityDescription: `Submitted overtime request for ${requestedHours}h on ${new Date(
          timeLog.timeIn
        ).toLocaleDateString()}`,
      },
    });

    // Notify management
    try {
      const employeeName = newOT.requester?.profile
        ? `${newOT.requester.profile.firstName || ''} ${newOT.requester.profile.lastName || ''}`.trim()
        : newOT.requester?.email || 'An employee';
      const otDate = new Date(newOT.timeLog.timeIn).toLocaleDateString();
      const managementUsers = await prisma.user.findMany({
        where: { ...HUMAN_ONLY, companyId: req.user.companyId, role: { in: ['admin', 'superadmin', 'supervisor'] }, status: 'active' },
        select: { id: true, departmentId: true },
      });
      await Promise.all(managementUsers.map(manager =>
        createNotification({
          userId: manager.id,
          companyId: req.user.companyId,
          departmentId: manager.departmentId,
          notificationCode: 'OVERTIME_REQUEST_SUBMITTED',
          title: 'Overtime Request Submitted',
          message: `${employeeName} submitted an overtime request for ${otDate} (${requestedHours} hrs).`,
          payload: { overtimeId: newOT.id, requesterId: req.user.id },
        })
      ));
    } catch (notifError) {
      console.error('❌ Failed to send OT submission notification:', notifError);
    }

    return res.status(201).json({
      message: "Overtime request submitted successfully.",
      data: {
        ...format(newOT),
        projectedClockOut,
        totalProjectedHours,
        originalClockOut: timeLog.timeOut,
      },
    });
  } catch (err) {
    console.error("submitOvertime error:", err);
    return res.status(500).json({
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

const getMyOT = async (req, res) => {
  try {
    const ots = await prisma.overtime.findMany({
      where: { requesterId: req.user.id },
      include: {
        timeLog: true,
        approver: { 
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
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return res.status(200).json({ data: ots.map(format) });
  } catch (err) {
    console.error("getMyOT:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getPendingOT = async (req, res) => {
  try {
    const ots = await prisma.overtime.findMany({
      where: { approverId: req.user.id, status: "pending" },
      include: {
        timeLog: true,
        requester: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return res.status(200).json({ data: ots.map(format) });
  } catch (err) {
    console.error("getPendingOT:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const decideOT = (newStatus) => async (req, res) => {
  try {
    const { id } = req.params;
    const { approverComments } = req.body;

    const ot = await prisma.overtime.findFirst({
      where: { id, approverId: req.user.id, status: "pending" },
      include: { timeLog: { select: { timeIn: true } } },
    });
    if (!ot) {
      return res
        .status(404)
        .json({ message: "OT request not found or already processed." });
    }

    const updated = await prisma.overtime.update({
      where: { id },
      data: { status: newStatus, approverComments },
    });

    // Notify the requesting employee
    try {
      const otDate = ot.timeLog?.timeIn
        ? new Date(ot.timeLog.timeIn).toLocaleDateString()
        : 'your recent date';
      await createNotification({
        userId: ot.requesterId,
        companyId: ot.companyId,
        departmentId: ot.departmentId || null,
        notificationCode: newStatus === 'approved' ? 'OVERTIME_REQUEST_APPROVED' : 'OVERTIME_REQUEST_REJECTED',
        title: newStatus === 'approved' ? 'Overtime Request Approved' : 'Overtime Request Rejected',
        message: `Your overtime request for ${otDate} has been ${newStatus}.`,
        payload: { overtimeId: ot.id },
      });
    } catch (notifError) {
      console.error('❌ Failed to send OT decision notification:', notifError);
    }

    return res
      .status(200)
      .json({ message: `Overtime ${newStatus}.`, data: format(updated) });
  } catch (err) {
    console.error(`${newStatus}OT:`, err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const approveOT = decideOT("approved");
const rejectOT = decideOT("rejected");

const deleteOT = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.overtime.delete({ where: { id } });
    return res.status(200).json({ message: "OT request deleted." });
  } catch (err) {
    console.error("deleteOT:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getAllOT = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status; // optional filter

    let whereClause = {};

    // Build filter based on user role
    switch (req.user.role) {
      case "superadmin":
        // Superadmin sees ALL overtime requests across all companies
        whereClause = {};
        break;

      case "admin":
        // Admin sees all OT requests from their assigned company
        whereClause = {
          requester: {
            companyId: req.user.companyId,
          },
        };
        break;

      case "supervisor":
        // Supervisor/Department Head sees all OT requests from their department
        whereClause = {
          requester: {
            departmentId: req.user.departmentId,
          },
        };
        break;

      default:
        // Fallback: only show where user is the direct approver
        whereClause = {
          approverId: req.user.id,
        };
    }

    if (status) whereClause.status = status;

    const [ots, total] = await Promise.all([
      prisma.overtime.findMany({
        where: whereClause,
        include: {
          timeLog: true,
          requester: {
            select: {
              id: true,
              email: true,
              username: true,
              departmentId: true,
              companyId: true,
              department: { select: { id: true, name: true } },
              company: { select: { id: true, name: true } },
            },
          },
          approver: {
            select: { id: true, email: true, username: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.overtime.count({ where: whereClause }),
    ]);

    return res.status(200).json({
      data: ots.map(format),
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (err) {
    console.error("getAllOT:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const detectSmartOvertime = async (req, res) => {
  try {
    const { id: userId, role, companyId } = req.user;
    const isAdmin = ["admin", "superadmin", "hr"].includes(role.toLowerCase());

    const { otBasis, threshold, periodStart, periodEnd } = req.query;

    // ─── NEW: OT-config-aware detection ─────────────────────────────────────
    if (otBasis) {
      const thresholdMins = parseFloat(threshold || 8) * 60;

      // Build date window
      let fromDate, toDate;
      toDate = new Date();

      if (otBasis === "cutoff") {
        if (periodStart && periodEnd) {
          fromDate = new Date(periodStart);
          toDate = new Date(periodEnd);
          toDate.setHours(23, 59, 59, 999);
        } else {
          // No cutoff window provided and no open period to fall back to
          return res.status(200).json({
            message: "Smart overtime detection complete.",
            meta: { count: 0 },
            data: [],
          });
        }
      } else if (otBasis === "weekly") {
        const now = new Date();
        const daysFromMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
        fromDate = new Date(now);
        fromDate.setDate(now.getDate() - daysFromMonday);
        fromDate.setHours(0, 0, 0, 0);
      } else {
        // daily — last 30 days
        fromDate = new Date();
        fromDate.setDate(toDate.getDate() - 30);
      }

      const whereClause = isAdmin ? { user: { companyId } } : { userId };
      whereClause.timeIn = { gte: fromDate, lte: toDate };
      whereClause.timeOut = { not: null };

      const timeLogs = await prisma.timeLog.findMany({
        where: whereClause,
        include: {
          user: { include: { profile: true, department: true } },
        },
        orderBy: { timeIn: "asc" },
      });

      if (!timeLogs.length) {
        return res.status(200).json({
          message: "No timelogs found for analysis.",
          meta: { count: 0 },
          data: [],
        });
      }

      const buildEntry = (log, elapsedMins, overtimeMins, type) => ({
        timeLogId: log.id,
        userId: log.userId,
        employeeName: `${log.user.profile?.firstName || ""} ${log.user.profile?.lastName || ""}`.trim(),
        department: log.user.department?.name || "—",
        date: log.timeIn.toISOString().slice(0, 10),
        actualStart: log.timeIn,
        actualEnd: log.timeOut,
        elapsedMins: +elapsedMins.toFixed(2),
        overtimeMins: +overtimeMins.toFixed(2),
        overtimeHours: +(overtimeMins / 60).toFixed(2),
        type,
        detectedAt: new Date().toISOString(),
      });

      const results = [];

      if (otBasis === "daily") {
        for (const log of timeLogs) {
          const elapsedMins = (new Date(log.timeOut) - new Date(log.timeIn)) / 60000;
          if (elapsedMins <= thresholdMins) continue;
          results.push(buildEntry(log, elapsedMins, elapsedMins - thresholdMins, "Daily"));
        }
      } else {
        // weekly or cutoff — cumulative per user
        const byUser = new Map();
        for (const log of timeLogs) {
          if (!byUser.has(log.userId)) byUser.set(log.userId, []);
          byUser.get(log.userId).push(log);
        }

        const type = otBasis === "weekly" ? "Weekly" : "Cutoff";

        for (const userLogs of byUser.values()) {
          let accumulated = 0;
          for (const log of userLogs) {
            const elapsedMins = (new Date(log.timeOut) - new Date(log.timeIn)) / 60000;
            const prev = accumulated;
            accumulated += elapsedMins;
            if (accumulated <= thresholdMins) continue;
            const overtimeMins = accumulated - Math.max(prev, thresholdMins);
            results.push(buildEntry(log, elapsedMins, overtimeMins, type));
          }
        }
      }

      return res.status(200).json({
        message: "Smart overtime detection complete.",
        meta: { count: results.length },
        data: results,
      });
    }
    // ─── END NEW ─────────────────────────────────────────────────────────────

    // Legacy: scheduled-vs-actual detection (no otBasis param)

    // Default date window: last 30 days
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - 30);

    // 1️⃣ Build TimeLog query (token-based)
    const whereClause = isAdmin ? { user: { companyId } } : { userId };

    whereClause.timeIn = { gte: fromDate, lte: toDate };

    const timeLogs = await prisma.timeLog.findMany({
      where: whereClause,
      include: {
        user: {
          include: {
            profile: true,
            department: true,
          },
        },
      },
      orderBy: { timeIn: "desc" },
    });

    if (!timeLogs.length) {
      return res
        .status(200)
        .json({ data: [], message: "No timelogs found for analysis." });
    }

    // 2️⃣ Fetch all userShifts for date range
    const userIds = [...new Set(timeLogs.map((t) => t.userId))];
    const userShifts = await prisma.userShift.findMany({
      where: {
        userId: { in: userIds },
        assignedDate: { gte: fromDate, lte: toDate },
      },
      include: { shift: true },
    });

    // Create lookup map
    const shiftMap = new Map();
    for (const s of userShifts) {
      const key = `${s.userId}-${s.assignedDate.toISOString().slice(0, 10)}`;
      shiftMap.set(key, s);
    }

    // 3️⃣ (Optional) Fetch company settings for minimum OT threshold
    const companyRecord = await prisma.company.findFirst({
      where: { id: companyId },
    });
    const minOvertimeMinutes = companyRecord?.minimumOvertimeMinutes ?? 15;

    const results = [];

    // 4️⃣ Loop through logs and compare scheduled vs actual
    for (const log of timeLogs) {
      if (!log.timeOut) continue; // skip active sessions

      const logDate = log.timeIn.toISOString().slice(0, 10);
      const shift = shiftMap.get(`${log.userId}-${logDate}`);

      const scheduledStart =
        shift?.customStartTime || shift?.shift?.startTime || null;
      const scheduledEnd =
        shift?.customEndTime || shift?.shift?.endTime || null;

      const actualStart = new Date(log.timeIn);
      const actualEnd = new Date(log.timeOut);
      const elapsedMins = (actualEnd - actualStart) / 60000;

      let overtimeMins = 0;
      let type = "Scheduled";

      if (scheduledEnd && scheduledStart) {
        const schedStartRef = new Date(actualStart);
        const schedEndRef = new Date(actualStart);

        // Align scheduled times to actual date (since shift times are usually "time only")
        const [startHours, startMins] = [
          new Date(scheduledStart).getHours(),
          new Date(scheduledStart).getMinutes(),
        ];
        const [endHours, endMins] = [
          new Date(scheduledEnd).getHours(),
          new Date(scheduledEnd).getMinutes(),
        ];

        schedStartRef.setHours(startHours, startMins, 0, 0);
        schedEndRef.setHours(endHours, endMins, 0, 0);

        // Calculate duration difference
        const schedDurationMins = (schedEndRef - schedStartRef) / 60000;
        overtimeMins = Math.max(0, elapsedMins - schedDurationMins);
      } else {
        // No scheduled shift - treat full duration as potential OT
        type = "Unscheduled";
        overtimeMins = elapsedMins;
      }

      // Skip trivial OTs (below threshold)
      if (overtimeMins < minOvertimeMinutes) continue;

      results.push({
        timeLogId: log.id,
        userId: log.userId,
        employeeName: `${log.user.profile?.firstName || ""} ${
          log.user.profile?.lastName || ""
        }`.trim(),
        department: log.user.department?.name || "—",
        date: logDate,
        scheduledStart: scheduledStart
          ? new Date(scheduledStart).toISOString()
          : null,
        scheduledEnd: scheduledEnd
          ? new Date(scheduledEnd).toISOString()
          : null,
        actualStart: log.timeIn,
        actualEnd: log.timeOut,
        elapsedMins,
        overtimeMins,
        overtimeHours: +(overtimeMins / 60).toFixed(2),
        type, // "Scheduled" or "Unscheduled"
        detectedAt: new Date().toISOString(),
      });
    }

    // 5️⃣ Return detections
    return res.status(200).json({
      message: "Smart overtime detection complete.",
      meta: { count: results.length },
      data: results,
    });
  } catch (err) {
    console.error("detectSmartOvertime:", err);
    return res.status(500).json({
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

const getThresholdStatus = async (req, res) => {
  try {
    const eligibility = await computeOtEligibility(req.user.id, req.user.companyId);

    if (eligibility === null) {
      return res.status(400).json({
        message: "No cutoff period configured. Set up company cutoff settings first.",
      });
    }

    return res.status(200).json({
      data: {
        basis:                 eligibility.basis,
        threshold:             eligibility.threshold,
        periodStart:           eligibility.periodStart.toISOString().slice(0, 10),
        periodEnd:             eligibility.periodEnd.toISOString().slice(0, 10),
        accumulatedHours:      eligibility.accumulatedHours,
        alreadySubmittedHours: eligibility.alreadySubmittedHours,
        otEligibleHours:       eligibility.otEligibleHours,
        eligible:              eligibility.eligible,
        logs: eligibility.logs.map((l) => ({
          timeLogId:      l.id,
          date:           l.timeIn.toISOString().slice(0, 10),
          timeIn:         l.timeIn.toISOString(),
          timeOut:        l.timeOut ? l.timeOut.toISOString() : null,
          netWorkedHours: parseFloat(l.netWorkedHours || 0),
          punchType:      l.punchType,
        })),
      },
    });
  } catch (err) {
    console.error("getThresholdStatus error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = {
  submitOvertime,
  getMyOT,
  getPendingOT,
  approveOT,
  rejectOT,
  deleteOT,
  getAllOT,
  detectSmartOvertime,
  getThresholdStatus,
};
