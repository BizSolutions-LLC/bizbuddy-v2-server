// src/services/Features/scheduleImportService.js
// Row-level business logic for the CSV schedule bulk-import feature (BB-081, reworked
// as "Upload Schedule" in BB-103). CSV shape/header validation and block-merging live
// in @utils/csvScheduleParser; this file builds the pre-filled template, resolves
// employees and shifts, detects conflicts, and commits. Two phases:
//   1. previewSchedule() — parses the file into one item per proposed assignment
//      (a marked shift column, or a contiguous run of time blocks), checks overlaps
//      (overnight spill included) within the file and against existing assignments,
//      and says per item what the admin may do (create / skip / replace). Writes nothing.
//   2. confirmSchedule() — takes one decision per item back, re-validates everything
//      against the current DB (the preview may be stale), and writes. A Replace deletes
//      the conflicting assignments and creates the new one in one transaction per item.
//
// Overlaps are compared on an absolute minute timeline (day number × 1440 + minute of
// day). A shift whose end is at or before its start crosses midnight and runs into the
// next date, so 19:00–05:00 on Oct 26 overlaps 04:00–08:00 on Oct 27.
//
// The pre-BB-103 preview/confirm (previewScheduleImport / commitScheduleImport, the
// `rows` contract) stay below until the new client ships.

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const moment = require("moment-timezone");
const { hasTimeOverlap } = require("@controllers/Features/shiftAssignmentController");
const {
  notifyEmployeeShiftAssigned,
  notifyManagementShiftAssignment,
  notifyEmployeeShiftReplaced,
} = require("@services/shiftNotificationService");
const {
  parseScheduleCsv,
  buildTemplateCsv,
  mergeBlocksToTimeRanges,
  shiftColumnHeaders,
  normalizeDate,
  IDENTIFIER_COLUMNS,
} = require("@utils/csvScheduleParser");
const {
  ImportError,
  USER_SELECT,
  teamWhere,
  inTeam,
  dayNum,
  ymdOf,
  splitIds,
  displayName,
  loadActor,
  parseDateRange,
  resolveTargetEmployees,
} = require("@services/Features/importTargets");

const MODES = ["time_blocks", "shifts"];
const MAX_RANGE_DAYS = 14;
const MAX_ROWS = 2000; // ~140 employees × 14 days
const MAX_ITEMS = 4000; // several shifts per row are allowed
const LEGACY_MAX_ROWS = 300;
const DAY_MINUTES = 24 * 60;

// Shared with Import Punch Logs (BB-108); kept under its old name for the controller.
const ScheduleImportError = ImportError;

// ── Small helpers ───────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");
const dateColStr = (d) => new Date(d).toISOString().slice(0, 10);
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const timeColToHHMM = (d) => {
  const x = new Date(d);
  return `${pad2(x.getUTCHours())}:${pad2(x.getUTCMinutes())}`;
};
const crossesMidnightOf = (startTime, endTime) => toMinutes(endTime) <= toMinutes(startTime);

// Absolute [start, end) in minutes for a shift on `ymd`; an overnight shift spills
// into the next date.
function intervalOf(ymd, startTime, endTime) {
  const base = dayNum(ymd) * DAY_MINUTES;
  const start = toMinutes(startTime);
  let end = toMinutes(endTime);
  if (end <= start) end += DAY_MINUTES;
  return { start: base + start, end: base + end };
}
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

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

const employeeOut = (u) => ({
  userId: u.id,
  email: u.email,
  name: displayName(u),
});

async function loadCompanyTimezone(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { timeZone: true } });
  return company?.timeZone || "UTC";
}

function parseMode(raw) {
  if (!MODES.includes(raw)) throw new ScheduleImportError(400, `mode must be one of: ${MODES.join(", ")}.`);
  return raw;
}

// Inclusive date range, at most MAX_RANGE_DAYS days.
const parseRange = (startRaw, endRaw) => parseDateRange(startRaw, endRaw, MAX_RANGE_DAYS);

// The picked shifts, in the order given. Company shifts only.
async function loadShiftPool(companyId, shiftIds) {
  if (shiftIds.length === 0) throw new ScheduleImportError(400, "Pick at least one shift (shiftIds) for shifts mode.");
  if (new Set(shiftIds).size !== shiftIds.length) throw new ScheduleImportError(400, "shiftIds contains duplicates.");
  const shifts = await prisma.shift.findMany({
    where: { id: { in: shiftIds }, companyId },
    select: { id: true, shiftName: true, startTime: true, endTime: true, crossesMidnight: true },
  });
  if (shifts.length !== shiftIds.length)
    throw new ScheduleImportError(403, "One or more shifts don't belong to your company.");
  const byId = new Map(shifts.map((s) => [s.id, s]));
  return shiftIds.map((id) => byId.get(id));
}

function poolShiftOut(s) {
  const startTime = timeColToHHMM(s.startTime);
  const endTime = timeColToHHMM(s.endTime);
  return {
    shiftId: s.id,
    shiftName: s.shiftName,
    startTime,
    endTime,
    crossesMidnight: crossesMidnightOf(startTime, endTime),
    isExisting: true,
  };
}


// ── Replace rules ───────────────────────────────────────────────────────────

// Punches and locked/processed cutoffs around the dates in play, loaded once.
async function loadReplaceContext({ companyId, tz, userIds, minDate, maxDate }) {
  const from = moment.tz(ymdOf(dayNum(minDate) - 1), tz).startOf("day").toDate();
  const to = moment.tz(ymdOf(dayNum(maxDate) + 1), tz).endOf("day").toDate();
  const [logs, cutoffs] = await Promise.all([
    prisma.timeLog.findMany({
      where: { userId: { in: userIds }, timeIn: { gte: from, lte: to } },
      select: { userId: true, timeIn: true },
    }),
    prisma.cutoffPeriod.findMany({
      where: { companyId, status: { in: ["locked", "processed"] }, periodStart: { lte: to }, periodEnd: { gte: from } },
      select: { departmentId: true, periodStart: true, periodEnd: true, status: true },
    }),
  ]);
  return {
    tz,
    cutoffs,
    punchDays: new Set(logs.map((l) => `${l.userId}|${moment.tz(l.timeIn, tz).format("YYYY-MM-DD")}`)),
  };
}

// Same matching rule as timeLogController.getLockedCutoffForDate: a department period
// or a company-wide one covering the date in the company timezone.
function lockedCutoffFor(ctx, departmentId, ymd) {
  const dayStart = moment.tz(ymd, ctx.tz).startOf("day").toDate();
  const dayEnd = moment.tz(ymd, ctx.tz).endOf("day").toDate();
  return (
    ctx.cutoffs.find(
      (p) =>
        (p.departmentId === null || p.departmentId === departmentId) &&
        p.periodStart <= dayEnd &&
        p.periodEnd >= dayStart
    ) || null
  );
}

// Why an existing assignment can't be replaced, or null when it can.
function replaceBlocker(ctx, existing, departmentId) {
  if (existing.status === "completed") return "This shift is already completed.";
  if (ctx.punchDays.has(`${existing.userId}|${existing.date}`)) return "The employee already has punches on this date.";
  const cutoff = lockedCutoffFor(ctx, departmentId, existing.date);
  if (cutoff) return `This date is in a ${cutoff.status} cutoff.`;
  return null;
}

// Existing (non-cancelled) assignments for these employees, one day either side of
// the range so overnight spill in both directions is caught. Grouped by user.
async function loadExistingAssignments(userIds, minDate, maxDate) {
  const rows = await prisma.userShift.findMany({
    where: {
      userId: { in: userIds },
      status: { not: "cancelled" },
      assignedDate: { gte: new Date(ymdOf(dayNum(minDate) - 1)), lte: new Date(ymdOf(dayNum(maxDate) + 1)) },
    },
    select: {
      id: true,
      userId: true,
      shiftId: true,
      assignedDate: true,
      status: true,
      customStartTime: true,
      customEndTime: true,
      shift: { select: { shiftName: true, startTime: true, endTime: true } },
    },
  });
  const byUser = new Map();
  for (const us of rows) {
    const startTime = timeColToHHMM(us.customStartTime || us.shift.startTime);
    const endTime = timeColToHHMM(us.customEndTime || us.shift.endTime);
    const date = dateColStr(us.assignedDate);
    if (!byUser.has(us.userId)) byUser.set(us.userId, []);
    byUser.get(us.userId).push({
      userShiftId: us.id,
      userId: us.userId,
      shiftId: us.shiftId,
      shiftName: us.shift.shiftName,
      date,
      startTime,
      endTime,
      crossesMidnight: crossesMidnightOf(startTime, endTime),
      status: us.status,
      interval: intervalOf(date, startTime, endTime),
    });
  }
  return byUser;
}

const existingConflictOut = (e, replaceable, reason) => ({
  userShiftId: e.userShiftId,
  shiftId: e.shiftId,
  shiftName: e.shiftName,
  date: e.date,
  startTime: e.startTime,
  endTime: e.endTime,
  crossesMidnight: e.crossesMidnight,
  replaceable,
  notReplaceableReason: reason,
});

// Company shifts by (start, end, name) — time_blocks mode reuses an existing Shift with
// exactly the same times and name instead of creating a duplicate. Oldest wins.
async function loadShiftReuseMap(companyId) {
  const shifts = await prisma.shift.findMany({
    where: { companyId },
    select: { id: true, shiftName: true, startTime: true, endTime: true, crossesMidnight: true },
    orderBy: { createdAt: "asc" },
  });
  const map = new Map();
  for (const s of shifts) {
    const startTime = timeColToHHMM(s.startTime);
    const endTime = timeColToHHMM(s.endTime);
    if (s.crossesMidnight !== crossesMidnightOf(startTime, endTime)) continue;
    const key = reuseKey(startTime, endTime, s.shiftName);
    if (!map.has(key)) map.set(key, s);
  }
  return map;
}
const reuseKey = (startTime, endTime, name) => `${startTime}|${endTime}|${name.trim().toLowerCase()}`;

// ── Template ────────────────────────────────────────────────────────────────

/**
 * GET /template — pre-filled CSV: one row per employee × date. Still accepts the
 * pre-BB-103 `weekStart` (→ time_blocks, weekStart … weekStart + 6).
 */
async function buildScheduleTemplate({ companyId, actingUserId, actingRole, query }) {
  const actor = await loadActor({ companyId, actingUserId, actingRole });

  let { mode, startDate, endDate } = query;
  if (!mode && query.weekStart) {
    const weekStart = normalizeDate(query.weekStart);
    if (!weekStart) throw new ScheduleImportError(400, "Invalid weekStart (YYYY-MM-DD).");
    mode = "time_blocks";
    startDate = weekStart;
    endDate = ymdOf(dayNum(weekStart) + 6);
  }
  mode = parseMode(mode);
  const range = parseRange(startDate, endDate);
  const pool = mode === "shifts" ? await loadShiftPool(companyId, splitIds(query.shiftIds)) : [];
  const employees = await resolveTargetEmployees(
    actor,
    { userIds: splitIds(query.userIds), departmentId: query.departmentId || null },
    { action: "upload schedules" }
  );

  const rowCount = employees.length * range.dates.length;
  if (rowCount > MAX_ROWS)
    throw new ScheduleImportError(
      400,
      `That's ${rowCount} rows (${employees.length} employees × ${range.dates.length} days); the limit is ${MAX_ROWS}. Pick fewer employees or days.`
    );

  const csv = buildTemplateCsv({
    mode,
    dates: range.dates,
    employees: employees.map((e) => ({ email: e.email, name: displayName(e) })),
    shiftHeaders: shiftColumnHeaders(pool),
  });
  return { csv, filename: `schedule_${mode}_${range.startDate}_to_${range.endDate}.csv` };
}

// ── Preview ─────────────────────────────────────────────────────────────────

/**
 * POST /preview (multipart: file, mode, overnight, shiftIds, optional startDate/endDate).
 * Returns { mode, range, summary, items }. Throws ScheduleImportError / CsvShapeError
 * for whole-file problems (400/403); row problems become `error` items.
 */
async function previewSchedule({ buffer, companyId, actingUserId, actingRole, body }) {
  const actor = await loadActor({ companyId, actingUserId, actingRole });
  const mode = parseMode(body.mode);
  const overnight = body.overnight === true || body.overnight === "true";
  const pool = mode === "shifts" ? await loadShiftPool(companyId, splitIds(body.shiftIds)) : [];
  const poolOut = pool.map(poolShiftOut);

  const rows = parseScheduleCsv(buffer, { mode, shiftHeaders: shiftColumnHeaders(pool) });
  if (rows.length > MAX_ROWS)
    throw new ScheduleImportError(400, `CSV has ${rows.length} rows; the limit is ${MAX_ROWS} per upload.`);

  // Range: the one sent, else the file's own dates (which must fit in 14 days).
  let range = body.startDate || body.endDate ? parseRange(body.startDate, body.endDate) : null;
  if (!range) {
    const fileDays = rows.map((r) => normalizeDate(r.data.date)).filter(Boolean).map(dayNum);
    if (fileDays.length) {
      const min = Math.min(...fileDays);
      const max = Math.max(...fileDays);
      if (max - min + 1 > MAX_RANGE_DAYS)
        throw new ScheduleImportError(
          400,
          `The file covers ${max - min + 1} days (${ymdOf(min)} to ${ymdOf(max)}); the limit is ${MAX_RANGE_DAYS}.`
        );
      range = { startDate: ymdOf(min), endDate: ymdOf(max) };
    }
  }

  // Employees named in the file, company-wide (scope is checked per row so the
  // reason can say "not in your department" / "inactive").
  const identifiers = new Set();
  for (const { data } of rows) {
    for (const col of IDENTIFIER_COLUMNS) {
      const v = data[col]?.trim();
      if (v) {
        identifiers.add(v);
        identifiers.add(v.toLowerCase());
      }
    }
  }
  const users = await prisma.user.findMany({
    where: {
      ...HUMAN_ONLY,
      companyId,
      OR: [{ employeeId: { in: [...identifiers] } }, { email: { in: [...identifiers] } }],
    },
    select: USER_SELECT,
  });
  const byEmployeeId = new Map();
  const byEmail = new Map();
  for (const u of users) {
    if (u.employeeId) byEmployeeId.set(u.employeeId.trim(), u);
    if (u.email) byEmail.set(u.email.trim().toLowerCase(), u);
  }
  // Templates carry `email`; an `employeeId` column (older files) still matches.
  const lookupUser = (data) => {
    const email = data.email?.trim().toLowerCase();
    const id = data.employeeId?.trim();
    return (email && byEmail.get(email)) || (id && (byEmployeeId.get(id) || byEmail.get(id.toLowerCase()))) || null;
  };

  const reuse = mode === "time_blocks" ? await loadShiftReuseMap(companyId) : null;

  const items = [];
  let blankRows = 0;
  for (const { rowNumber, data, marks } of rows) {
    const rowError = (reason, employee = null, date = null) =>
      items.push({
        key: `r${rowNumber}`,
        row: rowNumber,
        employee,
        date,
        shift: null,
        status: "error",
        reason,
        conflicts: [],
        allowedActions: ["skip"],
      });

    let proposals;
    if (mode === "shifts") {
      const badIdx = marks.findIndex((m) => m === null);
      if (badIdx >= 0) {
        rowError(`Unrecognised value under "${pool[badIdx].shiftName}". Use 1 to assign, or leave it blank.`);
        continue;
      }
      proposals = marks
        .map((m, i) => (m ? { key: `r${rowNumber}:c${i + 1}`, shift: poolOut[i] } : null))
        .filter(Boolean);
    } else {
      proposals = mergeBlocksToTimeRanges(data, overnight).map((r, k) => {
        const match = reuse.get(reuseKey(r.startTime, r.endTime, defaultShiftName(r.startTime, r.endTime)));
        return {
          key: `r${rowNumber}:b${k + 1}`,
          shift: {
            shiftId: match?.id ?? null,
            shiftName: match?.shiftName ?? defaultShiftName(r.startTime, r.endTime),
            startTime: r.startTime,
            endTime: r.endTime,
            crossesMidnight: r.crossesMidnight,
            isExisting: Boolean(match),
          },
        };
      });
    }

    // Blank row = "no shift that day".
    if (proposals.length === 0) {
      blankRows += 1;
      continue;
    }

    const identifier = data.email?.trim() || data.employeeId?.trim() || null;
    if (!identifier) {
      rowError("Missing email.");
      continue;
    }
    const date = normalizeDate(data.date);
    if (!date) {
      rowError(data.date ? `Invalid date: "${data.date}".` : "Missing date.");
      continue;
    }
    const user = lookupUser(data);
    const fallbackEmployee = { userId: null, email: identifier, name: data.name || null };
    if (!user || !inTeam(actor, user)) {
      rowError(actor.scoped ? "Employee not found in your team." : "Employee not found in this company.", fallbackEmployee, date);
      continue;
    }
    if (user.status !== "active") {
      rowError("Employee is inactive.", employeeOut(user), date);
      continue;
    }
    if (range && (date < range.startDate || date > range.endDate)) {
      rowError(`Date is outside ${range.startDate} to ${range.endDate}.`, employeeOut(user), date);
      continue;
    }

    for (const p of proposals) {
      items.push({
        key: p.key,
        row: rowNumber,
        employee: employeeOut(user),
        date,
        shift: p.shift,
        status: "ready",
        reason: null,
        conflicts: [],
        allowedActions: ["create"],
        _user: user,
        _interval: intervalOf(date, p.shift.startTime, p.shift.endTime),
      });
    }
  }

  const live = items.filter((i) => i._interval);

  // Within the file: any two items of one employee that overlap (spill included).
  const byUser = new Map();
  for (const it of live) {
    if (!byUser.has(it._user.id)) byUser.set(it._user.id, []);
    byUser.get(it._user.id).push(it);
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => a._interval.start - b._interval.start);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j]._interval.start < list[i]._interval.end; j++) {
        const a = list[i];
        const b = list[j];
        for (const [x, y] of [[a, b], [b, a]]) {
          x.status = "conflict_file";
          x.reason = "Overlaps another shift for this employee in this file.";
          x.allowedActions = ["skip"];
          x.conflicts.push({
            key: y.key,
            date: y.date,
            shiftName: y.shift.shiftName,
            startTime: y.shift.startTime,
            endTime: y.shift.endTime,
            crossesMidnight: y.shift.crossesMidnight,
          });
        }
      }
    }
  }

  // Against existing assignments.
  if (live.length) {
    const dates = live.map((i) => i.date).sort();
    const userIds = [...byUser.keys()];
    const tz = await loadCompanyTimezone(companyId);
    const [existingByUser, ctx] = await Promise.all([
      loadExistingAssignments(userIds, dates[0], dates[dates.length - 1]),
      loadReplaceContext({ companyId, tz, userIds, minDate: dates[0], maxDate: dates[dates.length - 1] }),
    ]);
    for (const it of live) {
      if (it.status === "conflict_file") continue;
      const clashes = (existingByUser.get(it._user.id) || []).filter((e) => overlaps(e.interval, it._interval));
      if (!clashes.length) continue;
      it.status = "conflict_existing";
      it.conflicts = clashes.map((e) => {
        const blocker = replaceBlocker(ctx, e, it._user.departmentId);
        return existingConflictOut(e, !blocker, blocker);
      });
      const first = clashes[0];
      it.reason =
        first.date === it.date
          ? `Overlaps an existing shift ("${first.shiftName}") on this date.`
          : `Overlaps an existing shift ("${first.shiftName}") on ${first.date}.`;
      it.allowedActions = it.conflicts.every((c) => c.replaceable) ? ["skip", "replace"] : ["skip"];
    }
  }

  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    mode,
    range,
    summary: {
      rows: rows.length,
      blankRows,
      ready: count("ready"),
      conflictExisting: count("conflict_existing"),
      conflictFile: count("conflict_file"),
      error: count("error"),
    },
    items: items.map(({ _user, _interval, ...rest }) => rest),
  };
}

// ── Confirm ─────────────────────────────────────────────────────────────────

/**
 * POST /confirm — { mode, decisions: [{ key, action }], items: [...preview items] }.
 * Every create/replace is re-validated against the current DB. Returns
 * { created, replaced, skipped, failed }.
 */
async function confirmSchedule({ companyId, actingUserId, actingRole, body }) {
  const actor = await loadActor({ companyId, actingUserId, actingRole });
  const mode = parseMode(body.mode);
  const items = Array.isArray(body.items) ? body.items : [];
  const decisions = Array.isArray(body.decisions) ? body.decisions : [];
  if (decisions.length === 0) throw new ScheduleImportError(400, "No decisions to import.");
  if (decisions.length > MAX_ITEMS || items.length > MAX_ITEMS)
    throw new ScheduleImportError(400, `Too many items; the limit is ${MAX_ITEMS}.`);

  const created = [];
  const replaced = [];
  const skipped = [];
  const failed = [];

  const itemByKey = new Map(items.filter((i) => i && i.key).map((i) => [i.key, i]));
  const seenKeys = new Set();
  const work = [];
  for (const d of decisions) {
    const key = d?.key;
    if (!key || seenKeys.has(key)) {
      failed.push({ key: key ?? null, reason: key ? "Duplicate decision for this item." : "Decision without a key." });
      continue;
    }
    seenKeys.add(key);
    const item = itemByKey.get(key);
    if (!item) failed.push({ key, reason: "Item not found in the request." });
    else if (d.action === "skip") skipped.push({ key });
    else if (d.action === "create" || d.action === "replace") work.push({ item, action: d.action });
    else failed.push({ key, reason: `Unknown action "${d.action}".` });
  }
  if (work.length === 0) return { created, replaced, skipped, failed };

  const tz = await loadCompanyTimezone(companyId);
  const userIds = [...new Set(work.map((w) => w.item.employee?.userId).filter(Boolean))];
  const users = await prisma.user.findMany({ where: { ...HUMAN_ONLY, id: { in: userIds }, companyId }, select: USER_SELECT });
  const userById = new Map(users.map((u) => [u.id, u]));

  const companyShifts =
    mode === "shifts"
      ? new Map(
          (
            await prisma.shift.findMany({
              where: { companyId, id: { in: [...new Set(work.map((w) => w.item.shift?.shiftId).filter(Boolean))] } },
              select: { id: true, shiftName: true, startTime: true, endTime: true },
            })
          ).map((s) => [s.id, s])
        )
      : null;
  const reuse = mode === "time_blocks" ? await loadShiftReuseMap(companyId) : null;

  const workDates = work.map((w) => normalizeDate(w.item.date)).filter(Boolean).sort();
  const minDate = workDates[0];
  const maxDate = workDates[workDates.length - 1];
  const [existingByUser, ctx] = minDate
    ? await Promise.all([
        loadExistingAssignments(userIds, minDate, maxDate),
        loadReplaceContext({ companyId, tz, userIds, minDate, maxDate }),
      ])
    : [new Map(), null];
  const acceptedByUser = new Map(); // intervals created in this batch

  for (const { item, action } of work) {
    const fail = (reason) => failed.push({ key: item.key, reason });

    const user = userById.get(item.employee?.userId);
    if (!user || !inTeam(actor, user)) {
      fail(actor.scoped ? "Employee not found in your team." : "Employee not found in this company.");
      continue;
    }
    if (user.status !== "active") {
      fail("Employee is inactive.");
      continue;
    }
    const date = normalizeDate(item.date);
    if (!date) {
      fail("Invalid date.");
      continue;
    }

    // The shift to assign: an existing pool shift, or block times + (edited) name.
    let target;
    if (mode === "shifts") {
      const s = companyShifts.get(item.shift?.shiftId);
      if (!s) {
        fail("Shift not found in this company.");
        continue;
      }
      target = { shiftId: s.id, shiftName: s.shiftName, startTime: timeColToHHMM(s.startTime), endTime: timeColToHHMM(s.endTime) };
    } else {
      const { startTime, endTime } = item.shift || {};
      const shiftName = String(item.shift?.shiftName || "").trim();
      if (!/^\d{2}:\d{2}$/.test(startTime || "") || !/^\d{2}:\d{2}$/.test(endTime || "") || !shiftName) {
        fail("Incomplete shift data.");
        continue;
      }
      target = { shiftId: null, shiftName, startTime, endTime };
    }
    const interval = intervalOf(date, target.startTime, target.endTime);

    if ((acceptedByUser.get(user.id) || []).some((a) => overlaps(a, interval))) {
      fail("Overlaps another shift created in this import.");
      continue;
    }
    const clashes = (existingByUser.get(user.id) || []).filter((e) => overlaps(e.interval, interval));
    if (clashes.length && action === "create") {
      fail(`Overlaps an existing shift ("${clashes[0].shiftName}") on ${clashes[0].date}.`);
      continue;
    }
    if (clashes.length && action === "replace") {
      const listed = new Set((item.conflicts || []).map((c) => c.userShiftId));
      if (clashes.some((c) => !listed.has(c.userShiftId))) {
        fail("The schedule changed since the preview. Upload the file again.");
        continue;
      }
      const blocker = clashes.map((c) => replaceBlocker(ctx, c, user.departmentId)).find(Boolean);
      if (blocker) {
        fail(`Can't replace: ${blocker}`);
        continue;
      }
    }

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        let shift = target.shiftId
          ? { id: target.shiftId, shiftName: target.shiftName }
          : reuse.get(reuseKey(target.startTime, target.endTime, target.shiftName));
        let newShift = null;
        if (!shift) {
          newShift = await tx.shift.create({
            data: {
              companyId,
              shiftName: target.shiftName,
              startTime: hhmmToEpochDate(target.startTime).toISOString(),
              endTime: hhmmToEpochDate(target.endTime).toISOString(),
              crossesMidnight: crossesMidnightOf(target.startTime, target.endTime),
              differentialMultiplier: 1.0,
              timeZone: tz,
            },
          });
          shift = newShift;
        }
        if (clashes.length) {
          await tx.userShift.deleteMany({ where: { id: { in: clashes.map((c) => c.userShiftId) } } });
        }
        const userShift = await tx.userShift.create({
          data: { userId: user.id, shiftId: shift.id, assignedDate: new Date(date), createdFrom: "bulk", status: "scheduled" },
        });
        return { shift, newShift, userShift };
      });
    } catch (err) {
      console.error(`❌ Schedule import item ${item.key} failed:`, err);
      fail("Could not save this item.");
      continue;
    }

    if (result.newShift) reuse.set(reuseKey(target.startTime, target.endTime, target.shiftName), result.newShift);
    if (clashes.length) {
      const removedIds = new Set(clashes.map((c) => c.userShiftId));
      existingByUser.set(user.id, existingByUser.get(user.id).filter((e) => !removedIds.has(e.userShiftId)));
    }
    if (!acceptedByUser.has(user.id)) acceptedByUser.set(user.id, []);
    acceptedByUser.get(user.id).push(interval);

    const entry = {
      key: item.key,
      userId: user.id,
      date,
      shiftId: result.shift.id,
      shiftName: result.shift.shiftName,
      startTime: target.startTime,
      endTime: target.endTime,
      userShiftId: result.userShift.id,
      _user: user,
    };
    if (clashes.length) {
      replaced.push({
        ...entry,
        removed: clashes.map((c) => ({
          userShiftId: c.userShiftId,
          shiftId: c.shiftId,
          shiftName: c.shiftName,
          date: c.date,
          startTime: c.startTime,
          endTime: c.endTime,
        })),
      });
    } else {
      created.push(entry);
    }
  }

  await sendImportNotifications({ companyId, actingUserId, created, replaced });

  const strip = ({ _user, ...rest }) => rest;
  return { created: created.map(strip), replaced: replaced.map(strip), skipped, failed };
}

// New assignments → SCHEDULE_ASSIGNED per employee and shift; replacements →
// SCHEDULE_REPLACED per removed assignment; management gets one summary per shift.
async function sendImportNotifications({ companyId, actingUserId, created, replaced }) {
  try {
    const byShift = new Map();
    for (const e of [...created, ...replaced]) {
      if (!byShift.has(e.shiftId)) byShift.set(e.shiftId, { entries: [], created: [] });
      byShift.get(e.shiftId).entries.push(e);
    }
    for (const e of created) byShift.get(e.shiftId).created.push(e);

    for (const [shiftId, group] of byShift) {
      const first = group.entries[0];
      const shift = {
        id: shiftId,
        shiftName: first.shiftName,
        startTime: hhmmToEpochDate(first.startTime),
        endTime: hhmmToEpochDate(first.endTime),
      };

      const datesByUser = new Map();
      for (const e of group.created) {
        if (!datesByUser.has(e.userId)) datesByUser.set(e.userId, { user: e._user, dates: [] });
        datesByUser.get(e.userId).dates.push(e.date);
      }
      await Promise.all(
        [...datesByUser.values()].map(({ user, dates }) =>
          notifyEmployeeShiftAssigned({
            user: { id: user.id, departmentId: user.departmentId },
            shift,
            dates,
            assignedBy: actingUserId,
            companyId,
          })
        )
      );

      await notifyManagementShiftAssignment({
        companyId,
        shift,
        assignedCount: group.entries.length,
        dates: [...new Set(group.entries.map((e) => e.date))].sort(),
        assignmentType: "bulk-import",
        assignedBy: actingUserId,
      });
    }

    await Promise.all(
      replaced.flatMap((e) =>
        e.removed.map((r) =>
          notifyEmployeeShiftReplaced({
            user: { id: e._user.id, departmentId: e._user.departmentId },
            oldShift: { id: r.shiftId, shiftName: r.shiftName },
            newShift: { id: e.shiftId, shiftName: e.shiftName },
            date: r.date,
            companyId,
          })
        )
      )
    );
  } catch (notifError) {
    console.error("❌ Failed to send schedule import notifications:", notifError);
  }
}

// ── Legacy (pre-BB-103) preview / confirm — the `rows` contract ─────────────
// Kept until the new client ships. Blank rows are now skipped instead of erroring,
// since the template is pre-filled.

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

function rowIdentifier(data) {
  return (data.employeeId && data.employeeId.trim()) || (data.email && data.email.trim().toLowerCase()) || null;
}

async function previewScheduleImport({ buffer, companyId, actingUserId, actingRole, overnight }) {
  const rows = parseScheduleCsv(buffer);

  if (rows.length > LEGACY_MAX_ROWS) {
    const err = new Error(`CSV has ${rows.length} rows; the limit is ${LEGACY_MAX_ROWS} per upload.`);
    err.isRowCapError = true;
    throw err;
  }

  const actor = await loadActor({ companyId, actingUserId, actingRole });
  const isScopedToTeam = actor.scoped;

  const identifiers = new Set();
  for (const { data } of rows) {
    if (data.employeeId) identifiers.add(data.employeeId.trim());
    if (data.email) identifiers.add(data.email.trim().toLowerCase());
  }

  const users = await prisma.user.findMany({
    where: {
      ...HUMAN_ONLY,
      companyId,
      AND: [teamWhere(actor), { OR: [{ employeeId: { in: [...identifiers] } }, { email: { in: [...identifiers] } }] }],
    },
    select: USER_SELECT,
  });
  const byEmployeeId = new Map();
  const byEmail = new Map();
  for (const u of users) {
    if (u.employeeId) byEmployeeId.set(u.employeeId.trim(), u);
    if (u.email) byEmail.set(u.email.trim().toLowerCase(), u);
  }

  const preview = [];
  const seenRangesByKey = new Map();

  for (const { rowNumber, data } of rows) {
    const identifier = rowIdentifier(data);
    const base = { row: rowNumber, employeeId: identifier, date: data.date || null };

    try {
      const ranges = mergeBlocksToTimeRanges(data, !!overnight);
      if (ranges.length === 0) continue; // blank row — no shift that day

      if (!identifier) throw new Error(`Missing ${IDENTIFIER_COLUMNS.join(" or ")}.`);
      if (!data.date) throw new Error("Missing date.");
      if (isNaN(new Date(data.date).getTime())) throw new Error(`Invalid date: "${data.date}".`);

      const user =
        (data.employeeId && byEmployeeId.get(data.employeeId.trim())) ||
        (data.email && byEmail.get(data.email.trim().toLowerCase()));
      if (!user) {
        throw new Error(
          isScopedToTeam ? "Employee not found in your team." : "Employee not found in this company."
        );
      }
      if (user.status !== "active") throw new Error("Employee is inactive.");

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

async function commitScheduleImport({ companyId, actingUserId, actingRole, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const err = new Error("No rows to import.");
    err.isRowCapError = true;
    throw err;
  }
  if (rows.length > LEGACY_MAX_ROWS) {
    const err = new Error(`Import has ${rows.length} rows; the limit is ${LEGACY_MAX_ROWS}.`);
    err.isRowCapError = true;
    throw err;
  }

  const actor = await loadActor({ companyId, actingUserId, actingRole });

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

  const userIds = [...new Set(candidates.map((r) => r.userId))];
  const users = await prisma.user.findMany({
    where: { ...HUMAN_ONLY, id: { in: userIds }, companyId, status: "active" },
    select: { id: true, departmentId: true, employeeId: true, email: true, employmentDetail: { select: { supervisorId: true } } },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const validated = [];
  for (const row of candidates) {
    const user = userById.get(row.userId);
    if (!user) {
      failed.push({ row: row.row, employeeId: row.employeeId, date: row.date, reason: "Employee not found in this company." });
      continue;
    }
    if (!inTeam(actor, user)) {
      failed.push({ row: row.row, employeeId: row.employeeId, date: row.date, reason: "Employee not found in your team." });
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

  const groups = new Map();
  for (const row of validated) {
    const key = `${timeRangeKey(row.startTime, row.endTime, row.crossesMidnight)}|${row.shiftName}`;
    if (!groups.has(key)) groups.set(key, { startTime: row.startTime, endTime: row.endTime, crossesMidnight: row.crossesMidnight, shiftName: row.shiftName, rows: [] });
    groups.get(key).rows.push(row);
  }

  const companyTimezone = await loadCompanyTimezone(companyId);

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

module.exports = {
  buildScheduleTemplate,
  previewSchedule,
  confirmSchedule,
  previewScheduleImport,
  commitScheduleImport,
  ScheduleImportError,
  MAX_ROWS,
  MAX_RANGE_DAYS,
};
