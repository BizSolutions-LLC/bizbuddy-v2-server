// src/utils/csvScheduleParser.js
// Pure CSV parsing/shape validation + block-merge logic for the schedule bulk-import
// feature (BB-081, reworked in BB-103). No Prisma calls here — row-level business
// validation (employee resolution, conflict checks) happens in scheduleImportService.js.
//
// Each data row is one employee for one date. Two marking modes (BB-103):
//   - time_blocks: one column per 30-minute block of the day (01:00 through 23:30 —
//     46 columns). mergeBlocksToTimeRanges() collapses the marked blocks into one or
//     more startTime/endTime spans — a row with gapped marks (e.g. a split shift)
//     yields multiple spans.
//   - shifts: one column per existing company Shift the admin picked (the "pool").
//     A mark under a column assigns that Shift on the row's date. Headers are built
//     by shiftColumnHeaders() and must come back unchanged.

const { parse } = require("csv-parse/sync");
const moment = require("moment-timezone");

const IDENTIFIER_COLUMNS = ["employeeId", "email"]; // either is accepted on upload
const TEMPLATE_IDENTIFIER = "email"; // BB-103 templates identify employees by email
const NAME_COLUMN = "name";
const DATE_COLUMN = "date";

// Block index 0 = "01:00"-"01:30", ... index 45 = "23:30"-"24:00". The grid starts at
// 01:00 (not 00:00) and ends at 24:00/midnight, per the confirmed design.
const BLOCK_COUNT = 46;
const BLOCK_START_HOUR = 1;

function blockLabel(index) {
  const totalMinutes = BLOCK_START_HOUR * 60 + index * 30;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const BLOCK_COLUMNS = Array.from({ length: BLOCK_COUNT }, (_, i) => blockLabel(i));

// Legacy (pre-BB-103) template columns.
const KNOWN_COLUMNS = [...IDENTIFIER_COLUMNS, DATE_COLUMN, ...BLOCK_COLUMNS];

const TRUTHY_MARKS = new Set(["1", "x", "yes", "true"]);
const FALSY_MARKS = new Set(["", "0", "no", "false"]);

function isBlockMarked(raw) {
  if (raw === undefined || raw === null) return false;
  return TRUTHY_MARKS.has(String(raw).trim().toLowerCase());
}

// Strict mark reading for shift columns: true / false, or null for a value we don't
// recognise (a row error, so a typo isn't silently read as "not scheduled").
function readMark(raw) {
  const v = raw === undefined || raw === null ? "" : String(raw).trim().toLowerCase();
  if (TRUTHY_MARKS.has(v)) return true;
  if (FALSY_MARKS.has(v)) return false;
  return null;
}

class CsvShapeError extends Error {}

// Dates in a pre-filled template are often re-saved by Excel as M/D/YYYY, so both
// forms are accepted. Returns "YYYY-MM-DD" or null.
function normalizeDate(raw) {
  if (!raw) return null;
  const m = moment.utc(String(raw).trim(), ["YYYY-MM-DD", "M/D/YYYY", "MM/DD/YYYY"], true);
  return m.isValid() ? m.format("YYYY-MM-DD") : null;
}

// "10:00 AM" style label of a Time column (stored as 1970-01-01Thh:mm UTC).
function timeLabel(date) {
  const d = new Date(date);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// One header per pool shift, in pool order: "Morning (10:00 AM - 5:00 PM)". Names can
// repeat (older imports created duplicates), so a repeated header gets " #2", " #3".
// Plain ASCII on purpose — Excel mangles an en dash in a CSV opened without a BOM.
function shiftColumnHeaders(shifts) {
  const seen = new Map();
  return shifts.map((s) => {
    const base = `${s.shiftName.trim()} (${timeLabel(s.startTime)} - ${timeLabel(s.endTime)})`;
    const n = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} #${n}`;
  });
}

const normalizeHeader = (h) => String(h).replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Parses a schedule CSV buffer into row objects and validates the header shape.
 * Throws CsvShapeError (caller should respond 400, nothing processed) if the header
 * is missing the date column or an employee-identifier column, or doesn't carry the
 * marking columns for `mode`:
 *   - time_blocks: all 46 block columns — the merge logic needs every column present
 *     to tell "unmarked" apart from "column doesn't exist in this file".
 *   - shifts: exactly the `shiftHeaders` columns; a missing, renamed or extra column
 *     means the template is out of date.
 * For shifts mode each row also gets `marks`: one true/false/null per shift header.
 */
function parseScheduleCsv(buffer, { mode = "time_blocks", shiftHeaders = [] } = {}) {
  let records;
  try {
    records = parse(buffer, {
      columns: true,
      trim: true,
      skip_empty_lines: true,
      bom: true,
    });
  } catch (err) {
    throw new CsvShapeError(`Could not parse CSV file: ${err.message}`);
  }

  if (records.length === 0) {
    throw new CsvShapeError("CSV file has no data rows.");
  }

  const columns = Object.keys(records[0]);
  if (!columns.includes(DATE_COLUMN)) {
    throw new CsvShapeError(`CSV is missing required column: ${DATE_COLUMN}`);
  }
  if (!IDENTIFIER_COLUMNS.some((c) => columns.includes(c))) {
    throw new CsvShapeError(`CSV must include at least one of: ${IDENTIFIER_COLUMNS.join(", ")}`);
  }

  if (mode === "shifts") {
    const fixed = new Set([...IDENTIFIER_COLUMNS, NAME_COLUMN, DATE_COLUMN]);
    const byNormalized = new Map(columns.filter((c) => !fixed.has(c)).map((c) => [normalizeHeader(c), c]));
    const missing = shiftHeaders.filter((h) => !byNormalized.has(normalizeHeader(h)));
    const expected = new Set(shiftHeaders.map(normalizeHeader));
    const unknown = [...byNormalized.keys()].filter((h) => !expected.has(h)).map((h) => byNormalized.get(h));
    if (missing.length || unknown.length) {
      const parts = [];
      if (missing.length) parts.push(`missing shift column(s): ${missing.join(", ")}`);
      if (unknown.length) parts.push(`unknown column(s): ${unknown.join(", ")}`);
      throw new CsvShapeError(
        `The shift columns don't match the shifts you picked (${parts.join("; ")}). The template is out of date — download it again.`
      );
    }
    const sourceColumns = shiftHeaders.map((h) => byNormalized.get(normalizeHeader(h)));
    return records.map((data, i) => ({
      rowNumber: i + 2,
      data,
      marks: sourceColumns.map((c) => readMark(data[c])),
    }));
  }

  const missingBlocks = BLOCK_COLUMNS.filter((c) => !columns.includes(c));
  if (missingBlocks.length > 0) {
    throw new CsvShapeError(
      `CSV is missing required time-block column(s): ${missingBlocks.join(", ")}. Use the downloaded template.`
    );
  }

  // rowNumber is 1-indexed counting the header as row 1, so the first data row is 2 —
  // same convention as the punch-log importer's failed[] entries.
  return records.map((data, i) => ({ rowNumber: i + 2, data }));
}

// Converts one contiguous run of block indices into a { startTime, endTime,
// crossesMidnight } span (both HH:MM strings).
function runToRange(startIdx, endIdx) {
  const startTime = blockLabel(startIdx);
  // The block's own end, not its label (which is its start) — wraps 23:30's block to "00:00".
  const endTotalMinutes = BLOCK_START_HOUR * 60 + (endIdx + 1) * 30;
  const endHour = Math.floor(endTotalMinutes / 60) % 24;
  const endMinute = endTotalMinutes % 60;
  const endTime = `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;

  const startMinutesOfDay = BLOCK_START_HOUR * 60 + startIdx * 30;
  const endMinutesOfDay = endTotalMinutes % (24 * 60);
  const crossesMidnight = startMinutesOfDay > endMinutesOfDay;

  return { startTime, endTime, crossesMidnight };
}

/**
 * Collapses one row's marked time-block cells into one or more { startTime, endTime,
 * crossesMidnight } spans (both HH:MM strings), one per contiguous run of marked
 * blocks — so a row with gaps (e.g. a lunch-break split shift) yields multiple ranges,
 * each becoming its own proposed shift. Ranges are returned in chronological order.
 * When `overnight` is true, a run touching the very last block (23:30) and a run
 * touching the very first block (01:00) are merged into one wrapped overnight span
 * first — the untracked 00:00-01:00 hour between them is assumed to be part of the
 * shift — before the remaining runs are converted individually.
 * Returns [] when no blocks are marked (a blank row — "no shift that day").
 */
function mergeBlocksToTimeRanges(row, overnight) {
  const markedIndices = [];
  for (let i = 0; i < BLOCK_COUNT; i++) {
    if (isBlockMarked(row[BLOCK_COLUMNS[i]])) markedIndices.push(i);
  }

  if (markedIndices.length === 0) return [];

  const runs = [];
  let runStart = markedIndices[0];
  let prev = markedIndices[0];
  for (let k = 1; k < markedIndices.length; k++) {
    const idx = markedIndices[k];
    if (idx === prev + 1) {
      prev = idx;
    } else {
      runs.push([runStart, prev]);
      runStart = idx;
      prev = idx;
    }
  }
  runs.push([runStart, prev]);

  // Merge the overnight wrap-around pair (last block's run + first block's run) into
  // one span, if present, before converting whatever runs remain.
  if (overnight && runs.length >= 2 && runs[0][0] === 0 && runs[runs.length - 1][1] === BLOCK_COUNT - 1) {
    const earlyRun = runs.shift();
    const lateRun = runs.pop();
    runs.push([lateRun[0], earlyRun[1]]);
  }

  return runs.map(([startIdx, endIdx]) => runToRange(startIdx, endIdx)).sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
}

function csvCell(value) {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Builds the pre-filled CSV template (BB-103): one row per employee × date, sorted by
 * employee (the caller passes them sorted) then date, with every marking cell blank.
 *   employees: [{ email, name }] — rows match on email; name is for reading only
 *   dates:     ["YYYY-MM-DD", ...]
 *   mode:      "time_blocks" → the 46 block columns; "shifts" → `shiftHeaders`
 * Starts with a UTF-8 BOM so Excel keeps non-ASCII names intact.
 */
function buildTemplateCsv({ mode, employees, dates, shiftHeaders = [] }) {
  const markColumns = mode === "shifts" ? shiftHeaders : BLOCK_COLUMNS;
  const header = [TEMPLATE_IDENTIFIER, NAME_COLUMN, DATE_COLUMN, ...markColumns].map(csvCell).join(",");
  const blanks = markColumns.map(() => "");

  const lines = [header];
  for (const e of employees) {
    for (const date of dates) {
      lines.push([csvCell(e.email), csvCell(e.name), date, ...blanks].join(","));
    }
  }
  return "﻿" + lines.join("\n") + "\n";
}

module.exports = {
  parseScheduleCsv,
  buildTemplateCsv,
  mergeBlocksToTimeRanges,
  shiftColumnHeaders,
  normalizeDate,
  CsvShapeError,
  KNOWN_COLUMNS,
  BLOCK_COLUMNS,
  IDENTIFIER_COLUMNS,
  DATE_COLUMN,
};
