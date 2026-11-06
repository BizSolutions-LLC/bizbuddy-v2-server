// src/controllers/Features/shiftScheduleController.js

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { format } = require("date-fns");
const {
  notifyEmployeeScheduleCreated,
  notifyManagementScheduleCreated,
} = require("@services/shiftNotificationService");

/**
 * Helper: Generate dates for recurring schedule
 */
const generateScheduleDates = (daysOfWeek, startDate, endDate) => {
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Ensure daysOfWeek contains numbers, not strings
  const daysAsNumbers = daysOfWeek.map(d => parseInt(d, 10));

  let current = new Date(start);
  while (current <= end) {
    const dayOfWeek = current.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    if (daysAsNumbers.includes(dayOfWeek)) {
      dates.push(format(current, 'yyyy-MM-dd'));
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
};

const formatScheduleDates = (schedule) => ({
  ...schedule,
  startDate: format(new Date(schedule.startDate), 'yyyy-MM-dd'),
  endDate:   format(new Date(schedule.endDate),   'yyyy-MM-dd'),
});

/**
 * Extract UTC minutes-since-midnight from a stored shift time.
 * Shift times are stored as ISO strings anchored to epoch date 1970-01-01,
 * e.g. "1970-01-01T08:00:00.000Z" → 480 minutes.
 */
const toMinutes = (isoTime) => {
  const d = new Date(isoTime);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/**
 * Returns true only when shiftA and shiftB have genuinely overlapping time windows.
 *
 * Key rule: strict inequality ( < / > ) means touching endpoints do NOT conflict.
 * Example: shiftA ends 08:00, shiftB starts 08:00 → no overlap → returns false.
 * This is exactly what allows Driver/Aide AM (06:45–08:00), Regular (08:00–13:30),
 * and Driver/Aide PM (13:30–14:45) to coexist on the same calendar date.
 *
 * Midnight-crossing shifts (e.g. 22:00–06:00) are split into two intervals
 * [22:00, 24:00) and [00:00, 06:00) so the comparison still works correctly.
 */
const timesOverlap = (shiftA, shiftB) => {
  const aStart = toMinutes(shiftA.startTime);
  const aEnd   = toMinutes(shiftA.endTime);
  const bStart = toMinutes(shiftB.startTime);
  const bEnd   = toMinutes(shiftB.endTime);

  // Does [s1, e1) overlap with [s2, e2)?  Strict so touching edges don't conflict.
  const overlaps = (s1, e1, s2, e2) => s1 < e2 && e1 > s2;

  // Build interval list — midnight-crossing shifts wrap into two intervals
  const toIntervals = (start, end, crosses) =>
    crosses ? [[start, 1440], [0, end]] : [[start, end]];

  const aIntervals = toIntervals(aStart, aEnd, shiftA.crossesMidnight);
  const bIntervals = toIntervals(bStart, bEnd, shiftB.crossesMidnight);

  for (const [s1, e1] of aIntervals) {
    for (const [s2, e2] of bIntervals) {
      if (overlaps(s1, e1, s2, e2)) return true;
    }
  }
  return false;
};

/**
 * Create a recurring shift schedule
 *
 * For assignmentType === 'individual': accepts targetIds (array of user IDs).
 * Creates one ShiftSchedule row per employee so each is independently editable.
 * Legacy single-value targetId is coerced to [targetId] for backward compat.
 *
 * For assignmentType === 'department' | 'all': unchanged — accepts targetId (string)
 * and creates one ShiftSchedule record covering all resolved users.
 */
const createShiftSchedule = async (req, res) => {
  try {
    const { shiftId, daysOfWeek, startDate, endDate, assignmentType, targetId, targetIds, replaceConflicts, skipConflicts } = req.body;
    const { companyId } = req.user;

    // Validation
    if (!shiftId || !Array.isArray(daysOfWeek) || daysOfWeek.length === 0 || !startDate || !endDate) {
      return res.status(400).json({
        message: "Missing required fields: shiftId, daysOfWeek (array), startDate, endDate"
      });
    }

    if (!['individual', 'department', 'all'].includes(assignmentType)) {
      return res.status(400).json({ message: "Invalid assignmentType. Must be: individual, department, or all" });
    }

    if (assignmentType === 'individual') {
      // Accept targetIds array, or coerce legacy targetId string
      const resolvedIds = targetIds ?? (targetId ? [targetId] : null);
      if (!Array.isArray(resolvedIds) || resolvedIds.length === 0) {
        return res.status(400).json({ message: "targetIds (array) required for individual assignment" });
      }
    } else if (assignmentType === 'department') {
      if (!targetId) {
        return res.status(400).json({ message: "targetId required for department assignment" });
      }
    }

    // Ensure daysOfWeek are stored as integers
    const normalizedDays = daysOfWeek.map(d => parseInt(d, 10));

    // Validate days are 0-6
    if (normalizedDays.some(d => isNaN(d) || d < 0 || d > 6)) {
      return res.status(400).json({
        message: "Invalid daysOfWeek values. Must be integers 0-6 (0=Sunday, 6=Saturday)"
      });
    }

    // Verify shift exists and belongs to company
    const shift = await prisma.shift.findFirst({
      where: { id: shiftId, companyId },
    });

    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

    // Resolve target users based on assignment type
    let targetUsers = [];
    if (assignmentType === 'all') {
      targetUsers = await prisma.user.findMany({
        where: { ...HUMAN_ONLY, companyId, status: 'active' },
        select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
      });
    } else if (assignmentType === 'department') {
      targetUsers = await prisma.user.findMany({
        where: { ...HUMAN_ONLY, companyId, departmentId: targetId, status: 'active' },
        select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
      });
    } else {
      const normalizedIds = targetIds ?? [targetId];
      targetUsers = await prisma.user.findMany({
        where: { ...HUMAN_ONLY, id: { in: normalizedIds }, companyId },
        select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
      });
      if (targetUsers.length !== normalizedIds.length) {
        const foundIds = new Set(targetUsers.map(u => u.id));
        const missing = normalizedIds.filter(id => !foundIds.has(id));
        return res.status(404).json({ message: "Target user(s) not found", missing });
      }
    }

    if (targetUsers.length === 0) {
      return res.status(400).json({ message: "No users found for assignment" });
    }

    const scheduleDates = generateScheduleDates(normalizedDays, startDate, endDate);

    if (scheduleDates.length === 0) {
      return res.status(400).json({
        message: "No dates match the selected days within the date range"
      });
    }

    const dateObjects = scheduleDates.map(d => new Date(d));

    // ── Time-aware conflict check ─────────────────────────────────────────────
    // Fetch each existing UserShift on the same dates AND include its shift's
    // startTime/endTime/crossesMidnight so we can check real time overlap.
    // Sequential shifts (e.g. ends 08:00 / starts 08:00) do NOT conflict.
    const conflicts = [];
    for (const user of targetUsers) {
      const existingShifts = await prisma.userShift.findMany({
        where: {
          userId: user.id,
          assignedDate: { in: dateObjects },
        },
        select: {
          id: true,           // needed for safe targeted deletion on replaceConflicts
          assignedDate: true,
          shift: {
            select: {
              startTime:       true,
              endTime:         true,
              crossesMidnight: true,
            },
          },
        },
      });

      // Keep only entries whose time window actually overlaps with the new shift.
      // This lets sequential shifts (Driver/Aide AM → Regular → Driver/Aide PM)
      // coexist on the same date without triggering false conflicts.
      const realConflicts = existingShifts.filter(
        us => us.shift && timesOverlap(shift, us.shift)
      );

      if (realConflicts.length > 0) {
        conflicts.push({
          userId:        user.id,
          userName:      `${user.profile?.firstName || ''} ${user.profile?.lastName || ''}`.trim() || user.email,
          userEmail:     user.email,
          conflictCount: realConflicts.length,
          conflictDates: realConflicts.map(s => s.assignedDate),
          // Track IDs so replaceConflicts only removes the overlapping records,
          // leaving non-overlapping shifts on the same date untouched.
          conflictIds:   realConflicts.map(s => s.id),
        });
      }
    }

    // ── Conflict resolution ──────────────────────────────────────────────────
    // replaceConflicts=true  → delete all conflicting UserShifts, then create everything
    // skipConflicts=true     → skip only conflicting dates per user, create the rest
    // neither                → return 409 so the user can decide
    if (conflicts.length > 0 && !replaceConflicts && !skipConflicts) {
      return res.status(409).json({
        message: "Scheduling conflicts detected",
        totalConflicts: conflicts.length,
        conflicts: conflicts.map(({ userId, userName, userEmail, conflictCount }) => ({
          targetId: userId,
          userName,
          userEmail,
          conflictCount,
        })),
      });
    }

    // Build conflict map for skipConflicts (used inside transaction)
    const conflictMap = {};
    if (skipConflicts) {
      conflicts.forEach(c => {
        conflictMap[c.userId] = new Set(
          c.conflictDates.map(d => new Date(d).toISOString().split('T')[0])
        );
      });
    }

    // ── Create schedules and shifts inside a single transaction ──────────────
    const { createdSchedules, totalShifts, scheduleResults } = await prisma.$transaction(async (tx) => {
      // Delete conflicting records first if replacing
      if (conflicts.length > 0 && replaceConflicts) {
        // Using IDs (not userId+date) ensures non-overlapping shifts on the same
        // date (e.g. Driver/Aide AM) are never touched.
        const allConflictIds = conflicts.flatMap(c => c.conflictIds);
        await tx.userShift.deleteMany({
          where: { id: { in: allConflictIds } },
        });
      }

      if (assignmentType === 'individual') {
        // One ShiftSchedule per employee — each independently editable/deletable
        const schedules = [];
        const allUserShiftData = [];
        const scheduleResults = [];

        for (const user of targetUsers) {
          const schedule = await tx.shiftSchedule.create({
            data: {
              companyId,
              shiftId,
              daysOfWeek: normalizedDays,
              startDate: new Date(startDate),
              endDate: new Date(endDate),
              isActive: true,
              assignmentType,
              targetId: user.id,
              createdBy: req.user.id,
            },
          });
          schedules.push(schedule);

          const blockedDates = conflictMap[user.id] || new Set();
          let assignedCount = 0;
          for (const date of scheduleDates) {
            if (blockedDates.has(date)) continue;
            allUserShiftData.push({
              userId: user.id,
              shiftId,
              assignedDate: new Date(date),
              status: 'upcoming',
              scheduleId: schedule.id,
              createdFrom: 'schedule',
            });
            assignedCount++;
          }

          if (assignedCount > 0) {
            scheduleResults.push({ targetId: user.id, scheduleId: schedule.id, assignedDates: assignedCount });
          } else {
            scheduleResults.push({ targetId: user.id, skipped: true, reason: "no non-conflicting dates" });
          }
        }

        if (allUserShiftData.length > 0) {
          await tx.userShift.createMany({ data: allUserShiftData });
        }

        return { createdSchedules: schedules, totalShifts: allUserShiftData.length, scheduleResults };
      } else {
        // department / all — one ShiftSchedule record for all resolved users
        const schedule = await tx.shiftSchedule.create({
          data: {
            companyId,
            shiftId,
            daysOfWeek: normalizedDays,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            isActive: true,
            assignmentType,
            targetId: assignmentType === 'all' ? null : targetId,
            createdBy: req.user.id,
          },
        });

        const userShiftData = [];
        for (const user of targetUsers) {
          const blockedDates = conflictMap[user.id] || new Set();
          for (const date of scheduleDates) {
            if (blockedDates.has(date)) continue;
            userShiftData.push({
              userId: user.id,
              shiftId,
              assignedDate: new Date(date),
              status: 'upcoming',
              scheduleId: schedule.id,
              createdFrom: 'schedule',
            });
          }
        }

        if (userShiftData.length > 0) {
          await tx.userShift.createMany({ data: userShiftData });
        }

        return { createdSchedules: [schedule], totalShifts: userShiftData.length };
      }
    });

    // Notifications (outside transaction — side effects don't roll back)
    await notifyManagementScheduleCreated({
      companyId,
      shift,
      schedule: createdSchedules[0],
      targetCount: targetUsers.length,
      totalShifts,
      assignedBy: req.user.id,
    });

    for (const user of targetUsers) {
      const userSchedule = assignmentType === 'individual'
        ? createdSchedules.find(s => s.targetId === user.id)
        : createdSchedules[0];

      await notifyEmployeeScheduleCreated({
        user,
        shift,
        schedule: userSchedule,
        assignedBy: req.user.id,
        companyId,
        totalDates: scheduleDates.length,
      });
    }

    if (assignmentType === 'individual') {
      const created = scheduleResults.filter(r => !r.skipped).length;
      const skipped = scheduleResults.filter(r =>  r.skipped).length;
      return res.status(201).json({
        message: "Schedules created successfully",
        created,
        skipped,
        results: scheduleResults,
      });
    }

    return res.status(201).json({
      message: "Schedule created successfully",
      data: {
        schedules: createdSchedules.map(formatScheduleDates),
        assignedUsers: targetUsers.length,
        totalShifts,
        dates: scheduleDates.length,
        skipped: conflicts.length > 0 && skipConflicts ? conflicts.reduce((s, c) => s + c.conflictCount, 0) : 0,
      },
    });
  } catch (error) {
    console.error("Error creating schedule:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Get all shift schedules
 */
const getShiftSchedules = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { isActive, departmentId, status } = req.query;

    const where = { companyId };

    if (status === "active") {
      where.isActive = true;
      where.endDate = { gte: new Date() };
    } else if (isActive !== undefined) {
      where.isActive = isActive === "true";
    }

    if (departmentId) {
      where.assignmentType = "department";
      where.targetId = departmentId;
    }

    const schedules = await prisma.shiftSchedule.findMany({
      where,
      include: {
        shift: {
          select: {
            shiftName: true,
            startTime: true,
            endTime: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({
      message: "Schedules retrieved successfully",
      data: schedules.map(formatScheduleDates),
    });
  } catch (error) {
    console.error("Error getting schedules:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * POST /api/shiftschedules/:scheduleId/apply-to-employee
 * Applies an existing recurring schedule to a single employee (skip-on-conflict).
 */
const applyScheduleToEmployee = async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const { employeeId } = req.body;
    const { companyId } = req.user;

    if (!employeeId) {
      return res.status(400).json({ message: "employeeId is required" });
    }

    const schedule = await prisma.shiftSchedule.findFirst({
      where: { id: scheduleId, companyId },
    });

    if (!schedule) {
      return res.status(404).json({ message: "Schedule not found" });
    }
    if (!schedule.isActive) {
      return res.status(400).json({ message: "Schedule is not active" });
    }
    if (new Date(schedule.endDate) < new Date()) {
      return res.status(400).json({ message: "Schedule has expired" });
    }

    const employee = await prisma.user.findFirst({
      where: { id: employeeId, companyId },
    });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const dates = generateScheduleDates(schedule.daysOfWeek, schedule.startDate, schedule.endDate);

    if (dates.length === 0) {
      return res.status(200).json({
        message: "No dates to apply",
        data: { created: 0, skipped: 0 },
      });
    }

    // Find any existing UserShifts for this employee on these dates (any shift)
    const existingShifts = await prisma.userShift.findMany({
      where: {
        userId: employeeId,
        assignedDate: { in: dates.map(d => new Date(d)) },
      },
      select: { assignedDate: true },
    });

    const existingDates = new Set(
      existingShifts.map(s => s.assignedDate.toISOString().split("T")[0])
    );

    const toCreate = [];
    let skipped = 0;

    for (const date of dates) {
      if (existingDates.has(date)) {
        skipped++;
        continue;
      }
      toCreate.push({
        userId: employeeId,
        shiftId: schedule.shiftId,
        assignedDate: new Date(date),
        status: "upcoming",
        scheduleId: schedule.id,
        createdFrom: "schedule",
      });
    }

    if (toCreate.length > 0) {
      await prisma.userShift.createMany({ data: toCreate, skipDuplicates: true });
    }

    return res.status(200).json({
      message: "Schedule applied successfully",
      data: { created: toCreate.length, skipped },
    });
  } catch (error) {
    console.error("Error applying schedule to employee:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Get single schedule with details
 */
const getShiftScheduleById = async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId } = req.user;

    const schedule = await prisma.shiftSchedule.findFirst({
      where: { id, companyId },
      include: {
        shift: true,
        company: {
          select: { name: true },
        },
      },
    });

    if (!schedule) {
      return res.status(404).json({ message: "Schedule not found" });
    }

    const assignmentCount = await prisma.userShift.count({
      where: { scheduleId: id },
    });

    return res.status(200).json({
      message: "Schedule retrieved successfully",
      data: {
        ...formatScheduleDates(schedule),
        assignmentCount,
      },
    });
  } catch (error) {
    console.error("Error getting schedule:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Update a shift schedule
 *
 * BUG FIX: Previously only accepted isActive and endDate.
 * Now accepts the full set of editable fields:
 *   shiftId, daysOfWeek, startDate, endDate, assignmentType, targetId, isActive
 *
 * When daysOfWeek, startDate, endDate, shiftId, assignmentType, or targetId change,
 * all existing UserShift records linked to this schedule are deleted and regenerated
 * from scratch so the assignments stay in sync with the new schedule definition.
 */
const updateShiftSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId } = req.user;
    const {
      shiftId,
      daysOfWeek,
      startDate,
      endDate,
      assignmentType,
      targetId,
      isActive,
    } = req.body;

    // Verify schedule exists and belongs to this company
    const existingSchedule = await prisma.shiftSchedule.findFirst({
      where: { id, companyId },
    });

    if (!existingSchedule) {
      return res.status(404).json({ message: "Schedule not found" });
    }

    // ── Determine final values (fall back to existing when not provided) ──
    const finalShiftId      = shiftId      ?? existingSchedule.shiftId;
    const finalStartDate    = startDate    ?? existingSchedule.startDate;
    const finalEndDate      = endDate      ?? existingSchedule.endDate;
    const finalAssignmentType = assignmentType ?? existingSchedule.assignmentType;
    const finalTargetId     = finalAssignmentType === 'all'
      ? null
      : (targetId ?? existingSchedule.targetId);

    // Normalize daysOfWeek — fall back to existing if not provided
    let finalDays;
    if (Array.isArray(daysOfWeek) && daysOfWeek.length > 0) {
      finalDays = daysOfWeek.map(d => parseInt(d, 10));
      if (finalDays.some(d => isNaN(d) || d < 0 || d > 6)) {
        return res.status(400).json({
          message: "Invalid daysOfWeek values. Must be integers 0-6 (0=Sunday, 6=Saturday)",
        });
      }
    } else {
      finalDays = existingSchedule.daysOfWeek;
    }

    // Validate assignment type
    if (!['individual', 'department', 'all'].includes(finalAssignmentType)) {
      return res.status(400).json({ message: "Invalid assignmentType. Must be: individual, department, or all" });
    }

    if (finalAssignmentType !== 'all' && !finalTargetId) {
      return res.status(400).json({ message: "targetId required for individual/department assignment" });
    }

    // Verify the shift exists and belongs to the company (in case shiftId changed)
    const shift = await prisma.shift.findFirst({
      where: { id: finalShiftId, companyId },
    });
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

    // ── Detect whether schedule-defining fields changed ────────────────────
    // If any of these changed, existing UserShift records are stale and must
    // be deleted and regenerated. isActive-only edits skip regeneration.
    const scheduleChanged =
      finalShiftId !== existingSchedule.shiftId ||
      finalDays.join(',') !== existingSchedule.daysOfWeek.join(',') ||
      new Date(finalStartDate).toISOString() !== new Date(existingSchedule.startDate).toISOString() ||
      new Date(finalEndDate).toISOString()   !== new Date(existingSchedule.endDate).toISOString() ||
      finalAssignmentType !== existingSchedule.assignmentType ||
      finalTargetId !== existingSchedule.targetId;

    // ── Update the ShiftSchedule record ───────────────────────────────────
    const updateData = {
      shiftId:        finalShiftId,
      daysOfWeek:     finalDays,
      startDate:      new Date(finalStartDate),
      endDate:        new Date(finalEndDate),
      assignmentType: finalAssignmentType,
      targetId:       finalTargetId,
    };
    if (isActive !== undefined) updateData.isActive = isActive;

    const updatedSchedule = await prisma.shiftSchedule.update({
      where: { id },
      data: updateData,
    });

    // ── Regenerate UserShift records only when the schedule definition changed ──
    if (scheduleChanged) {
      // 1. Delete all existing UserShift records tied to this schedule
      await prisma.userShift.deleteMany({ where: { scheduleId: id } });

      // 2. Resolve the new set of target users
      let targetUsers = [];
      if (finalAssignmentType === 'all') {
        targetUsers = await prisma.user.findMany({
          where: { ...HUMAN_ONLY, companyId, status: 'active' },
          select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
        });
      } else if (finalAssignmentType === 'department') {
        targetUsers = await prisma.user.findMany({
          where: { ...HUMAN_ONLY, companyId, departmentId: finalTargetId, status: 'active' },
          select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
        });
      } else {
        const user = await prisma.user.findFirst({
          where: { ...HUMAN_ONLY, id: finalTargetId, companyId },
          select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
        });
        if (!user) {
          return res.status(404).json({ message: "Target user not found" });
        }
        targetUsers = [user];
      }

      if (targetUsers.length === 0) {
        // Schedule record is updated; just warn that no users matched
        return res.status(200).json({
          message: "Schedule updated successfully. No active users found for assignment.",
          data: formatScheduleDates(updatedSchedule),
          regenerated: 0,
        });
      }

      // 3. Generate new date list
      const scheduleDates = generateScheduleDates(finalDays, finalStartDate, finalEndDate);

      if (scheduleDates.length === 0) {
        return res.status(200).json({
          message: "Schedule updated successfully. No dates match the selected days within the date range.",
          data: formatScheduleDates(updatedSchedule),
          regenerated: 0,
        });
      }

      // 4. Create new UserShift records
      const userShiftData = [];
      for (const user of targetUsers) {
        for (const date of scheduleDates) {
          userShiftData.push({
            userId:      user.id,
            shiftId:     finalShiftId,
            assignedDate: new Date(date),
            status:      'upcoming',
            scheduleId:  id,
            createdFrom: 'schedule',
          });
        }
      }

      await prisma.userShift.createMany({ data: userShiftData });

      return res.status(200).json({
        message: "Schedule updated successfully",
        data: formatScheduleDates(updatedSchedule),
        regenerated: userShiftData.length,
      });
    }

    // isActive-only change — no regeneration needed
    return res.status(200).json({
      message: "Schedule updated successfully",
      data: formatScheduleDates(updatedSchedule),
    });
  } catch (error) {
    console.error("Error updating schedule:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Delete a shift schedule
 */
const deleteShiftSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId } = req.user;
    const { deleteAssignments = false } = req.query;

    const existingSchedule = await prisma.shiftSchedule.findFirst({
      where: { id, companyId },
    });

    if (!existingSchedule) {
      return res.status(404).json({ message: "Schedule not found" });
    }

    const assignmentCount = await prisma.userShift.count({
      where: { scheduleId: id },
    });

    if (assignmentCount > 0 && !deleteAssignments) {
      return res.status(400).json({
        message: `Schedule has ${assignmentCount} active assignments. Set deleteAssignments=true to delete them.`,
        assignmentCount,
      });
    }

    if (deleteAssignments && assignmentCount > 0) {
      await prisma.userShift.deleteMany({ where: { scheduleId: id } });
    }

    await prisma.shiftSchedule.delete({ where: { id } });

    return res.status(200).json({
      message: "Schedule deleted successfully",
      assignmentsDeleted: deleteAssignments ? assignmentCount : 0,
    });
  } catch (error) {
    console.error("Error deleting schedule:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  createShiftSchedule,
  getShiftSchedules,
  getShiftScheduleById,
  updateShiftSchedule,
  deleteShiftSchedule,
  applyScheduleToEmployee,
};