// src/services/Features/punchLogImportService.js
// Row-level business logic for the CSV punch-log bulk-import feature (BB-077).
// CSV shape/header validation lives in @utils/csvPunchLogParser; this file resolves
// employees, validates each row, and creates the RequestedTimeLog + TimeLog pair by
// reusing the exact same helpers as the single-row request/approve flow
// (requestPunchLogController.js) so behavior never drifts between the two paths.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const {
  parseClockTime,
  findOverlappingLog,
  createTimeLogFromRequest,
} = require("@controllers/Features/requestPunchLogController");
const { getLockedCutoffForDate } = require("@controllers/Features/timeLogController");
const { VALID_PUNCH_TYPES, isDriverSegmentPunchType } = require("@utils/punchTypeUtils");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");
const { parsePunchLogCsv } = require("@utils/csvPunchLogParser");

const MAX_ROWS = 300;

// Spreadsheet tools routinely export a mix of formats in one `date` column — e.g. a
// manually-typed first cell as ISO (2026-08-01) and the rest autofilled/dragged down as the
// tool's locale-default short date (8/3/26) — because the display format is a per-cell
// property, not a per-column one. parseClockTime()'s combined "date time" string is only
// parsed reliably by moment when the date portion is unambiguous, so every row's `date` cell
// is normalized to strict YYYY-MM-DD here before it's used anywhere else, rather than trusting
// moment's un-formatted fallback parser to guess the source format correctly.
const ACCEPTED_DATE_FORMATS = ["YYYY-MM-DD", "M/D/YY", "M/D/YYYY", "MM/DD/YY", "MM/DD/YYYY"];

function normalizeDateCell(raw) {
  if (!raw) return null;
  const parsed = moment(raw.trim(), ACCEPTED_DATE_FORMATS, true);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
}

function hasExplicitDate(str) {
  return /\d{4}-\d{2}-\d{2}/.test(str) || /Z$|[+-]\d{2}:\d{2}$/.test(str);
}

// Combines the row's `date` column with a bare `clockIn`/`clockOut` time (e.g. "08:00")
// into a string parseClockTime() can interpret. If the time column already carries its
// own date/offset, it's used as-is.
function buildClockDateTime(dateStr, timeStr) {
  if (!timeStr) return null;
  return hasExplicitDate(timeStr) ? timeStr : `${dateStr} ${timeStr}`;
}

/**
 * Bulk-imports historical punch logs from a CSV buffer.
 * Every valid row becomes a RequestedTimeLog that is immediately created and
 * self-approved by the uploading admin (approverId), then run through the same
 * TimeLog-creation logic as approveRequestedPunchLog.
 *
 * Never throws for row-level problems — those are collected into `failed[]`. Throws
 * only for whole-file problems (bad CSV shape, from parsePunchLogCsv; or the row-count
 * cap, flagged with `isRowCapError: true`), which the caller should respond to with 400
 * before anything is written.
 *
 * A `supervisor` uploader is restricted to employees in their own department, mirroring
 * viewAllRequestedPunchLogs (requestPunchLogController.js) — admin/superadmin stay company-wide.
 *
 * Returns { created: [{row, employeeId, date, clockIn, clockOut, timeLogId, requestedTimeLogId}],
 *           failed: [{row, employeeId, date, clockIn, clockOut, reason}] } — date/clockIn/clockOut
 * on `created` rows are the parsed/normalized values actually stored; on `failed` rows they're
 * the raw CSV cell values as-is (parsing may not have succeeded), for the UI to render a
 * per-row approved/failed table without re-reading the original file.
 */
async function importPunchLogsFromCsv({ buffer, companyId, approverId, approverRole, approverDepartmentId }) {
  const rows = parsePunchLogCsv(buffer);

  if (rows.length > MAX_ROWS) {
    const err = new Error(`CSV has ${rows.length} rows; the limit is ${MAX_ROWS} per upload.`);
    err.isRowCapError = true;
    throw err;
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timeZone: true },
  });
  const companyTimezone = company?.timeZone || "UTC";
  const isBncCompany = BNC_COMPANY_IDS.has(companyId);
  const isScopedToDepartment = approverRole === "supervisor";

  const identifiers = new Set();
  for (const { data } of rows) {
    if (data.employeeId) identifiers.add(data.employeeId.trim());
    if (data.email) identifiers.add(data.email.trim().toLowerCase());
  }

  const users = await prisma.user.findMany({
    where: {
      companyId,
      ...(isScopedToDepartment ? { departmentId: approverDepartmentId } : {}),
      OR: [
        { employeeId: { in: [...identifiers] } },
        { email: { in: [...identifiers] } },
      ],
    },
    select: { id: true, employeeId: true, email: true, departmentId: true },
  });

  const userByEmployeeId = new Map();
  const userByEmail = new Map();
  for (const u of users) {
    if (u.employeeId) userByEmployeeId.set(u.employeeId.trim(), u);
    if (u.email) userByEmail.set(u.email.trim().toLowerCase(), u);
  }

  const created = [];
  const failed = [];
  const seenInFile = new Set();

  for (const { rowNumber, data } of rows) {
    const identifier =
      (data.employeeId && data.employeeId.trim()) ||
      (data.email && data.email.trim().toLowerCase()) ||
      null;

    try {
      if (!identifier) throw new Error("Missing employeeId or email.");
      if (!data.date) throw new Error("Missing date.");
      if (!data.clockIn) throw new Error("Missing clockIn.");
      if (!data.clockOut) throw new Error("Missing clockOut.");

      const normalizedDate = normalizeDateCell(data.date);
      if (!normalizedDate) {
        throw new Error(`Invalid date format: "${data.date}". Use YYYY-MM-DD.`);
      }

      const user =
        (data.employeeId && userByEmployeeId.get(data.employeeId.trim())) ||
        (data.email && userByEmail.get(data.email.trim().toLowerCase()));
      if (!user) {
        throw new Error(
          isScopedToDepartment ? "Employee not found in your department." : "Employee not found in this company."
        );
      }

      if (data.punchType && !VALID_PUNCH_TYPES.includes(data.punchType)) {
        throw new Error(`Invalid punchType: ${data.punchType}`);
      }
      if (data.punchType && isDriverSegmentPunchType(data.punchType) && isBncCompany) {
        throw new Error("Driver/Aide punch types are not available for this company.");
      }

      const clockIn = parseClockTime(buildClockDateTime(normalizedDate, data.clockIn), companyTimezone);
      let clockOut = parseClockTime(buildClockDateTime(normalizedDate, data.clockOut), companyTimezone);

      if (isNaN(clockIn) || isNaN(clockOut)) throw new Error("Invalid date, clockIn, or clockOut.");

      // Overnight shift: a bare clockOut time earlier than clockIn rolls to the next day.
      if (clockOut <= clockIn && !hasExplicitDate(data.clockOut)) {
        clockOut = new Date(clockOut.getTime() + 24 * 60 * 60 * 1000);
      }
      if (clockIn >= clockOut) throw new Error("Clock-in time must be before clock-out time.");

      const dupeKey = `${user.id}|${clockIn.getTime()}|${clockOut.getTime()}`;
      if (seenInFile.has(dupeKey)) throw new Error("Duplicate row in this file.");
      seenInFile.add(dupeKey);

      const conflictingLog = await findOverlappingLog(user.id, clockIn, clockOut);
      if (conflictingLog) throw new Error("Conflicts with an existing punch log.");

      const lockedPeriod = await getLockedCutoffForDate(companyId, user.departmentId, normalizedDate, companyTimezone);
      if (lockedPeriod) {
        throw new Error(`Cutoff period covering this date is ${lockedPeriod.status}; cannot import.`);
      }

      const grossMinutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60000);

      let requestedTimeLog;
      try {
        requestedTimeLog = await prisma.requestedTimeLog.create({
          data: {
            userId: user.id,
            approverId,
            requestedDate: new Date(normalizedDate),
            requestedClockIn: clockIn,
            requestedClockOut: clockOut,
            reason: data.reason || null,
            description: data.notes || null,
            estimatedDuration: grossMinutes,
            estimatedNetHours: +(grossMinutes / 60).toFixed(2),
            requestedPunchType: data.punchType || null,
            status: "APPROVED",
            submittedAt: new Date(),
            approvedAt: new Date(),
          },
        });

        const timeLog = await createTimeLogFromRequest({
          userId: user.id,
          companyId,
          timeIn: clockIn,
          timeOut: clockOut,
          requestedPunchType: data.punchType,
          reason: data.reason,
        });

        await prisma.requestedTimeLog.update({
          where: { id: requestedTimeLog.id },
          data: { createdTimeLogId: timeLog.id },
        });

        created.push({
          row: rowNumber,
          employeeId: identifier,
          date: normalizedDate,
          clockIn: moment.tz(clockIn, companyTimezone).format(),
          clockOut: moment.tz(clockOut, companyTimezone).format(),
          timeLogId: timeLog.id,
          requestedTimeLogId: requestedTimeLog.id,
        });
      } catch (createErr) {
        // Don't leave an orphaned RequestedTimeLog if TimeLog creation failed partway through.
        if (requestedTimeLog) {
          await prisma.requestedTimeLog.delete({ where: { id: requestedTimeLog.id } }).catch(() => {});
        }
        throw createErr;
      }
    } catch (rowErr) {
      failed.push({
        row: rowNumber,
        employeeId: identifier,
        date: data.date || null,
        clockIn: data.clockIn || null,
        clockOut: data.clockOut || null,
        reason: rowErr.message,
      });
    }
  }

  return { created, failed };
}

module.exports = { importPunchLogsFromCsv, MAX_ROWS };
