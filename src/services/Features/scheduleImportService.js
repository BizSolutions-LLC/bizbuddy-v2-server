// src/services/Features/scheduleImportService.js
// Row-level business logic for the CSV schedule bulk-import feature (BB-081).
// CSV shape/header validation and block-merging live in @utils/csvScheduleParser; this
// file resolves employees, checks conflicts, and — unlike the punch-log importer
// (BB-077), which commits in one shot — splits into two phases:
//   1. previewScheduleImport() — parses + merges + resolves proposed Shift names +
//      checks conflicts. Writes nothing. Client shows a review/confirm modal from this.
//   2. commitScheduleImport() — takes the (possibly user-edited: renamed shifts,
//      skipped rows) preview rows back and actually creates the Shift/UserShift records,
//      re-validating scope and conflicts against current DB state first (the preview may
//      be stale by the time the user confirms).

const { prisma } = require("@config/connection");
const { hasTimeOverlap } = require("@controllers/Features/shiftAssignmentController");
const {
  notifyEmployeeShiftAssigned,
  notifyManagementShiftAssignment,
} = require("@services/shiftNotificationService");
const {
  parseScheduleCsv,
  mergeBlocksToTimeRanges,
  IDENTIFIER_COLUMNS,
} = require("@utils/csvScheduleParser");

const MAX_ROWS = 300;

function hhmmToEpochDate(hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0));
}

function formatDisplayTime(hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const period = hour < 12 || hour === 24 ? "AM" : "PM";
  let displayHour = hour % 12;
  if (displayHour === 0) displayHour = 12;
  return `${String(displayHour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${period}`;
}

function defaultShiftName(startTime, endTime) {
  return `${formatDisplayTime(startTime)} – ${formatDisplayTime(endTime)}`;
}

// Same grouping key used at both preview and commit time to decide which rows share
// one Shift record within this import batch. Pre-existing company Shift templates are
// never reused/renamed by this import — every group always creates a new Shift.
function timeRangeKey(startTime, endTime, crossesMidnight) {
  return `${startTime}|${endTime}|${crossesMidnight}`;
}

async function findOverlappingUserShift(userId, assignedDate, startTime, endTime) {
  const existingShifts = await prisma.userShift.findMany({
    where: { userId, assignedDate: new Date(assignedDate) },
    include: { shift: true },
  });

  const proposed = { startTime: hhmmToEpochDate(startTime), endTime: hhmmToEpochDate(endTime) };

  for (const existing of existingShifts) {
    const existingShape = {
      startTime: existing.customStartTime || existing.shift.startTime,
      endTime: existing.customEndTime || existing.shift.endTime,
    };
    if (hasTimeOverlap(existingShape, proposed)) return existing;
  }
  return null;
}

/**
 * Resolves the row's identifier against a pre-built map of company (and, for a
 * supervisor uploader, department-scoped) users. Shared by preview and commit so both
 * phases apply the exact same scoping rule.
 */
function buildIdentifierMaps(users) {
  const byEmployeeId = new Map();
  const byEmail = new Map();
  for (const u of users) {
    if (u.employeeId) byEmployeeId.set(u.employeeId.trim(), u);
    if (u.email) byEmail.set(u.email.trim().toLowerCase(), u);
  }
  return { byEmployeeId, byEmail };
}

function rowIdentifier(data) {
  return (data.employeeId && data.employeeId.trim()) || (data.email && data.email.trim().toLowerCase()) || null;
}

/**
 * Parses + validates a schedule CSV and returns a preview of what would be created.
 * Never throws for row-level problems (collected as status: 'error'/'conflict' per
 * row); throws only for whole-file problems (bad CSV shape, or the row-count cap
 * flagged with isRowCapError: true), which the caller should respond to with 400.
 *
 * A `supervisor` uploader is restricted to employees in their own department,
 * mirroring the punch-log importer (BB-077) and BB-080's eligibility rule —
 * admin/superadmin stay company-wide.
 */
async function previewScheduleImport({ buffer, companyId, actingUserId, actingRole, actingDepartmentId, overnight }) {
  const rows = parseScheduleCsv(buffer);

  if (rows.length > MAX_ROWS) {
    const err = new Error(`CSV has ${rows.length} rows; the limit is ${MAX_ROWS} per upload.`);
    err.isRowCapError = true;
    throw err;
  }

  const isScopedToDepartment = actingRole === "supervisor";

  const identifiers = new Set();
  for (const { data } of rows) {
    if (data.employeeId) identifiers.add(data.employeeId.trim());
    if (data.email) identifiers.add(data.email.trim().toLowerCase());
  }

  const users = await prisma.user.findMany({
    where: {
      companyId,
      ...(isScopedToDepartment ? { departmentId: actingDepartmentId } : {}),
      OR: [{ employeeId: { in: [...identifiers] } }, { email: { in: [...identifiers] } }],
    },
    select: {
      id: true,
      employeeId: true,
      email: true,
      departmentId: true,
      profile: { select: { firstName: true, lastName: true } },
    },
  });
  const { byEmployeeId, byEmail } = buildIdentifierMaps(users);

  const preview = [];
  // Rows for the same employee/date are now allowed to coexist (multi-shift days,
  // e.g. a split shift) as long as their derived time ranges don't overlap each
  // other — mirrors the same hasTimeOverlap check already used against the DB.
  const seenRangesByKey = new Map();

  for (const { rowNumber, data } of rows) {
    const identifier = rowIdentifier(data);
    const base = { row: rowNumber, employeeId: identifier, date: data.date || null };

    try {
      if (!identifier) throw new Error(`Missing ${IDENTIFIER_COLUMNS.join(" or ")}.`);
      if (!data.date) throw new Error("Missing date.");
      if (isNaN(new Date(data.date).getTime())) throw new Error(`Invalid date: "${data.date}".`);

      const user =
        (data.employeeId && byEmployeeId.get(data.employeeId.trim())) ||
        (data.email && byEmail.get(data.email.trim().toLowerCase()));
      if (!user) {
        throw new Error(
          isScopedToDepartment ? "Employee not found in your department." : "Employee not found in this company."
        );
      }

      // A row's marked blocks can form multiple disjoint runs (e.g. a lunch-break
      // split shift) — each becomes its own proposed shift, so one CSV row can now
      // yield more than one preview entry.
      const ranges = mergeBlocksToTimeRanges(data, !!overnight);

      const dupeKey = `${identifier}|${data.date}`;
      const seenRanges = seenRangesByKey.get(dupeKey) || [];
      seenRangesByKey.set(dupeKey, seenRanges);

      for (const { startTime, endTime, crossesMidnight } of ranges) {
        const proposed = { startTime: hhmmToEpochDate(startTime), endTime: hhmmToEpochDate(endTime) };
        const overlapsInFile = seenRanges.some((r) =>
          hasTimeOverlap({ startTime: hhmmToEpochDate(r.startTime), endTime: hhmmToEpochDate(r.endTime) }, proposed)
        );
        if (overlapsInFile) {
          preview.push({ ...base, status: "error", reason: "Overlaps another shift for this employee/date in this file." });
          continue;
        }
        seenRanges.push({ startTime, endTime });

        const conflict = await findOverlappingUserShift(user.id, data.date, startTime, endTime);

        preview.push({
          ...base,
          userId: user.id,
          employeeName: user.profile ? `${user.profile.firstName || ""} ${user.profile.lastName || ""}`.trim() : user.email,
          startTime,
          endTime,
          crossesMidnight,
          shiftName: defaultShiftName(startTime, endTime),
          timeRangeKey: timeRangeKey(startTime, endTime, crossesMidnight),
          status: conflict ? "conflict" : "ready",
          reason: conflict ? `Overlaps an existing shift ("${conflict.shift.shiftName}") on this date.` : null,
        });
      }
    } catch (rowErr) {
      preview.push({ ...base, status: "error", reason: rowErr.message });
    }
  }

  return preview;
}

/**
 * Commits a (possibly user-edited) preview batch: rows may have a renamed `shiftName`
 * or `skip: true`. Re-validates department scope and conflicts against current DB
 * state — the preview may be stale by the time the user confirms — then creates one
 * new Shift per unique (startTime, endTime, crossesMidnight, shiftName) group in this
 * batch and bulk-inserts the corresponding UserShift rows inside a transaction.
 *
 * Returns { created, skipped, failed } — created entries include the new shiftId/
 * userShiftId; failed entries carry a reason (re-validation problems); skipped entries
 * are rows the user explicitly excluded via the review modal.
 */
async function commitScheduleImport({ companyId, actingUserId, actingRole, actingDepartmentId, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const err = new Error("No rows to import.");
    err.isRowCapError = true;
    throw err;
  }
  if (rows.length > MAX_ROWS) {
    const err = new Error(`Import has ${rows.length} rows; the limit is ${MAX_ROWS}.`);
    err.isRowCapError = true;
    throw err;
  }

  const skipped = [];
  const failed = [];
  const candidates = [];

  for (const row of rows) {
    if (row.skip) {
      skipped.push({ row: row.row, employeeId: row.employeeId, date: row.date });
      continue;
    }
    if (!row.userId || !row.date || !row.startTime || !row.endTime || !row.shiftName) {
      failed.push({ row: row.row, employeeId: row.employeeId, date: row.date, reason: "Incomplete row data." });
      continue;
    }
    candidates.push(row);
  }

  const isScopedToDepartment = actingRole === "supervisor";
  const userIds = [...new Set(candidates.map((r) => r.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, companyId, status: "active" },
    select: { id: true, departmentId: true, employeeId: true, email: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const validated = [];
  for (const row of candidates) {
    const user = userById.get(row.userId);
    if (!user) {
      failed.push({ row: row.row, employeeId: row.employeeId, date: row.date, reason: "Employee not found in this company." });
      continue;
    }
    if (isScopedToDepartment && user.departmentId !== actingDepartmentId) {
      failed.push({ row: row.row, employeeId: row.employeeId, date: row.date, reason: "Employee not found in your department." });
      continue;
    }

    const conflict = await findOverlappingUserShift(user.id, row.date, row.startTime, row.endTime);
    if (conflict) {
      failed.push({
        row: row.row,
        employeeId: row.employeeId,
        date: row.date,
        reason: `Overlaps an existing shift ("${conflict.shift.shiftName}") on this date.`,
      });
      continue;
    }

    validated.push({ ...row, companyId, departmentId: user.departmentId });
  }

  if (validated.length === 0) {
    return { created: [], skipped, failed };
  }

  // Group validated rows into the Shift records this batch will create.
  const groups = new Map();
  for (const row of validated) {
    const key = `${timeRangeKey(row.startTime, row.endTime, row.crossesMidnight)}|${row.shiftName}`;
    if (!groups.has(key)) groups.set(key, { startTime: row.startTime, endTime: row.endTime, crossesMidnight: row.crossesMidnight, shiftName: row.shiftName, rows: [] });
    groups.get(key).rows.push(row);
  }

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { timeZone: true } });
  const companyTimezone = company?.timeZone || "UTC";

  const created = [];
  await prisma.$transaction(async (tx) => {
    for (const group of groups.values()) {
      const shift = await tx.shift.create({
        data: {
          companyId,
          shiftName: group.shiftName,
          startTime: hhmmToEpochDate(group.startTime).toISOString(),
          endTime: hhmmToEpochDate(group.endTime).toISOString(),
          crossesMidnight: group.crossesMidnight,
          differentialMultiplier: 1.0,
          timeZone: companyTimezone,
        },
      });
      group.shiftId = shift.id;

      const userShifts = await Promise.all(
        group.rows.map((row) =>
          tx.userShift.create({
            data: {
              userId: row.userId,
              shiftId: shift.id,
              assignedDate: new Date(row.date),
              createdFrom: "bulk",
              status: "scheduled",
            },
          })
        )
      );

      group.rows.forEach((row, i) => {
        created.push({
          row: row.row,
          employeeId: row.employeeId,
          date: row.date,
          shiftId: shift.id,
          shiftName: shift.shiftName,
          userShiftId: userShifts[i].id,
        });
      });
    }
  });

  try {
    for (const group of groups.values()) {
      if (!group.shiftId) continue;
      const shift = { id: group.shiftId, shiftName: group.shiftName, startTime: hhmmToEpochDate(group.startTime), endTime: hhmmToEpochDate(group.endTime) };
      const dates = [...new Set(group.rows.map((r) => r.date))];

      const byUser = new Map();
      for (const row of group.rows) {
        if (!byUser.has(row.userId)) byUser.set(row.userId, userById.get(row.userId));
      }

      await Promise.all(
        [...byUser.entries()].map(([userId, user]) =>
          notifyEmployeeShiftAssigned({ user: { id: userId, departmentId: user?.departmentId }, shift, dates, assignedBy: actingUserId, companyId })
        )
      );
      await notifyManagementShiftAssignment({
        companyId,
        shift,
        assignedCount: group.rows.length,
        dates,
        assignmentType: "bulk-import",
        assignedBy: actingUserId,
      });
    }
  } catch (notifError) {
    console.error("❌ Failed to send schedule import notifications:", notifError);
  }

  return { created, skipped, failed };
}

module.exports = { previewScheduleImport, commitScheduleImport, MAX_ROWS };
