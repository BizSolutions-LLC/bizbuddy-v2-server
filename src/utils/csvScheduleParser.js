// src/utils/csvScheduleParser.js
// Pure CSV parsing/shape validation + block-merge logic for the schedule bulk-import
// feature (BB-081). No Prisma calls here — row-level business validation (employee
// resolution, conflict checks) happens in scheduleImportService.js.
//
// Each data row is one employee for one date. Instead of explicit startTime/endTime
// columns, the row carries one column per 30-minute block of the day (01:00 through
// 23:30 — 46 columns) that the uploader marks for every block the employee is
// scheduled. mergeBlocksToTimeRanges() collapses the marked blocks into one or more
// startTime/endTime spans — a row with gapped marks (e.g. a split shift) yields
// multiple spans.

const { parse } = require("csv-parse/sync");

const IDENTIFIER_COLUMNS = ["employeeId", "email"];
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

const KNOWN_COLUMNS = [...IDENTIFIER_COLUMNS, DATE_COLUMN, ...BLOCK_COLUMNS];

const TRUTHY_MARKS = new Set(["1", "x", "yes", "true"]);

function isBlockMarked(raw) {
  if (raw === undefined || raw === null) return false;
  return TRUTHY_MARKS.has(String(raw).trim().toLowerCase());
}

class CsvShapeError extends Error {}

/**
 * Parses a schedule CSV buffer into row objects and validates the header shape.
 * Throws CsvShapeError (caller should respond 400, nothing processed) if the header
 * is missing the date column, has no employee-identifier column, or is missing any of
 * the 46 time-block columns — the merge logic needs every column present to tell
 * "unmarked" apart from "column doesn't exist in this file".
 */
function parseScheduleCsv(buffer) {
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
 * Throws a plain Error (row-level, caught by the caller) when no blocks are marked.
 */
function mergeBlocksToTimeRanges(row, overnight) {
  const markedIndices = [];
  for (let i = 0; i < BLOCK_COUNT; i++) {
    if (isBlockMarked(row[BLOCK_COLUMNS[i]])) markedIndices.push(i);
  }

  if (markedIndices.length === 0) {
    throw new Error("No time blocks marked.");
  }

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

/**
 * Builds the downloadable CSV template for a given week. `overnight` only affects the
 * explanatory example row's shape (which blocks are pre-filled to illustrate wrapping);
 * the column set itself (identifier + date + all 46 blocks) is always the same.
 */
function buildTemplateCsv({ weekStart, overnight = false } = {}) {
  const header = KNOWN_COLUMNS.join(",");
  const start = weekStart ? new Date(`${weekStart}T00:00:00Z`) : new Date();

  const rows = [header];
  for (let d = 0; d < 7; d++) {
    const date = new Date(start.getTime() + d * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().slice(0, 10);
    const isExampleRow = d === 0;

    const cells = KNOWN_COLUMNS.map((col) => {
      if (col === "employeeId") return isExampleRow ? "EMP-001" : "";
      if (col === "email") return isExampleRow ? "jane.doe@example.com" : "";
      if (col === DATE_COLUMN) return dateStr;
      // Example row: mark a plain 08:00-17:00 day (or an overnight-style
      // 22:00-24:00 + 01:00-02:00 wrap when the overnight param is set) to
      // illustrate the expected marking convention.
      if (!isExampleRow) return "";
      if (overnight) {
        return ["22:00", "22:30", "23:00", "23:30", "01:00", "01:30"].includes(col) ? "1" : "";
      }
      const [h] = col.split(":").map(Number);
      return h >= 8 && h < 17 ? "1" : "";
    });
    rows.push(cells.join(","));
  }

  return rows.join("\n") + "\n";
}

module.exports = {
  parseScheduleCsv,
  buildTemplateCsv,
  mergeBlocksToTimeRanges,
  CsvShapeError,
  KNOWN_COLUMNS,
  BLOCK_COLUMNS,
  IDENTIFIER_COLUMNS,
  DATE_COLUMN,
};
