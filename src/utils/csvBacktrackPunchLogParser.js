// src/utils/csvBacktrackPunchLogParser.js
// Pure CSV parsing for the "backtrack" historical punch-log import (BB-086).
// No Prisma calls here — employee resolution and business validation happen
// in backtrackImportService.js.
//
// Unlike the flat punch-log importer (csvPunchLogParser.js, BB-077), the source
// file here is a legacy "PadPro" payroll-summary export: a wide grid, one row
// per employee, with hour TOTALS per day-of-month split into three column
// groups — "Day Program Hours" (regular), "D/A Hours AM" (driver_am), and
// "D/A Hours PM" (driver_pm) — plus trailing summary columns (TR/SL/D/A Hours/
// HOURS/OT) that this parser does not interpret (informational-only in the
// preview; the per-group "Hours" subtotal is used only as a cross-check).
//
// There are no raw clock-in/clock-out timestamps anywhere in this format —
// only pre-aggregated hour totals per employee per day per segment.

const { parse } = require("csv-parse/sync");

class CsvShapeError extends Error {}

const GROUP_LABELS = [
  { key: "regular", label: "day program hours" },
  { key: "driverAm", label: "d/a hours am" },
  { key: "driverPm", label: "d/a hours pm" },
];

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function cell(row, col) {
  return (row[col] ?? "").toString().trim();
}

function findPeriodRow(rows) {
  const re = /date:\s*([a-z]+)\s+(\d{1,2})\s+to\s+(\d{1,2}),?\s*(\d{4})/i;
  for (let i = 0; i < rows.length; i++) {
    const joined = rows[i].join(" ");
    const match = joined.match(re);
    if (match) {
      const monthIndex = MONTH_NAMES.indexOf(match[1].toLowerCase());
      if (monthIndex === -1) continue;
      return {
        rowIndex: i,
        month: monthIndex + 1,
        startDay: parseInt(match[2], 10),
        endDay: parseInt(match[3], 10),
        year: parseInt(match[4], 10),
        label: joined.trim(),
      };
    }
  }
  return null;
}

function findGroupHeaderRow(rows, fromIndex) {
  for (let i = fromIndex; i < rows.length; i++) {
    const cells = rows[i].map((c) => (c ?? "").toString().trim().toLowerCase());
    if (cells.some((c) => c === "no." || c === "no") && cells.some((c) => c.includes("name of employee"))) {
      return i;
    }
  }
  return -1;
}

// From the group-header row, finds the starting column of each of the three
// segment groups by exact (case-insensitive) label match.
function locateGroupStartColumns(groupHeaderRow) {
  const starts = {};
  for (let col = 0; col < groupHeaderRow.length; col++) {
    const value = cell(groupHeaderRow, col).toLowerCase();
    const group = GROUP_LABELS.find((g) => g.label === value);
    if (group) starts[group.key] = col;
  }
  return starts;
}

// From the day-number sub-header row, collects the consecutive day-of-month
// columns starting at `startCol`, stopping at the group's "Hours" subtotal
// column. Does not assume a fixed column count per group.
function collectGroupDayColumns(dayNumberRow, startCol) {
  const days = [];
  let col = startCol;
  while (col < dayNumberRow.length) {
    const value = cell(dayNumberRow, col);
    if (/^hours$/i.test(value)) {
      return { days, subtotalCol: col };
    }
    const dayOfMonth = parseInt(value, 10);
    if (!Number.isInteger(dayOfMonth) || String(dayOfMonth) !== value) {
      throw new CsvShapeError(
        `Expected a day-of-month number or "Hours" at column ${col + 1} of the sub-header row, got "${value}".`
      );
    }
    days.push({ col, dayOfMonth });
    col++;
  }
  throw new CsvShapeError("Sub-header row ended before a group's \"Hours\" subtotal column was found.");
}

// Converts the shared day-of-month sequence (identical across all three
// groups) into real ISO dates, rolling over into the next month whenever a
// day-of-month value is smaller than the one before it (e.g. a period
// spanning Dec 29 – Jan 4).
function resolveDates(dayOfMonthList, period) {
  let month = period.month;
  let year = period.year;
  let prev = null;
  return dayOfMonthList.map((dayOfMonth) => {
    if (prev !== null && dayOfMonth < prev) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    prev = dayOfMonth;
    const mm = String(month).padStart(2, "0");
    const dd = String(dayOfMonth).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  });
}

// Normalizes a single day cell. Day cells are either blank (no data), a
// decimal hour value, or a leave code (e.g. " SL "). Unlike the group
// "Hours" subtotal column, individual day cells never use the "-" zero
// placeholder in this export format.
function normalizeDayCell(raw) {
  const trimmed = (raw ?? "").toString().trim();
  if (trimmed === "") return { value: null, leaveCode: null };
  const num = Number(trimmed);
  if (!Number.isNaN(num)) return { value: num, leaveCode: null };
  return { value: null, leaveCode: trimmed };
}

// Normalizes a group's "Hours" subtotal cell for the cross-check — here the
// "-" placeholder legitimately means zero (used when the whole group is
// blank for that employee/period).
function normalizeSubtotalCell(raw) {
  const trimmed = (raw ?? "").toString().trim();
  if (trimmed === "") return null;
  if (/^-+$/.test(trimmed)) return 0;
  const num = Number(trimmed);
  return Number.isNaN(num) ? null : num;
}

/**
 * Parses a "PadPro" backtrack punch-log CSV buffer.
 * Throws CsvShapeError for whole-file structural problems (missing period
 * label, missing/malformed header block). Row-level oddities (a mismatched
 * subtotal, an unrecognized leave code) are collected as warnings on the row
 * rather than failing the file.
 *
 * Returns { period: { year, month, startDay, endDay, label }, rows: [...] }
 * where each row is:
 *   { rowNumber, no, rawName, type,
 *     days: { "YYYY-MM-DD": { regular, driverAm, driverPm } },
 *     warnings: string[] }
 * and each segment cell is { value: number|null, leaveCode: string|null }.
 */
function parseBacktrackPunchLogCsv(buffer) {
  let rawRows;
  try {
    rawRows = parse(buffer, {
      columns: false,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
    });
  } catch (err) {
    throw new CsvShapeError(`Could not parse CSV file: ${err.message}`);
  }

  const periodRow = findPeriodRow(rawRows);
  if (!periodRow) {
    throw new CsvShapeError(
      'Could not find a period label row (expected something like "Date: January 7 to 20, 2026").'
    );
  }

  const groupHeaderRowIndex = findGroupHeaderRow(rawRows, periodRow.rowIndex + 1);
  if (groupHeaderRowIndex === -1) {
    throw new CsvShapeError('Could not find the header row (expected "No." / "Name of Employee" columns).');
  }
  const groupHeaderRow = rawRows[groupHeaderRowIndex];
  const dayNumberRow = rawRows[groupHeaderRowIndex + 1];
  if (!dayNumberRow) {
    throw new CsvShapeError("CSV ended right after the header row — no day-of-month sub-header found.");
  }

  const groupStarts = locateGroupStartColumns(groupHeaderRow);
  for (const g of GROUP_LABELS) {
    if (groupStarts[g.key] === undefined) {
      throw new CsvShapeError(`Could not find the "${g.label}" column group in the header row.`);
    }
  }

  const groups = {};
  for (const g of GROUP_LABELS) {
    const { days, subtotalCol } = collectGroupDayColumns(dayNumberRow, groupStarts[g.key]);
    groups[g.key] = { days, subtotalCol };
  }

  // All three groups must share the same day-of-month sequence — they're the
  // same working days viewed through three different hour buckets.
  const dayLists = GROUP_LABELS.map((g) => groups[g.key].days.map((d) => d.dayOfMonth).join(","));
  if (new Set(dayLists).size > 1) {
    throw new CsvShapeError("The three segment groups don't share the same day-of-month columns.");
  }
  const dates = resolveDates(groups.regular.days.map((d) => d.dayOfMonth), periodRow);

  const noColIndex = groupHeaderRow.findIndex((c) => /^no\.?$/i.test((c ?? "").toString().trim()));
  const nameColIndex = groupHeaderRow.findIndex((c) => /name of employee/i.test((c ?? "").toString().trim()));
  const typeColIndex = groupHeaderRow.findIndex((c) => /^type$/i.test((c ?? "").toString().trim()));

  const rows = [];
  for (let i = groupHeaderRowIndex + 2; i < rawRows.length; i++) {
    const raw = rawRows[i];
    const name = cell(raw, nameColIndex === -1 ? 1 : nameColIndex);
    if (!name) continue; // blank filler row (trailing footer rows, etc.)
    if (/^total/i.test(name)) break; // TOTALS row — end of data

    const warnings = [];
    const days = {};
    for (const g of GROUP_LABELS) {
      const group = groups[g.key];
      let sum = 0;
      let anyNumeric = false;
      group.days.forEach(({ col }, idx) => {
        const normalized = normalizeDayCell(raw[col]);
        const date = dates[idx];
        days[date] = days[date] || {};
        days[date][g.key] = normalized;
        if (normalized.value != null) {
          sum += normalized.value;
          anyNumeric = true;
        }
      });

      const subtotal = normalizeSubtotalCell(raw[group.subtotalCol]);
      if (subtotal != null && anyNumeric && Math.abs(subtotal - sum) > 0.01) {
        warnings.push(
          `${g.key} subtotal (${subtotal}) doesn't match the sum of its daily cells (${sum.toFixed(2)}).`
        );
      }
    }

    rows.push({
      rowNumber: i + 1,
      no: cell(raw, noColIndex === -1 ? 0 : noColIndex),
      rawName: name,
      type: cell(raw, typeColIndex === -1 ? 2 : typeColIndex),
      days,
      warnings,
    });
  }

  if (rows.length === 0) {
    throw new CsvShapeError("CSV has no employee data rows.");
  }

  return {
    period: {
      year: periodRow.year,
      month: periodRow.month,
      startDay: periodRow.startDay,
      endDay: periodRow.endDay,
      label: periodRow.label,
    },
    rows,
  };
}

module.exports = { parseBacktrackPunchLogCsv, CsvShapeError };
