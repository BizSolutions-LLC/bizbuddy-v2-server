// src/controllers/Features/timeLogController.js

const { prisma } = require("@config/connection");
const { Prisma } = require("@prisma/client");
const { getIO } = require("@config/socket");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");
const { createLiveUser, removeLiveUser } = require("@services/liveUserService");
const { applyAutoBreaks } = require("@services/autoBreakService");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");
const { matchShiftToWindow } = require("@services/timeLogComputeUtils");
const moment = require("moment-timezone");
const { resolvePunchType, punchTypeFromReason } = require("@utils/punchTypeUtils");

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function recalcLateHours(userId, newTimeIn) {
  if (!newTimeIn) return null;
  return await calculateLateHoursForUser(userId, new Date(newTimeIn));
}

async function verifyLocationRestriction(userId, userLat, userLng) {
  const restrictions = await prisma.locationRestriction.findMany({
    where: { userId, restrictionStatus: true },
    include: { location: true },
  });

  if (!restrictions.length) return { allowed: true };

  if (userLat == null || userLng == null) {
    return {
      allowed: false,
      reason:
        "Location services disabled or location data missing. You must enable location to Time In/Out.",
    };
  }

  for (const r of restrictions) {
    const loc = r.location;
    if (!loc) continue;
    const distKm = calculateDistanceKm(
      Number(loc.latitude),
      Number(loc.longitude),
      Number(userLat),
      Number(userLng)
    );
    if (distKm * 1000 <= loc.radius) return { allowed: true };
  }

  return {
    allowed: false,
    reason: "You are not within any assigned location radius.",
  };
}

async function calculateLateHoursForUser(userId, punchInDate) {
  const dayStart = new Date(punchInDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);

  const userShift = await prisma.userShift.findFirst({
    where: { userId, assignedDate: { gte: dayStart, lte: dayEnd } },
    include: { shift: true },
  });
  if (!userShift?.shift?.startTime) return null;

  const shiftRef = new Date(userShift.shift.startTime);
  const shiftStart = new Date(punchInDate);
  shiftStart.setHours(shiftRef.getUTCHours(), shiftRef.getUTCMinutes(), 0, 0);

  if (punchInDate <= shiftStart) return 0;

  const minutesLate = (punchInDate - shiftStart) / 60000;
  return +(minutesLate / 60).toFixed(2);
}

// Valid punch types — mirrors the PunchType enum in the Prisma schema
const VALID_PUNCH_TYPES = [
  "REGULAR",
  "DRIVER_AIDE",
  "DRIVER_AIDE_AM",
  "DRIVER_AIDE_PM",
  "TRAINING",
];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/timelogs/today-shift
// ─────────────────────────────────────────────────────────────────────────────
const getTodayShift = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id;

    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const userShift = await prisma.userShift.findFirst({
      where: {
        userId,
        assignedDate: { gte: dayStart, lte: dayEnd },
      },
      include: { shift: true },
    });

    if (!userShift) {
      return res.status(200).json({ data: null });
    }

    const parseShiftTime = (isoString) => {
      if (!isoString) return null;
      const d = new Date(isoString);
      return { hours: d.getUTCHours(), minutes: d.getUTCMinutes() };
    };

    const startParsed = parseShiftTime(userShift.shift?.startTime);
    const endParsed   = parseShiftTime(userShift.shift?.endTime);

    const toTodayMs = (parsed) => {
      if (!parsed) return null;
      const d = new Date(now);
      d.setHours(parsed.hours, parsed.minutes, 0, 0);
      return d.getTime();
    };

    return res.status(200).json({
      data: {
        userShiftId:      userShift.id,
        shiftId:          userShift.shiftId,
        shiftName:        userShift.shift?.shiftName   ?? null,
        assignedDate:     userShift.assignedDate,
        scheduledStartMs: toTodayMs(startParsed),
        scheduledEndMs:   toTodayMs(endParsed),
        crossesMidnight:  userShift.shift?.crossesMidnight ?? false,
      },
    });
  } catch (err) {
    console.error("getTodayShift error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/timelogs/time-in
// ─────────────────────────────────────────────────────────────────────────────
const timeIn = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id;

    const activeLog = await prisma.timeLog.findFirst({
      where: { userId, status: true },
    });
    if (activeLog)
      return res.status(400).json({ message: "User already timed in." });

    // ✅ FIX: destructure `remarks` from request body
    const { localTimestamp, deviceInfo, location, punchType, reason, remarks } = req.body;

    const actualTimeIn = localTimestamp ? new Date(localTimestamp) : new Date();

    const resolvedPunchType = resolvePunchType({ punchType, reason });

    // ✅ Validate remarks — must be an array of objects with type + message
    // Sanitize to prevent storing arbitrary data
    const resolvedRemarks = Array.isArray(remarks)
      ? remarks
          .filter((r) => r && typeof r.type === "string" && typeof r.message === "string")
          .map((r) => ({
            type:      r.type.slice(0, 50),       // cap field lengths
            message:   r.message.slice(0, 500),
            timestamp: r.timestamp || new Date().toISOString(),
          }))
      : [];

    const locCheck = await verifyLocationRestriction(
      userId,
      location?.latitude,
      location?.longitude
    );
    if (!locCheck.allowed)
      return res.status(400).json({ message: locCheck.reason });

    const lateHours = await calculateLateHoursForUser(userId, actualTimeIn);

    const newTimeLog = await prisma.timeLog.create({
      data: {
        userId,
        timeIn:    actualTimeIn,
        lateHours,
        punchType: resolvedPunchType,
        // ✅ FIX: save remarks — stores [{type, message, timestamp}] or []
        remarks:   resolvedRemarks,
        deviceInfo: { start: deviceInfo ?? null, end: null },
        location:   { start: location   ?? null, end: null },
        coffeeBreaks: [],
        lunchBreak:   null,
      },
    });

    // Register in LiveUser table for auto clock-out tracking (non-fatal)
    createLiveUser(userId, newTimeLog.id, actualTimeIn).catch(() => {});

    getIO()
      .to(userId)
      .emit("timeLogUpdated", { type: "timeIn", data: newTimeLog });

    return res
      .status(201)
      .json({ message: "Time in recorded successfully.", data: newTimeLog });
  } catch (err) {
    console.error("Error in timeIn:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/timelogs/time-out
// ─────────────────────────────────────────────────────────────────────────────
const timeOut = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id;

    const activeLog = await prisma.timeLog.findFirst({
      where: { userId, status: true },
    });
    if (!activeLog)
      return res.status(400).json({ message: "No active time log found." });

    const { localTimestamp, deviceInfo, location, punchType, reason, autoLunchApplied, autoLunchMinutes } = req.body;
    const actualTimeOut = localTimestamp ? new Date(localTimestamp) : new Date();

    const locCheck = await verifyLocationRestriction(
      userId,
      location?.latitude,
      location?.longitude
    );
    if (!locCheck.allowed)
      return res.status(400).json({ message: locCheck.reason });

    const updateData = {
      timeOut: actualTimeOut,
      status:  false,
      deviceInfo: {
        start: activeLog.deviceInfo?.start ?? null,
        end:   deviceInfo ?? null,
      },
      location: {
        start: activeLog.location?.start ?? null,
        end:   location ?? null,
      },
    };

    if (punchType && VALID_PUNCH_TYPES.includes(punchType)) {
      updateData.punchType = punchType;
    } else {
      const fromReason = punchTypeFromReason(reason);
      if (fromReason) updateData.punchType = fromReason;
    }

    if (autoLunchApplied === true && Number.isInteger(autoLunchMinutes) && autoLunchMinutes > 0) {
      updateData.autoLunchDeductionMinutes = autoLunchMinutes;
    }

    const updatedTimeLog = await prisma.timeLog.update({
      where: { id: activeLog.id },
      data:  updateData,
    });

    // Remove from LiveUser table (self clock-out — non-fatal)
    removeLiveUser(userId).catch(() => {});

    // ── Phase 2.5: Auto-break injection ──────────────────────────────────────
    // Injects lunch/coffee break records when company has auto-break configured
    // and the employee did not take them manually. Non-fatal.
    try {
      await applyAutoBreaks(updatedTimeLog.id, userId);
    } catch (autoBreakErr) {
      console.error(`[timeOut] applyAutoBreaks failed for ${updatedTimeLog.id}:`, autoBreakErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Phase 3: Eager compute of derived fields at clock-out ─────────────────
    // Runs synchronously before response is sent so the client immediately
    // receives accurate lateHours, undertimeHours, netWorkedHours, etc.
    // Failure is non-fatal — the clock-out itself is already persisted.
    try {
      const derived = await computeTimeLogSummary(updatedTimeLog.id);
      if (derived) {
        Object.assign(updatedTimeLog, derived);
      }
    } catch (computeErr) {
      console.error(`[timeOut] computeTimeLogSummary failed for ${updatedTimeLog.id}:`, computeErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    getIO()
      .to(userId)
      .emit("timeLogUpdated", { type: "timeOut", data: updatedTimeLog });

    return res.status(200).json({
      message: "Time out recorded successfully.",
      data: updatedTimeLog,
    });
  } catch (err) {
    console.error("Error in timeOut:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const VALID_PUNCH_TYPES_SET = new Set(["REGULAR", "DRIVER_AIDE_AM", "DRIVER_AIDE_PM", "DRIVER_AIDE", "TRAINING"]);

const getUserTimeLogs = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id;

    // ── Query params ──────────────────────────────────────────────────────────
    const page      = Math.max(1, parseInt(req.query.page)  || 1);
    const limit     = Math.min(10000, Math.max(1, parseInt(req.query.limit) || 10));
    const skip      = (page - 1) * limit;
    const punchType = VALID_PUNCH_TYPES_SET.has(req.query.punchType) ? req.query.punchType : null;

    // ── Timezone-aware date bounds ─────────────────────────────────────────────
    // from/to arrive as bare YYYY-MM-DD strings from the client.
    // Interpret them as start/end of day in the company's timezone so that
    // California (PDT = UTC-7) records — stored in UTC — are not excluded.
    const userRecord = await prisma.user.findUnique({
      where:  { id: userId },
      select: { company: { select: { timeZone: true } } },
    });
    const tz   = userRecord?.company?.timeZone || "UTC";
    const from = req.query.from ? moment.tz(req.query.from, "YYYY-MM-DD", tz).startOf("day").toDate() : null;
    const to   = req.query.to   ? moment.tz(req.query.to,   "YYYY-MM-DD", tz).endOf("day").toDate()   : null;

    // ── Prisma where clause ──────────────────────────────────────────────────
    const where = { userId };
    if (from || to) {
      where.timeIn = {};
      if (from) where.timeIn.gte = from;
      if (to)   where.timeIn.lte = to;
    }
    if (req.query.status === "active")    where.status = true;
    if (req.query.status === "completed") where.status = false;
    if (punchType) where.punchType = punchType;

    // ── Paginated data + total count (parallel) ───────────────────────────────
    const [logs, total] = await Promise.all([
      prisma.timeLog.findMany({
        where,
        orderBy: { timeIn: "desc" },
        skip,
        take: limit,
        include: {
          overtime: { orderBy: { createdAt: "desc" } },
          approvals: {
            select: {
              id:     true,
              status: true,
              segmentType: true,
              actualHours: true,
              cutoffPeriod: {
                select: {
                  id:          true,
                  periodStart: true,
                  periodEnd:   true,
                  status:      true,
                },
              },
            },
            take: 1,
            orderBy: { createdAt: "desc" },
          },
        },
      }),
      prisma.timeLog.count({ where }),
    ]);

    // ── Summary — active/completed counts + totalHours across full filtered set
    // totalHours uses raw SQL since Prisma can't SUM a computed interval.
    // Active/completed counts always reflect the full filter (date, punchType)
    // regardless of the status filter, so the cards show a breakdown of the range.
    const baseWhere = { userId };
    if (from || to) {
      baseWhere.timeIn = {};
      if (from) baseWhere.timeIn.gte = from;
      if (to)   baseWhere.timeIn.lte = to;
    }
    if (punchType) baseWhere.punchType = punchType;

    // Build raw SQL conditions for totalHours
    const hoursConditions = [
      Prisma.sql`"userId" = ${userId}`,
      Prisma.sql`"status" = false`,
      Prisma.sql`"timeOut" IS NOT NULL`,
    ];
    if (from)      hoursConditions.push(Prisma.sql`"timeIn" >= ${from}`);
    if (to)        hoursConditions.push(Prisma.sql`"timeIn" <= ${to}`);
    if (punchType) hoursConditions.push(Prisma.sql`"punchType"::text = ${punchType}`);

    const [activeCount, completedCount, [hoursRow]] = await Promise.all([
      prisma.timeLog.count({ where: { ...baseWhere, status: true } }),
      prisma.timeLog.count({ where: { ...baseWhere, status: false } }),
      prisma.$queryRaw`
        SELECT COALESCE(
          SUM(EXTRACT(EPOCH FROM ("timeOut" - "timeIn")) / 3600), 0
        )::float AS "totalHours"
        FROM "TimeLog"
        WHERE ${Prisma.join(hoursConditions, " AND ")}
      `,
    ]);

    // ── Batch UserShift lookup — one query covers all log dates in the page ──
    const shiftNameMap = {};
    if (logs.length) {
      const sorted = [...new Set(logs.map((l) => moment.tz(l.timeIn, tz).format("YYYY-MM-DD")))].sort();
      const rangeStart = moment.tz(sorted[0],                  "YYYY-MM-DD", tz).startOf("day").toDate();
      const rangeEnd   = moment.tz(sorted[sorted.length - 1],  "YYYY-MM-DD", tz).endOf("day").toDate();
      const userShifts = await prisma.userShift.findMany({
        where:  { userId, assignedDate: { gte: rangeStart, lte: rangeEnd } },
        select: { assignedDate: true, shift: { select: { shiftName: true } } },
      });
      userShifts.forEach((s) => {
        const key = s.assignedDate.toISOString().slice(0, 10);
        shiftNameMap[key] = s.shift?.shiftName ?? null;
      });
    }

    // ── Shape response ────────────────────────────────────────────────────────
    const isBnC = BNC_COMPANY_IDS.has(req.user.companyId);
    const data = logs.map((l) => ({
      ...l,
      timeIn:          l.timeIn  ? l.timeIn.toISOString()  : null,
      timeOut:         l.timeOut ? l.timeOut.toISOString() : null,
      netWorkedHours:        l.netWorkedHours        != null ? parseFloat(l.netWorkedHours)        : null,
      lateHours:             l.lateHours             != null ? parseFloat(l.lateHours)             : null,
      undertimeHours:        l.undertimeHours        != null ? parseFloat(l.undertimeHours)        : null,
      regularSegmentHours:   isBnC ? undefined : (l.regularSegmentHours   != null ? parseFloat(l.regularSegmentHours)   : null),
      driverAmSegmentHours:  isBnC ? undefined : (l.driverAmSegmentHours  != null ? parseFloat(l.driverAmSegmentHours)  : null),
      driverPmSegmentHours:  isBnC ? undefined : (l.driverPmSegmentHours  != null ? parseFloat(l.driverPmSegmentHours)  : null),
      grossHours:            l.grossHours            != null ? parseFloat(l.grossHours)            : null,
      scheduledHours:        l.scheduledHours        != null ? parseFloat(l.scheduledHours)        : null,
      cutoffApproval:  l.approvals?.[0]
        ? { ...l.approvals[0], actualHours: l.approvals[0].actualHours != null ? parseFloat(l.approvals[0].actualHours) : null }
        : null,
      approvals:       undefined,
      overtime:        isBnC ? undefined : l.overtime,
      shiftName:       shiftNameMap[moment.tz(l.timeIn, tz).format("YYYY-MM-DD")] ?? null,
    }));

    return res.status(200).json({
      message:     "Time logs retrieved.",
      companyType: isBnC ? "BNC" : "DAYCARE",
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        total:      activeCount + completedCount,
        active:     activeCount,
        completed:  completedCount,
        totalHours: parseFloat((hoursRow.totalHours ?? 0).toFixed(2)),
      },
    });
  } catch (err) {
    console.error("Error fetching user logs:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const deleteTimeLog = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    const log = await prisma.timeLog.findUnique({ where: { id } });
    if (!log) return res.status(404).json({ message: "Time log not found." });
    if (log.userId !== req.user.id)
      return res.status(403).json({ message: "Not your time log." });
    await prisma.timeLog.delete({ where: { id } });
    getIO()
      .to(req.user.id)
      .emit("timeLogUpdated", { type: "delete", data: { id } });
    return res.status(200).json({ message: "Time log deleted." });
  } catch (err) {
    console.error("Error deleting log:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const coffeeBreakStart = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id;
    const activeLog = await prisma.timeLog.findFirst({
      where: { userId, status: true },
    });
    if (!activeLog)
      return res.status(400).json({ message: "No active time log found." });
    let breaks = Array.isArray(activeLog.coffeeBreaks) ? activeLog.coffeeBreaks : [];
    if (breaks.find((b) => b.end === null))
      return res.status(400).json({ message: "A coffee break is already active." });
    if (breaks.length >= 2)
      return res.status(400).json({ message: "Maximum coffee breaks reached." });
    breaks.push({ start: new Date().toISOString(), end: null });
    const updated = await prisma.timeLog.update({
      where: { id: activeLog.id },
      data:  { coffeeBreaks: breaks },
    });
    getIO().to(userId).emit("timeLogUpdated", { type: "coffeeBreakStart", data: updated });
    return res.status(200).json({ message: "Coffee break started.", data: updated });
  } catch (err) {
    console.error("Coffee break start error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const coffeeBreakEnd = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id;
    const activeLog = await prisma.timeLog.findFirst({
      where: { userId, status: true },
    });
    if (!activeLog)
      return res.status(400).json({ message: "No active time log found." });
    let breaks = Array.isArray(activeLog.coffeeBreaks) ? activeLog.coffeeBreaks : [];
    const i = breaks.findIndex((b) => b.end === null);
    if (i === -1)
      return res.status(400).json({ message: "No active coffee break to end." });
    breaks[i].end = new Date().toISOString();
    const updated = await prisma.timeLog.update({
      where: { id: activeLog.id },
      data:  { coffeeBreaks: breaks },
    });
    getIO().to(userId).emit("timeLogUpdated", { type: "coffeeBreakEnd", data: updated });
    return res.status(200).json({ message: "Coffee break ended.", data: updated });
  } catch (err) {
    console.error("Coffee break end error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const lunchBreakStart = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id;
    const activeLog = await prisma.timeLog.findFirst({
      where: { userId, status: true },
    });
    if (!activeLog)
      return res.status(400).json({ message: "No active time log found." });
    if (activeLog.lunchBreak?.start && !activeLog.lunchBreak.end)
      return res.status(400).json({ message: "Lunch break already started." });
    const updated = await prisma.timeLog.update({
      where: { id: activeLog.id },
      data:  { lunchBreak: { start: new Date().toISOString(), end: null } },
    });
    getIO().to(userId).emit("timeLogUpdated", { type: "lunchBreakStart", data: updated });
    return res.status(200).json({ message: "Lunch break started.", data: updated });
  } catch (err) {
    console.error("Lunch break start error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const lunchBreakEnd = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id;
    const activeLog = await prisma.timeLog.findFirst({
      where: { userId, status: true },
    });
    if (!activeLog)
      return res.status(400).json({ message: "No active time log found." });
    if (!activeLog.lunchBreak?.start || activeLog.lunchBreak?.end)
      return res.status(400).json({ message: "No active lunch break to end." });
    const updated = await prisma.timeLog.update({
      where: { id: activeLog.id },
      data: {
        lunchBreak: { ...activeLog.lunchBreak, end: new Date().toISOString() },
      },
    });
    getIO().to(userId).emit("timeLogUpdated", { type: "lunchBreakEnd", data: updated });
    return res.status(200).json({ message: "Lunch break ended.", data: updated });
  } catch (err) {
    console.error("Lunch break end error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getCompanyTimeLogs = async (req, res) => {
  try {
    const companyId   = req.user.companyId;
    const employeeId  = req.query.employeeId   || null;
    const departmentId= req.query.departmentId || null;
    const punchType   = VALID_PUNCH_TYPES_SET.has(req.query.punchType) ? req.query.punchType : null;
    const page        = parseInt(req.query.page)  > 0 ? parseInt(req.query.page)  : 1;
    const limit       = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 20;
    const skip        = (page - 1) * limit;

    // ── Timezone-aware date bounds ────────────────────────────────────────────
    // from/to arrive as bare YYYY-MM-DD strings.
    // Interpret as start/end of day in the company timezone so PDT records
    // stored in UTC are not cut off at UTC midnight.
    const company = await prisma.company.findUnique({
      where:  { id: companyId },
      select: { timeZone: true, dailyOtThresholdHours: true, otBasis: true },
    });
    const tz   = company?.timeZone || "UTC";
    const from = req.query.from ? moment.tz(req.query.from, "YYYY-MM-DD", tz).startOf("day").toDate() : null;
    const to   = req.query.to   ? moment.tz(req.query.to,   "YYYY-MM-DD", tz).endOf("day").toDate()   : null;

    // ── Prisma where clause ───────────────────────────────────────────────────
    const where = { user: { companyId } };
    if (employeeId)   where.userId    = employeeId;
    if (departmentId) where.user      = { companyId, departmentId };
    if (punchType)    where.punchType = punchType;
    if (req.query.status === "active")    where.status = true;
    if (req.query.status === "completed") where.status = false;
    if (from || to) {
      where.timeIn = {};
      if (from) where.timeIn.gte = from;
      if (to)   where.timeIn.lte = to;
    }

    // ── Build summary conditions once, shared by counts + hours ─────────────
    const summaryConditions = [Prisma.sql`u."companyId" = ${companyId}`];
    if (from)         summaryConditions.push(Prisma.sql`t."timeIn" >= ${from}`);
    if (to)           summaryConditions.push(Prisma.sql`t."timeIn" <= ${to}`);
    if (employeeId)   summaryConditions.push(Prisma.sql`t."userId" = ${employeeId}`);
    if (departmentId) summaryConditions.push(Prisma.sql`u."departmentId" = ${departmentId}`);
    if (punchType)    summaryConditions.push(Prisma.sql`t."punchType"::text = ${punchType}`);

    // ── All independent queries in one round-trip ─────────────────────────────
    const [logs, total, [summaryRow]] = await Promise.all([
      prisma.timeLog.findMany({
        where,
        orderBy: { timeIn: "desc" },
        select: {
          id:                    true,
          timeIn:                true,
          timeOut:               true,
          status:                true,
          punchType:             true,
          lateHours:             true,
          undertimeHours:        true,
          netWorkedHours:        true,
          lunchDeductionMinutes: true,
          totalBreakMinutes:     true,
          regularSegmentHours:   true,
          driverAmSegmentHours:  true,
          driverPmSegmentHours:  true,
          rawOtMinutes:          true,
          grossHours:            true,
          scheduledHours:        true,
          coffeeBreaks:          true,
          lunchBreak:            true,
          deviceInfo:            true,
          location:              true,
          autoClockOut:          true,
          autoClockOutAt:        true,
          remarks:               true,
          user: {
            select: {
              id:         true,
              email:      true,
              employeeId: true,
              profile:          { select: { firstName: true, lastName: true } },
              department:       { select: { name: true } },
              presence:         { select: { presenceStatus: true } },
              employmentDetail: { select: { jobTitle: true } },
            },
          },
          approvals: {
            select: {
              id:     true,
              status: true,
              segmentType: true,
              actualHours: true,
              cutoffPeriod: {
                select: { id: true, periodStart: true, periodEnd: true, status: true },
              },
            },
            take: 1,
            orderBy: { createdAt: "desc" },
          },
          overtime: {
            select: {
              id:               true,
              status:           true,
              requestedHours:   true,
              requesterReason:  true,
              approverComments: true,
              createdAt:        true,
              updatedAt:        true,
            },
            orderBy: { updatedAt: "desc" },
          },
        },
        skip,
        take: limit,
      }),
      prisma.timeLog.count({ where }),
      prisma.$queryRaw`
        SELECT
          COUNT(*) FILTER (WHERE t."status" = true)::int  AS "activeCount",
          COUNT(*) FILTER (WHERE t."status" = false)::int AS "completedCount",
          COALESCE(
            SUM(EXTRACT(EPOCH FROM (t."timeOut" - t."timeIn")) / 3600)
              FILTER (WHERE t."status" = false AND t."timeOut" IS NOT NULL),
            0
          )::float AS "totalHours"
        FROM "TimeLog" t
        INNER JOIN "User" u ON t."userId" = u.id
        WHERE ${Prisma.join(summaryConditions, " AND ")}
      `,
    ]);

    const activeCount   = Number(summaryRow.activeCount);
    const completedCount = Number(summaryRow.completedCount);
    const totalHours    = parseFloat(summaryRow.totalHours ?? 0);

    // ── shiftToday — use company timezone for day boundaries ──────────────────
    const isBnC = BNC_COMPANY_IDS.has(companyId);

    // ── BNC: fetch OT blocks for the queried date range ───────────────────────
    let otBlocks = [];
    if (isBnC) {
      const otBlockWhere = { cutoffPeriod: { companyId } };
      if (from || to) {
        otBlockWhere.date = {};
        if (from) otBlockWhere.date.gte = new Date(req.query.from);
        if (to)   otBlockWhere.date.lte = new Date(req.query.to);
      }
      if (employeeId)   otBlockWhere.userId = employeeId;
      if (departmentId) otBlockWhere.user   = { departmentId };

      const rawBlocks = await prisma.cutoffOtBlock.findMany({
        where:   otBlockWhere,
        orderBy: [{ date: "asc" }],
        select:  { id: true, userId: true, date: true, otHours: true, status: true, approvedAt: true, notes: true },
      });

      otBlocks = rawBlocks.map((b) => ({
        id:         b.id,
        userId:     b.userId,
        date:       b.date.toISOString().slice(0, 10),
        otHours:    parseFloat(b.otHours),
        status:     b.status,
        approvedAt: b.approvedAt ? b.approvedAt.toISOString() : null,
        notes:      b.notes ?? null,
      }));
    }
    const rows = logs.map((l) => ({
      id:                   l.id,
      userId:               l.user.id,
      employeeName:         `${l.user.profile?.firstName || ""} ${l.user.profile?.lastName || ""}`.trim(),
      employeeRole:         l.user.employmentDetail?.jobTitle || null,
      employeeCode:         l.user.employeeId || null,
      email:                l.user.email,
      department:           l.user.department?.name || "—",
      timeIn:               l.timeIn  ? l.timeIn.toISOString()  : null,
      timeOut:              l.timeOut ? l.timeOut.toISOString() : null,
      status:               l.status ? "active" : "completed",
      punchType:            l.punchType ?? "REGULAR",
      // computed fields
      lateHours:            l.lateHours            != null ? parseFloat(l.lateHours)            : null,
      undertimeHours:       l.undertimeHours        != null ? parseFloat(l.undertimeHours)       : null,
      netWorkedHours:       l.netWorkedHours        != null ? parseFloat(l.netWorkedHours)       : null,
      lunchDeductionMinutes:l.lunchDeductionMinutes ?? null,
      totalBreakMinutes:    l.totalBreakMinutes     ?? null,
      ...(!isBnC && {
        regularSegmentHours:  l.regularSegmentHours  != null ? parseFloat(l.regularSegmentHours)  : null,
        driverAmSegmentHours: l.driverAmSegmentHours != null ? parseFloat(l.driverAmSegmentHours) : null,
        driverPmSegmentHours: l.driverPmSegmentHours != null ? parseFloat(l.driverPmSegmentHours) : null,
        rawOtMinutes:         l.rawOtMinutes         ?? null,
        otStatus:             null, // populated below for cutoff-basis OT companies
      }),
      grossHours:           l.grossHours            != null ? parseFloat(l.grossHours)           : null,
      scheduledHours:       l.scheduledHours        != null ? parseFloat(l.scheduledHours)       : null,
      // break details
      coffeeBreaks:         l.coffeeBreaks ?? [],
      lunchBreak:           l.lunchBreak  ?? null,
      coffeeCount:          (l.coffeeBreaks ?? []).length,
      lunchTaken:           !!l.lunchBreak?.end,
      // device / location
      deviceIn:             l.deviceInfo?.start ?? null,
      deviceOut:            l.deviceInfo?.end   ?? null,
      locIn:                l.location?.start   ?? null,
      locOut:               l.location?.end     ?? null,
      // auto clock-out
      autoClockOut:         l.autoClockOut   ?? false,
      autoClockOutAt:       l.autoClockOutAt ?? null,
      // misc
      remarks:              l.remarks ?? [],
      presence:             l.user.presence?.presenceStatus || "unknown",
      shiftToday:           null,
      userShift:            null,
      userShifts:           [],
      cutoffApproval:       l.approvals?.[0]
        ? { ...l.approvals[0], actualHours: l.approvals[0].actualHours != null ? parseFloat(l.approvals[0].actualHours) : null }
        : null,
      // OT requests linked to this punch log — DayCare only; B&C OT is cutoff-level aggregate
      ...(!isBnC && {
        overtime: (l.overtime ?? []).map((ot) => ({
          ...ot,
          requestedHours: ot.requestedHours != null ? parseFloat(ot.requestedHours) : null,
          createdAt:      ot.createdAt.toISOString(),
          updatedAt:      ot.updatedAt.toISOString(),
        })),
      }),
    }));

    if (rows.length) {
      const userIds = [...new Set(rows.map((r) => r.userId))];

      if (isBnC) {
        // BNC: query UserShifts by punch date so historical records show
        // the correct shift, not today's. Then use matchShiftToWindow to
        // pin each punch to its specific shift window.
        const punchDates = rows.map((r) => moment(r.timeIn).tz(tz).format("YYYY-MM-DD")).sort();
        const rangeStart = new Date(punchDates[0]);
        const rangeEnd   = new Date(punchDates[punchDates.length - 1]);

        const shiftRows = await prisma.userShift.findMany({
          where: {
            userId:       { in: userIds },
            assignedDate: { gte: rangeStart, lte: rangeEnd },
            status:       { not: "cancelled" },
          },
          include: { shift: true },
        });

        // Map: "userId:YYYY-MM-DD" → [shaped shift objects]
        const shiftMap = {};
        shiftRows.forEach((s) => {
          const dateStr = s.assignedDate instanceof Date
            ? s.assignedDate.toISOString().slice(0, 10)
            : String(s.assignedDate).slice(0, 10);
          const key = `${s.userId}:${dateStr}`;
          if (!shiftMap[key]) shiftMap[key] = [];
          const shaped = {
            id:           s.id,
            assignedDate: dateStr,
            shift: {
              id:        s.shift?.id        ?? null,
              shiftName: s.shift?.shiftName ?? null,
              startTime: s.shift?.startTime ?? null,
              endTime:   s.shift?.endTime   ?? null,
            },
          };
          if (!shiftMap[key].some((x) => x.shift.id === shaped.shift.id)) {
            shiftMap[key].push(shaped);
          }
        });

        rows.forEach((r) => {
          const punchDate = moment(r.timeIn).tz(tz).format("YYYY-MM-DD");
          const key       = `${r.userId}:${punchDate}`;
          const shifts    = shiftMap[key] ?? [];
          const matched   = shifts.length > 1
            ? matchShiftToWindow(shifts, new Date(r.timeIn), new Date(r.timeOut ?? r.timeIn), tz)
            : shifts[0] ?? null;
          r.userShift  = matched;
          r.userShifts = shifts;
          r.shiftToday = shifts.map((s) => s.shift.shiftName).filter(Boolean);
        });

      } else {
        // DayCare: original behavior — query today's shifts unchanged.
        const dayStart  = moment().tz(tz).startOf("day").toDate();
        const dayEnd    = moment().tz(tz).endOf("day").toDate();
        const shiftRows = await prisma.userShift.findMany({
          where: { userId: { in: userIds }, assignedDate: { gte: dayStart, lte: dayEnd } },
          include: { shift: true },
        });
        const shiftMap = {};
        shiftRows.forEach((s) => {
          if (!shiftMap[s.userId]) shiftMap[s.userId] = [];
          if (s.shift?.id && shiftMap[s.userId].some((x) => x.shift.id === s.shift.id)) return;
          shiftMap[s.userId].push({
            id:           s.id,
            assignedDate: s.assignedDate.toISOString().slice(0, 10),
            shift: {
              id:        s.shift?.id        ?? null,
              shiftName: s.shift?.shiftName ?? null,
              startTime: s.shift?.startTime ?? null,
              endTime:   s.shift?.endTime   ?? null,
            },
          });
        });
        rows.forEach((r) => {
          const shifts  = shiftMap[r.userId] ?? [];
          r.shiftToday  = shifts.map((s) => s.shift.shiftName).filter(Boolean).join(", ") || "—";
          r.userShifts  = shifts;
          r.userShift   = shifts[0] ?? null;
        });
      }
    }

    // ── DayCare cutoff-basis OT Status ───────────────────────────────────────
    // For companies where otBasis = "cutoff" (80h/period), per-punch rawOtMinutes
    // is irrelevant. OT Status is derived from the CutoffOtBlock for the employee's
    // cutoff period: "-" (no block), "Included" (block pending), "Approved" (block approved).
    if (!isBnC && company?.otBasis === "cutoff" && rows.length > 0) {
      const pairs  = [];
      const seen   = new Set();
      for (const r of rows) {
        const cpId = r.cutoffApproval?.cutoffPeriod?.id;
        if (cpId) {
          const key = `${r.userId}:${cpId}`;
          if (!seen.has(key)) { seen.add(key); pairs.push({ userId: r.userId, cpId }); }
        }
      }

      if (pairs.length > 0) {
        const userIds = [...new Set(pairs.map((p) => p.userId))];
        const cpIds   = [...new Set(pairs.map((p) => p.cpId))];

        const otBlocks = await prisma.cutoffOtBlock.findMany({
          where:  { userId: { in: userIds }, cutoffPeriodId: { in: cpIds } },
          select: { userId: true, cutoffPeriodId: true, status: true },
        });

        const blockMap = {};
        for (const b of otBlocks) blockMap[`${b.userId}:${b.cutoffPeriodId}`] = b.status;

        for (const r of rows) {
          const cpId       = r.cutoffApproval?.cutoffPeriod?.id;
          const blockStatus = cpId ? blockMap[`${r.userId}:${cpId}`] : undefined;
          r.otStatus = !blockStatus           ? "-"
                     : blockStatus === "approved" ? "Approved"
                     : "Included";
        }
      }
    }

    return res.status(200).json({
      message:     "Time logs retrieved.",
      companyType: isBnC ? "BNC" : "DAYCARE",
      ...(isBnC && {
        dailyOtThresholdHours: parseFloat(company?.dailyOtThresholdHours ?? 8),
        otBlocks,
      }),
      data:        rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        total:      activeCount + completedCount,
        active:     activeCount,
        completed:  completedCount,
        totalHours: parseFloat(totalHours.toFixed(2)),
      },
    });
  } catch (err) {
    console.error("Error fetching company logs:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const updateTimeLogDateTime = async (req, res) => {
  try {
    const { id } = req.params;
    const { timeIn, timeOut } = req.body;

    if (!timeIn && !timeOut)
      return res.status(400).json({ message: "No fields provided." });

    const log = await prisma.timeLog.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!log) return res.status(404).json({ message: "Time log not found." });
    if (req.user.companyId !== log.user.companyId)
      return res.status(403).json({ message: "Access denied: different company." });

    const data = {};
    if (timeIn)  data.timeIn  = new Date(timeIn);
    if (timeOut) data.timeOut = new Date(timeOut);

    const updated = await prisma.timeLog.update({ where: { id }, data });

    // Recompute all derived fields whenever timeIn or timeOut is corrected.
    // Only runs if the log is completed (timeOut present) — active logs are
    // computed at clock-out.
    const resolvedTimeOut = timeOut ?? log.timeOut;
    if (resolvedTimeOut) {
      try {
        const derived = await computeTimeLogSummary(id);
        if (derived) Object.assign(updated, derived);
      } catch (computeErr) {
        console.error(`[updateTimeLogDateTime] computeTimeLogSummary failed for ${id}:`, computeErr.message);
      }
    }

    getIO()
      .to(log.userId)
      .emit("timeLogUpdated", { type: "manualUpdate", data: updated });

    return res.status(200).json({ message: "Time log updated.", data: updated });
  } catch (err) {
    console.error("updateTimeLogDateTime error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

/**
 * DELETE /api/time-logs/:id/auto-breaks
 * Admin-only. Removes auto-injected lunch and/or coffee breaks from a TimeLog
 * and resets the applied flags so the record is in a correctable state.
 * Triggers a full recompute after clearing.
 *
 * Body: { lunch: boolean, coffee: boolean }
 * At least one must be true.
 */
const ADMIN_ROLES = new Set(["admin", "superadmin", "hr", "supervisor"]);

// Checks whether a TimeLog is tied to a locked or processed cutoff period.
// Returns the conflicting CutoffPeriod if found, null otherwise.
async function getLockedCutoffForLog(timeLogId) {
  const approval = await prisma.timeLogApproval.findFirst({
    where: {
      timeLogId,
      cutoffPeriodId: { not: null },
      cutoffPeriod: { status: { in: ["locked", "processed"] } },
    },
    select: { cutoffPeriod: { select: { id: true, status: true, periodStart: true, periodEnd: true } } },
  });
  return approval?.cutoffPeriod ?? null;
}

/**
 * PATCH /api/timelogs/:id/punch-type
 * Admin/HR/supervisor. Updates the punch type on an existing log and
 * immediately recomputes all segment/hour derived fields.
 * Blocked if the log is part of a locked or processed cutoff period.
 */
const updatePunchType = async (req, res) => {
  try {
    const { id } = req.params;
    const { punchType } = req.body;

    if (!ADMIN_ROLES.has(req.user.role))
      return res.status(403).json({ message: "Admin access required." });

    if (!VALID_PUNCH_TYPES.includes(punchType))
      return res.status(400).json({ message: `Invalid punchType. Allowed: ${VALID_PUNCH_TYPES.join(", ")}` });

    const log = await prisma.timeLog.findUnique({
      where:  { id },
      select: { userId: true, timeOut: true, user: { select: { companyId: true } } },
    });
    if (!log) return res.status(404).json({ message: "Time log not found." });
    if (log.user.companyId !== req.user.companyId)
      return res.status(403).json({ message: "Access denied: different company." });

    const lockedCutoff = await getLockedCutoffForLog(id);
    if (lockedCutoff)
      return res.status(409).json({ message: "Cannot update a log that is part of a locked or processed cutoff period." });

    const updated = await prisma.timeLog.update({ where: { id }, data: { punchType } });

    if (log.timeOut) {
      if (punchType === "TRAINING") {
        const company = await prisma.company.findUnique({
          where:  { id: log.user.companyId },
          select: { defaultShiftHours: true },
        });
        const trainingHours = parseFloat((company?.defaultShiftHours ?? 8).toString());
        const trainingUpdate = await prisma.timeLog.update({
          where: { id },
          data:  { netWorkedHours: trainingHours, scheduledHours: trainingHours },
        });
        Object.assign(updated, trainingUpdate);
      } else {
        try {
          const derived = await computeTimeLogSummary(id);
          if (derived) Object.assign(updated, derived);
        } catch (computeErr) {
          console.error(`[updatePunchType] computeTimeLogSummary failed for ${id}:`, computeErr.message);
        }
      }
    }

    getIO().to(log.userId).emit("timeLogUpdated", { type: "punchTypeUpdated", data: updated });

    return res.status(200).json({ message: "Punch type updated.", data: updated });
  } catch (err) {
    console.error("updatePunchType error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

/**
 * DELETE /api/timelogs/:id
 * Admin/HR/supervisor hard-delete. Permanently removes a punch log.
 * Cascades to TimeLogApproval, ContestTimeLog, Overtime, etc. via schema.
 * Blocked if the log is part of a locked or processed cutoff period.
 */
const adminDeleteTimeLog = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ADMIN_ROLES.has(req.user.role))
      return res.status(403).json({ message: "Admin access required." });

    const log = await prisma.timeLog.findUnique({
      where:  { id },
      select: { userId: true, user: { select: { companyId: true } } },
    });
    if (!log) return res.status(404).json({ message: "Time log not found." });
    if (log.user.companyId !== req.user.companyId)
      return res.status(403).json({ message: "Access denied: different company." });

    const lockedCutoff = await getLockedCutoffForLog(id);
    if (lockedCutoff)
      return res.status(409).json({ message: "Cannot delete a log that is part of a locked or processed cutoff period." });

    await prisma.timeLog.delete({ where: { id } });

    getIO().to(log.userId).emit("timeLogUpdated", { type: "delete", data: { id } });

    return res.status(200).json({ message: "Deleted successfully." });
  } catch (err) {
    console.error("adminDeleteTimeLog error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const clearAutoBreaks = async (req, res) => {
  try {
    const { id } = req.params;
    const { lunch = false, coffee = false } = req.body;

    if (!lunch && !coffee)
      return res.status(400).json({ message: "Specify at least one: lunch or coffee." });

    if (!["admin", "superadmin"].includes(req.user.role))
      return res.status(403).json({ message: "Admin access required." });

    const log = await prisma.timeLog.findUnique({
      where:  { id },
      select: {
        userId:                    true,
        timeOut:                   true,
        autoLunchApplied:          true,
        autoCoffeeApplied:         true,
        lunchBreak:                true,
        coffeeBreaks:              true,
        user: { select: { companyId: true } },
      },
    });

    if (!log) return res.status(404).json({ message: "Time log not found." });
    if (log.user.companyId !== req.user.companyId)
      return res.status(403).json({ message: "Access denied: different company." });

    const data = {};

    if (lunch && log.autoLunchApplied) {
      data.lunchBreak                = null;
      data.autoLunchApplied          = false;
      data.autoLunchDeductionMinutes = null;
    }

    if (coffee && log.autoCoffeeApplied) {
      // Preserve any manual coffee breaks the employee took; remove only auto-injected ones.
      const existing = Array.isArray(log.coffeeBreaks) ? log.coffeeBreaks : [];
      const manual   = existing.filter((b) => !b.auto);
      data.coffeeBreaks      = manual.length > 0 ? manual : null;
      data.autoCoffeeApplied = false;
    }

    if (Object.keys(data).length === 0)
      return res.status(200).json({ message: "No auto-breaks were applied — nothing to clear." });

    const updated = await prisma.timeLog.update({ where: { id }, data });

    if (log.timeOut) {
      try {
        const derived = await computeTimeLogSummary(id);
        if (derived) Object.assign(updated, derived);
      } catch (computeErr) {
        console.error(`[clearAutoBreaks] computeTimeLogSummary failed for ${id}:`, computeErr.message);
      }
    }

    getIO().to(log.userId).emit("timeLogUpdated", { type: "autoBreakCleared", data: updated });

    return res.status(200).json({ message: "Auto-breaks cleared.", data: updated });
  } catch (err) {
    console.error("clearAutoBreaks error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = {
  timeIn,
  timeOut,
  getTodayShift,
  getUserTimeLogs,
  deleteTimeLog,
  coffeeBreakStart,
  coffeeBreakEnd,
  lunchBreakStart,
  lunchBreakEnd,
  getCompanyTimeLogs,
  updateTimeLogDateTime,
  clearAutoBreaks,
  updatePunchType,
  adminDeleteTimeLog,
};