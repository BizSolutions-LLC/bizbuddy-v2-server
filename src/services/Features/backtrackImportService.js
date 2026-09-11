// src/services/Features/backtrackImportService.js
// BB-086 — historical "backtrack" punch-log import from the legacy PadPro
// payroll-summary CSV format. DayCare companies only (not available for
// B&C — same gating as Driver/Aide punch types elsewhere in the importer
// family, see BNC_COMPANY_IDS).
//
// Two-phase, like the schedule importer (BB-081) rather than the flat
// punch-log importer's one-shot commit (BB-077): the synthesized times are
// inherently best-effort (derived from aggregate hours, not real punches), so
// nothing is written until an admin has reviewed the preview and confirmed.
//
//   previewBacktrackImport() — parse, match employees, resolve shift windows,
//     synthesize times, predict post-approval credited hours. Writes nothing.
//   commitBacktrackImport()  — takes the (possibly admin-edited: manual
//     employee assignments, skipped rows) preview rows back, re-validates
//     against current DB state, and creates the real RequestedTimeLog/TimeLog
//     records via the same pipeline BB-077 uses, then syncs the cutoff
//     period's TimeLogApproval queue.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const {
  findOverlappingLog,
  createTimeLogFromRequest,
} = require("@controllers/Features/requestPunchLogController");
const { getLockedCutoffForDate } = require("@controllers/Features/timeLogController");
const {
  findCutoffForCompany,
  syncApprovalRecords,
} = require("@controllers/Features/cutoffPeriodController");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");
const { parseBacktrackPunchLogCsv } = require("@utils/csvBacktrackPunchLogParser");
const { synthesizeDaySegments } = require("@utils/backtrackSegmentSynthesis");

// Expressed in employee×day units (each can expand into up to 2 TimeLog
// records for a triple-segment day) rather than raw CSV rows, since one CSV
// row covers an entire pay period's worth of days. No number for this was
// specified by product — chosen generously relative to the real 2-week
// PadPro export (~40 employees × 10 days ≈ 400 units) with headroom.
const MAX_EMPLOYEE_DAY_ROWS = 1000;

const CANONICAL_SHIFT_NAMES = {
  regular: "Regular Shift",
  driverAm: "Driver/Aide AM Shift",
  driverPm: "Driver/Aide PM Shift",
};

// ── Employee name matching ─────────────────────────────────────────────────
// CSV names are freeform ("Amgao Mario", "Backeng, Arlene B.") — normalizing
// to an unordered token set makes "Last, First M." and "First Last" compare
// equal without needing to guess which format a given row uses.

function normalizeName(str) {
  return (str || "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

function nameTokens(str) {
  return new Set(normalizeName(str).split(" ").filter(Boolean));
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

const FUZZY_THRESHOLD = 0.5;
const AMBIGUITY_MARGIN = 0.15;

/**
 * Matches a CSV row name against the company's users. Returns:
 *   { status: "matched", userId, employeeName, departmentId }
 *   { status: "matched-fuzzy", userId, employeeName, departmentId, similarity, candidates }
 *   { status: "unresolved", candidates }
 */
function matchEmployeeName(rawName, candidateUsers) {
  const target = nameTokens(rawName);
  const scored = candidateUsers
    .map((u) => ({
      userId: u.id,
      employeeName: u.employeeName,
      departmentId: u.departmentId,
      similarity: jaccardSimilarity(target, u.tokens),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  const best = scored[0];
  if (!best || best.similarity === 0) {
    return { status: "unresolved", candidates: scored.slice(0, 3) };
  }
  if (best.similarity === 1) {
    return { status: "matched", userId: best.userId, employeeName: best.employeeName, departmentId: best.departmentId };
  }
  const runnerUp = scored[1];
  const unambiguous = !runnerUp || best.similarity - runnerUp.similarity >= AMBIGUITY_MARGIN;
  if (best.similarity >= FUZZY_THRESHOLD && unambiguous) {
    return {
      status: "matched-fuzzy",
      userId: best.userId,
      employeeName: best.employeeName,
      departmentId: best.departmentId,
      similarity: best.similarity,
      candidates: scored.slice(0, 3),
    };
  }
  return { status: "unresolved", candidates: scored.slice(0, 3) };
}

// ── Shift window resolution ─────────────────────────────────────────────────
// Mirrors resolveDriverAideSegments (timeLogComputeService.js): prefer the
// employee's own UserShift for the day, fall back to the company-wide
// catalog Shift by canonical name.

function timeStrFromDbTime(timeLikeDate) {
  const t = new Date(timeLikeDate);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}:${String(t.getUTCSeconds()).padStart(2, "0")}`;
}

function combineDateWithTime(dateStr, dbTimeValue, tz) {
  const timeStr = timeStrFromDbTime(dbTimeValue);
  return moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm:ss", tz).toDate();
}

function resolveWindow(shiftLike, dateStr, tz) {
  if (!shiftLike?.startTime || !shiftLike?.endTime) return null;
  return {
    start: combineDateWithTime(dateStr, shiftLike.startTime, tz),
    end: combineDateWithTime(dateStr, shiftLike.endTime, tz),
  };
}

function resolveDayShiftWindows({ userId, dateStr, tz, userShiftsByUserDate, catalogShiftMap }) {
  const assigned = userShiftsByUserDate[`${userId}_${dateStr}`] ?? [];
  const resolve = (canonicalName) => {
    const match = assigned.find((us) => us.shift?.shiftName === canonicalName);
    const source = match?.shift ?? catalogShiftMap[canonicalName] ?? null;
    return resolveWindow(source, dateStr, tz);
  };
  return {
    regularWindow: resolve(CANONICAL_SHIFT_NAMES.regular),
    amWindow: resolve(CANONICAL_SHIFT_NAMES.driverAm),
    pmWindow: resolve(CANONICAL_SHIFT_NAMES.driverPm),
  };
}

// ── Shared context (company + users + shift catalog + assignments) ─────────

async function loadCompanyContext({ companyId, actingRole, actingDepartmentId, dates }) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timeZone: true, gracePeriodMinutes: true },
  });
  const tz = company?.timeZone || "America/Los_Angeles";
  const graceMinutes = company?.gracePeriodMinutes ?? 15;

  const isScopedToDepartment = actingRole === "supervisor";
  const users = await prisma.user.findMany({
    where: {
      companyId,
      ...(isScopedToDepartment ? { departmentId: actingDepartmentId } : {}),
    },
    select: {
      id: true,
      departmentId: true,
      profile: { select: { firstName: true, lastName: true } },
    },
  });
  const candidateUsers = users.map((u) => {
    const employeeName = u.profile ? `${u.profile.firstName || ""} ${u.profile.lastName || ""}`.trim() : u.id;
    return { id: u.id, departmentId: u.departmentId, employeeName, tokens: nameTokens(employeeName) };
  });

  const catalogShifts = await prisma.shift.findMany({
    where: { companyId, shiftName: { in: Object.values(CANONICAL_SHIFT_NAMES) } },
    select: { shiftName: true, startTime: true, endTime: true },
  });
  const catalogShiftMap = Object.fromEntries(catalogShifts.map((s) => [s.shiftName, s]));

  const sortedDates = [...dates].sort();
  const rangeStart = moment.tz(sortedDates[0], tz).startOf("day").toDate();
  const rangeEnd = moment.tz(sortedDates[sortedDates.length - 1], tz).endOf("day").toDate();
  const allUserShifts = await prisma.userShift.findMany({
    where: {
      userId: { in: candidateUsers.map((u) => u.id) },
      assignedDate: { gte: rangeStart, lte: rangeEnd },
      status: { not: "cancelled" },
    },
    include: { shift: true },
  });
  const userShiftsByUserDate = {};
  for (const us of allUserShifts) {
    const key = `${us.userId}_${new Date(us.assignedDate).toISOString().slice(0, 10)}`;
    (userShiftsByUserDate[key] = userShiftsByUserDate[key] || []).push(us);
  }

  return { tz, graceMinutes, candidateUsers, catalogShiftMap, userShiftsByUserDate };
}

async function assertOpenCutoffPeriod(cutoffPeriodId, companyId) {
  const cutoffPeriod = await findCutoffForCompany(cutoffPeriodId, companyId);
  if (!cutoffPeriod) {
    const err = new Error("Cutoff period not found.");
    err.isRowCapError = true;
    throw err;
  }
  if (cutoffPeriod.status !== "open") {
    const err = new Error(`Target cutoff period is "${cutoffPeriod.status}" — backtrack import requires an open period.`);
    err.isRowCapError = true;
    throw err;
  }
  return cutoffPeriod;
}

// Only used when the caller didn't pin a specific cutoffPeriodId — looks for
// an existing OPEN period that already fully covers the CSV's date range, so
// preview can auto-select it rather than forcing the admin to go create/pick
// one before they can even see what the file contains. Scoped the same way
// employee visibility is scoped elsewhere in this file: a supervisor only
// sees their own department's period or a company-wide one; admin/superadmin
// only match company-wide periods here (a random other department's period
// is never silently auto-selected for them).
async function findCoveringOpenCutoffPeriod({ companyId, actingRole, actingDepartmentId, startDate, endDate }) {
  const isScopedToDepartment = actingRole === "supervisor";
  const periods = await prisma.cutoffPeriod.findMany({
    where: {
      companyId,
      status: "open",
      OR: isScopedToDepartment
        ? [{ departmentId: actingDepartmentId }, { departmentId: null }]
        : [{ departmentId: null }],
      periodStart: { lte: new Date(startDate) },
      periodEnd: { gte: new Date(endDate) },
    },
  });
  if (periods.length === 0) return null;
  return periods.find((p) => p.departmentId === actingDepartmentId) || periods[0];
}

// ── Preview ──────────────────────────────────────────────────────────────

/**
 * Parses + previews a backtrack punch-log CSV. Writes nothing.
 *
 * cutoffPeriodId is optional:
 *   - given: must resolve to an OPEN period for this company that fully
 *     covers the file's date range, or this throws (a whole-file error —
 *     the admin explicitly picked it, so a mismatch should be surfaced
 *     loudly, not silently worked around).
 *   - omitted: looks for an existing open period covering the file's dates
 *     and uses it automatically if found. If none exists, the preview still
 *     runs (entries are fully computed), but the result carries
 *     `needsCutoffPeriod: true` plus a suggested start/end so the client can
 *     prompt to create one (via the existing POST /api/cutoff-periods) before
 *     confirming — confirm still requires a real, open cutoffPeriodId.
 *
 * Returns { period, cutoffPeriodId, needsCutoffPeriod, suggestedPeriodStart,
 *   suggestedPeriodEnd, entries } where each entry is one employee/day:
 *   { csvRowNumber, rawName, type, date, employeeMatch, leaveCode,
 *     status: "ready"|"conflict"|"error"|"unresolved-employee"|"informational",
 *     reason, records, warnings }
 */
async function previewBacktrackImport({ buffer, companyId, cutoffPeriodId, actingRole, actingDepartmentId }) {
  if (BNC_COMPANY_IDS.has(companyId)) {
    const err = new Error("Backtrack import is not available for this company.");
    err.isRowCapError = true;
    throw err;
  }

  const { period, rows } = parseBacktrackPunchLogCsv(buffer);

  const allDates = new Set();
  for (const row of rows) for (const date of Object.keys(row.days)) allDates.add(date);

  const totalUnits = rows.length * allDates.size;
  if (totalUnits > MAX_EMPLOYEE_DAY_ROWS) {
    const err = new Error(
      `This import covers ${totalUnits} employee×day rows; the limit is ${MAX_EMPLOYEE_DAY_ROWS} per upload.`
    );
    err.isRowCapError = true;
    throw err;
  }

  const sortedDates = [...allDates].sort();
  const suggestedPeriodStart = sortedDates[0];
  const suggestedPeriodEnd = sortedDates[sortedDates.length - 1];

  let cutoffPeriod = null;
  let needsCutoffPeriod = false;

  if (cutoffPeriodId) {
    cutoffPeriod = await assertOpenCutoffPeriod(cutoffPeriodId, companyId);
    const coversRange =
      new Date(cutoffPeriod.periodStart) <= new Date(suggestedPeriodStart) &&
      new Date(cutoffPeriod.periodEnd) >= new Date(suggestedPeriodEnd);
    if (!coversRange) {
      const err = new Error(
        `Selected cutoff period doesn't cover this file's date range (${suggestedPeriodStart} to ${suggestedPeriodEnd}).`
      );
      err.isRowCapError = true;
      throw err;
    }
  } else {
    cutoffPeriod = await findCoveringOpenCutoffPeriod({
      companyId, actingRole, actingDepartmentId, startDate: suggestedPeriodStart, endDate: suggestedPeriodEnd,
    });
    needsCutoffPeriod = !cutoffPeriod;
  }

  const { tz, graceMinutes, candidateUsers, catalogShiftMap, userShiftsByUserDate } =
    await loadCompanyContext({ companyId, actingRole, actingDepartmentId, dates: [...allDates] });

  const entries = [];

  for (const row of rows) {
    const match = matchEmployeeName(row.rawName, candidateUsers);

    for (const [date, cells] of Object.entries(row.days)) {
      const base = {
        csvRowNumber: row.rowNumber,
        rawName: row.rawName,
        type: row.type,
        date,
        employeeMatch: match,
        warnings: row.warnings,
      };

      const leaveCodes = [cells.regular?.leaveCode, cells.driverAm?.leaveCode, cells.driverPm?.leaveCode].filter(Boolean);
      const regularHours = cells.regular?.value ?? null;
      const amHours = cells.driverAm?.value ?? null;
      const pmHours = cells.driverPm?.value ?? null;
      const hasAnyHours = [regularHours, amHours, pmHours].some((v) => typeof v === "number" && v > 0);

      if (!hasAnyHours) {
        if (leaveCodes.length > 0) {
          entries.push({ ...base, leaveCode: leaveCodes[0], status: "informational", reason: `Marked "${leaveCodes[0]}" in source file — informational only, no record created.`, records: [] });
        }
        continue; // nothing to import for this employee/day
      }

      if (match.status === "unresolved") {
        entries.push({ ...base, regularHours, amHours, pmHours, leaveCode: leaveCodes[0] || null, status: "unresolved-employee", reason: "Could not confidently match this name to an employee — assign manually.", records: [] });
        continue;
      }

      const { regularWindow, amWindow, pmWindow } = resolveDayShiftWindows({
        userId: match.userId, dateStr: date, tz, userShiftsByUserDate, catalogShiftMap,
      });

      const { records, error } = synthesizeDaySegments({
        regularHours, amHours, pmHours, regularWindow, amWindow, pmWindow, graceMinutes,
      });

      if (error) {
        entries.push({ ...base, regularHours, amHours, pmHours, leaveCode: leaveCodes[0] || null, status: "error", reason: error, records: [] });
        continue;
      }

      let status = "ready";
      let reason = null;
      for (const record of records) {
        const conflict = await findOverlappingLog(match.userId, record.timeIn, record.timeOut);
        if (conflict) {
          status = "conflict";
          reason = "Overlaps an existing punch log for this employee — deferred for manual checking.";
          break;
        }
        const lockedPeriod = await getLockedCutoffForDate(companyId, match.departmentId ?? null, date, tz);
        if (lockedPeriod) {
          status = "conflict";
          reason = `Cutoff period covering this date is ${lockedPeriod.status}; cannot import.`;
          break;
        }
      }

      entries.push({ ...base, regularHours, amHours, pmHours, leaveCode: leaveCodes[0] || null, status, reason, records });
    }
  }

  return {
    period,
    cutoffPeriodId: cutoffPeriod?.id ?? null,
    needsCutoffPeriod,
    suggestedPeriodStart,
    suggestedPeriodEnd,
    entries,
  };
}

// ── Commit ───────────────────────────────────────────────────────────────

/**
 * Commits a (possibly admin-edited) preview batch. `entries` mirrors the
 * preview shape, with `skip: true` for excluded rows and an optional
 * top-level `userId` for rows the admin manually assigned (an
 * `unresolved-employee` preview row has no `employeeMatch.userId`).
 * Re-resolves shift windows and re-checks conflicts/lock status against
 * current DB state rather than trusting the preview. A day whose synthesis
 * produces two records (e.g. AM+PM) is committed atomically per-entry — if
 * either record conflicts, the whole entry is deferred, matching the
 * "defer for manual checking" rule (never partially import a day).
 *
 * Returns { created, failed, conflicted, approvalsSynced }.
 */
async function commitBacktrackImport({ companyId, actingUserId, actingRole, actingDepartmentId, cutoffPeriodId, entries }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    const err = new Error("No rows to import.");
    err.isRowCapError = true;
    throw err;
  }
  if (entries.length > MAX_EMPLOYEE_DAY_ROWS) {
    const err = new Error(`Import has ${entries.length} rows; the limit is ${MAX_EMPLOYEE_DAY_ROWS}.`);
    err.isRowCapError = true;
    throw err;
  }

  const cutoffPeriod = await assertOpenCutoffPeriod(cutoffPeriodId, companyId);

  const candidateUserIds = [...new Set(
    entries.map((e) => e.userId || e.employeeMatch?.userId).filter(Boolean)
  )];
  const isScopedToDepartment = actingRole === "supervisor";
  const users = await prisma.user.findMany({
    where: { id: { in: candidateUserIds }, companyId, status: "active" },
    select: { id: true, departmentId: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const dates = [...new Set(entries.map((e) => e.date).filter(Boolean))];
  const { tz, graceMinutes, catalogShiftMap, userShiftsByUserDate } = await loadCompanyContext({
    companyId, actingRole, actingDepartmentId, dates: dates.length > 0 ? dates : [moment().format("YYYY-MM-DD")],
  });

  const created = [];
  const failed = [];
  const conflicted = [];

  for (const entry of entries) {
    if (entry.skip) continue;

    const userId = entry.userId || entry.employeeMatch?.userId;
    const base = { row: entry.csvRowNumber, employeeId: entry.rawName, date: entry.date };

    try {
      if (!userId) throw new Error("No employee assigned to this row.");
      const user = userById.get(userId);
      if (!user) throw new Error("Employee not found in this company.");
      if (isScopedToDepartment && user.departmentId !== actingDepartmentId) {
        throw new Error("Employee not found in your department.");
      }
      if (!entry.date) throw new Error("Missing date.");

      const regularHours = entry.regularHours ?? null;
      const amHours = entry.amHours ?? null;
      const pmHours = entry.pmHours ?? null;

      const { regularWindow, amWindow, pmWindow } = resolveDayShiftWindows({
        userId, dateStr: entry.date, tz, userShiftsByUserDate, catalogShiftMap,
      });

      const { records, error } = synthesizeDaySegments({
        regularHours, amHours, pmHours, regularWindow, amWindow, pmWindow, graceMinutes,
      });
      if (error) throw new Error(error);
      if (records.length === 0) throw new Error("Nothing to import for this row.");

      // Pre-check every record this entry would create before writing any of
      // them — a day that synthesizes into two records (AM+PM) must be
      // deferred as a whole if either half conflicts, not partially imported.
      let entryConflictReason = null;
      for (const record of records) {
        const conflict = await findOverlappingLog(userId, record.timeIn, record.timeOut);
        if (conflict) {
          entryConflictReason = "Overlaps an existing punch log — deferred for manual checking.";
          break;
        }
      }
      if (!entryConflictReason) {
        const lockedPeriod = await getLockedCutoffForDate(companyId, user.departmentId ?? null, entry.date, tz);
        if (lockedPeriod) {
          entryConflictReason = `Cutoff period covering this date is ${lockedPeriod.status}; cannot import.`;
        }
      }
      if (entryConflictReason) {
        conflicted.push({ ...base, reason: entryConflictReason });
        continue;
      }

      for (const record of records) {
        let requestedTimeLog;
        try {
          requestedTimeLog = await prisma.requestedTimeLog.create({
            data: {
              userId,
              approverId: actingUserId,
              requestedDate: new Date(entry.date),
              requestedClockIn: record.timeIn,
              requestedClockOut: record.timeOut,
              description: "Backtrack import from PadPro",
              requestedPunchType: record.punchType,
              status: "APPROVED",
              submittedAt: new Date(),
              approvedAt: new Date(),
            },
          });

          const timeLog = await createTimeLogFromRequest({
            userId,
            companyId,
            timeIn: record.timeIn,
            timeOut: record.timeOut,
            requestedPunchType: record.punchType,
          });

          await prisma.requestedTimeLog.update({
            where: { id: requestedTimeLog.id },
            data: { createdTimeLogId: timeLog.id },
          });

          created.push({ ...base, punchType: record.punchType, timeLogId: timeLog.id, requestedTimeLogId: requestedTimeLog.id });
        } catch (createErr) {
          if (requestedTimeLog) {
            await prisma.requestedTimeLog.delete({ where: { id: requestedTimeLog.id } }).catch(() => {});
          }
          throw createErr;
        }
      }
    } catch (rowErr) {
      failed.push({ ...base, reason: rowErr.message });
    }
  }

  let approvalsSynced = 0;
  if (created.length > 0) {
    try {
      approvalsSynced = await syncApprovalRecords(cutoffPeriod, companyId, tz);
    } catch (syncErr) {
      console.error("[backtrackImportService] syncApprovalRecords failed after commit:", syncErr.message);
    }
  }

  return { created, failed, conflicted, approvalsSynced };
}

module.exports = { previewBacktrackImport, commitBacktrackImport, MAX_EMPLOYEE_DAY_ROWS };
