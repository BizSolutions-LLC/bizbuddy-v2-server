// src/services/Features/punchLogImportService.js
// Row-level business logic for the CSV punch-log bulk-import feature (BB-077).
// CSV shape/header validation lives in @utils/csvPunchLogParser; this file resolves
// employees, validates each row, and creates the RequestedTimeLog + TimeLog pair by
// reusing the exact same helpers as the single-row request/approve flow
// (requestPunchLogController.js) so behavior never drifts between the two paths.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const {
  parseClockTime,
  findOverlappingLog,
  createTimeLogFromRequest,
} = require("@controllers/Features/requestPunchLogController");
const { getLockedCutoffForDate } = require("@controllers/Features/timeLogController");
const { VALID_PUNCH_TYPES, isDriverSegmentPunchType } = require("@utils/punchTypeUtils");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");
const { parsePunchLogCsv, buildPrefilledTemplateCsv } = require("@utils/csvPunchLogParser");
const {
  ImportError,
  teamWhere,
  splitIds,
  displayName,
  loadActor,
  parseDateRange,
  resolveTargetEmployees,
} = require("@services/Features/importTargets");

// BB-108: a pre-filled file is mostly blank rows (days off), so the cap on rows that
// are actually imported is separate from the cap on the file as a whole.
const MAX_ROWS = 500; // rows with a clockIn or clockOut
const MAX_TOTAL_ROWS = 2000; // every row, blank ones included
const MAX_RANGE_DAYS = 31; // a full cutoff period fits

const isBlank = (v) => !v || !String(v).trim();

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

// BB-108: bare clock times accepted in a cell, read strictly in the company's timezone.
// Spreadsheets often save "08:00" back as "8:00" or "8:00:00 AM", which moment's
// format-less parsing only guesses at (in the server's own timezone).
const TIME_FORMATS = ["HH:mm", "H:mm", "HH:mm:ss", "H:mm:ss", "h:mm A", "h:mm:ss A", "h A", "h:mmA", "h:mm:ssA", "hA"];
const DATE_TIME_FORMATS = TIME_FORMATS.map((f) => `YYYY-MM-DD ${f}`);

// The row's `date` plus a bare time ("08:00", "8:00 AM"). A time cell that carries
// its own date/offset is used as-is, as before.
function parseCellTime(dateStr, timeStr, companyTimezone) {
  if (hasExplicitDate(timeStr)) return parseClockTime(timeStr, companyTimezone);
  const parsed = moment.tz(`${dateStr} ${String(timeStr).trim()}`, DATE_TIME_FORMATS, true, companyTimezone);
  return parsed.isValid() ? parsed.toDate() : new Date(NaN);
}

/**
 * GET /template with startDate/endDate (BB-108): pre-filled CSV, one row per active
 * employee × date (≤ 31 days). Target: userIds, departmentId, or everyone in scope;
 * supervisors get their own department only. Throws ImportError (status 400/403).
 */
async function buildPunchLogTemplate({ companyId, actingUserId, actingRole, query }) {
  const actor = await loadActor({ companyId, actingUserId, actingRole });
  const range = parseDateRange(query.startDate, query.endDate, MAX_RANGE_DAYS);
  const employees = await resolveTargetEmployees(
    actor,
    { userIds: splitIds(query.userIds), departmentId: query.departmentId || null },
    { action: "import punch logs" }
  );
  if (employees.length === 0) throw new ImportError(400, "No active employees match this selection.");

  const rowCount = employees.length * range.dates.length;
  if (rowCount > MAX_TOTAL_ROWS)
    throw new ImportError(
      400,
      `That's ${rowCount} rows (${employees.length} employees × ${range.dates.length} days); the limit is ${MAX_TOTAL_ROWS}. Pick fewer employees or days.`
    );

  const csv = buildPrefilledTemplateCsv({
    isBnc: BNC_COMPANY_IDS.has(companyId),
    dates: range.dates,
    employees: employees.map((e) => ({ email: e.email, name: displayName(e) })),
  });
  return { csv, filename: `punch_logs_${range.startDate}_to_${range.endDate}.csv` };
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
 * Rows with neither clockIn nor clockOut are days off (BB-108): skipped and counted,
 * never failed. Caps: MAX_TOTAL_ROWS rows in the file, MAX_ROWS non-blank ones.
 *
 * Returns { created: [{row, employeeId, name, date, clockIn, clockOut, timeLogId, requestedTimeLogId}],
 *           failed: [{row, employeeId, name, date, clockIn, clockOut, reason}],
 *           skipped: <number of blank rows> } — `name` is "Last, First" when the employee
 * was matched, else null; date/clockIn/clockOut
 * on `created` rows are the parsed/normalized values actually stored; on `failed` rows they're
 * the raw CSV cell values as-is (parsing may not have succeeded), for the UI to render a
 * per-row approved/failed table without re-reading the original file.
 */
async function importPunchLogsFromCsv({ buffer, companyId, approverId, approverRole, approverDepartmentId }) {
  const allRows = parsePunchLogCsv(buffer);

  if (allRows.length > MAX_TOTAL_ROWS) {
    const err = new Error(`CSV has ${allRows.length} rows; the limit is ${MAX_TOTAL_ROWS} per upload.`);
    err.isRowCapError = true;
    throw err;
  }

  const rows = allRows.filter(({ data }) => !(isBlank(data.clockIn) && isBlank(data.clockOut)));
  const skipped = allRows.length - rows.length;

  if (rows.length > MAX_ROWS) {
    const err = new Error(
      `CSV has ${rows.length} rows with punches; the limit is ${MAX_ROWS} per upload. Split the file and upload it in parts.`
    );
    err.isRowCapError = true;
    throw err;
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timeZone: true },
  });
  const companyTimezone = company?.timeZone || "UTC";
  const isBncCompany = BNC_COMPANY_IDS.has(companyId);
  const isScopedToTeam = approverRole === "supervisor";
  const actor = { id: approverId, departmentId: approverDepartmentId || null, scoped: isScopedToTeam };

  const identifiers = new Set();
  for (const { data } of rows) {
    if (data.employeeId) identifiers.add(data.employeeId.trim());
    if (data.email) identifiers.add(data.email.trim().toLowerCase());
  }

  const users = await prisma.user.findMany({
    where: {
      ...HUMAN_ONLY,
      companyId,
      // Supervisors: own department or direct reports (BB-080 team rule).
      AND: [
        teamWhere(actor),
        { OR: [{ employeeId: { in: [...identifiers] } }, { email: { in: [...identifiers] } }] },
      ],
    },
    select: {
      id: true,
      employeeId: true,
      email: true,
      departmentId: true,
      profile: { select: { firstName: true, lastName: true } },
    },
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

    const matchedUser =
      (data.employeeId && userByEmployeeId.get(data.employeeId.trim())) ||
      (data.email && userByEmail.get(data.email.trim().toLowerCase())) ||
      null;
    const name = matchedUser ? displayName(matchedUser) : null;

    try {
      if (!identifier) throw new Error("Missing employeeId or email.");
      if (!data.date) throw new Error("Missing date.");
      if (isBlank(data.clockIn)) throw new Error("Missing clock-in.");
      if (isBlank(data.clockOut)) throw new Error("Missing clock-out.");

      const normalizedDate = normalizeDateCell(data.date);
      if (!normalizedDate) {
        throw new Error(`Invalid date format: "${data.date}". Use YYYY-MM-DD.`);
      }

      const user = matchedUser;
      if (!user) {
        throw new Error(
          isScopedToTeam ? "Employee not found in your team." : "Employee not found in this company."
        );
      }

      if (data.punchType && !VALID_PUNCH_TYPES.includes(data.punchType)) {
        throw new Error(`Invalid punchType: ${data.punchType}`);
      }
      if (data.punchType && isDriverSegmentPunchType(data.punchType) && isBncCompany) {
        throw new Error("Driver/Aide punch types are not available for this company.");
      }

      const clockIn = parseCellTime(normalizedDate, data.clockIn, companyTimezone);
      let clockOut = parseCellTime(normalizedDate, data.clockOut, companyTimezone);

      if (isNaN(clockIn)) throw new Error(`Invalid clock-in time "${data.clockIn}". Use 08:00 or 8:00 AM.`);
      if (isNaN(clockOut)) throw new Error(`Invalid clock-out time "${data.clockOut}". Use 17:00 or 5:00 PM.`);

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
          name,
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
        name,
        date: data.date || null,
        clockIn: data.clockIn || null,
        clockOut: data.clockOut || null,
        reason: rowErr.message,
      });
    }
  }

  return { created, failed, skipped };
}

module.exports = {
  buildPunchLogTemplate,
  importPunchLogsFromCsv,
  ImportError,
  MAX_ROWS,
  MAX_TOTAL_ROWS,
  MAX_RANGE_DAYS,
};
