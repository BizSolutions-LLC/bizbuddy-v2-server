// src/utils/csvPunchLogParser.js
// Pure CSV parsing/shape validation for the punch-log bulk-import feature (BB-077).
// No Prisma calls here — row-level business validation happens in punchLogImportService.js.

const { parse } = require("csv-parse/sync");

const REQUIRED_COLUMNS = ["date", "clockIn", "clockOut"];
// At least one of these must be present as a column so a row can identify an employee.
const IDENTIFIER_COLUMNS = ["employeeId", "email"];
const KNOWN_COLUMNS = [...REQUIRED_COLUMNS, ...IDENTIFIER_COLUMNS, "punchType", "reason", "notes"];

class CsvShapeError extends Error {}

// BB-108: template guide rows start with "#" in their first cell and are never imported.
// Matched on the marker rather than position, so sorting the sheet doesn't break it.
const GUIDE_MARKER = "# GUIDE - not imported";
const isGuideRow = (data) => String(Object.values(data)[0] ?? "").trim().startsWith("#");

const PUNCH_TYPE_HINT_BNC = "REGULAR or TRAINING (blank = REGULAR)";
const PUNCH_TYPE_HINT_ALL = "REGULAR | DRIVER_AIDE | DRIVER_AIDE_AM | DRIVER_AIDE_PM | TRAINING (blank = REGULAR)";
const TIME_HINT_IN = "08:00 or 8:00 AM";
const TIME_HINT_OUT = "17:00 or 5:00 PM";

/**
 * Parses a CSV buffer into row objects and validates the header shape.
 * Throws CsvShapeError (caller should respond 400, no rows processed) if the header
 * is missing a required column or has no employee-identifier column at all.
 * Unknown extra columns are ignored rather than rejected, so a template with stray
 * spreadsheet columns doesn't hard-fail the whole upload. Guide rows ("#" in the first
 * cell) are dropped; the rest keep their real line numbers.
 */
function parsePunchLogCsv(buffer) {
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
  const missingRequired = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missingRequired.length > 0) {
    throw new CsvShapeError(`CSV is missing required column(s): ${missingRequired.join(", ")}`);
  }
  if (!IDENTIFIER_COLUMNS.some((c) => columns.includes(c))) {
    throw new CsvShapeError(`CSV must include at least one of: ${IDENTIFIER_COLUMNS.join(", ")}`);
  }

  // rowNumber is 1-indexed counting the header as row 1, so the first data row is 2 —
  // matches the convention documented for the upload endpoint's failed[] entries.
  const rows = records.map((data, i) => ({ rowNumber: i + 2, data })).filter((r) => !isGuideRow(r.data));
  if (rows.length === 0) {
    throw new CsvShapeError("CSV file has no data rows.");
  }
  return rows;
}

function guideCells(isBnc) {
  return {
    clockIn: TIME_HINT_IN,
    clockOut: TIME_HINT_OUT,
    punchType: isBnc ? PUNCH_TYPE_HINT_BNC : PUNCH_TYPE_HINT_ALL,
    reason: "optional",
    notes: "optional",
  };
}

// The original blank template (no date range). Its first column is `date`, so the
// guide marker goes there; the guide row replaces the old example row, which got
// imported if it was left in.
function buildTemplateCsv({ isBnc = false } = {}) {
  const guide = {
    date: `${GUIDE_MARKER} (date: YYYY-MM-DD)`,
    employeeId: "",
    email: "",
    ...guideCells(isBnc),
  };
  const header = KNOWN_COLUMNS.join(",");
  const guideRow = KNOWN_COLUMNS.map((c) => csvCell(guide[c])).join(",");
  return `${header}\n${guideRow}\n`;
}

// BB-108: pre-filled template columns. `name` is for reading only — the parser
// ignores unknown columns and rows match on `email`.
const PREFILLED_COLUMNS = ["name", "email", "date", "clockIn", "clockOut", "punchType", "reason", "notes"];

function csvCell(value) {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Pre-filled template (BB-108): a guide row (never imported), then one row per
 * employee × date, employees in the order given (sorted by name), then date. Only
 * name/email/date are filled. Starts with a UTF-8 BOM so Excel keeps non-ASCII names intact.
 *   employees: [{ email, name }]   dates: ["YYYY-MM-DD", ...]   isBnc: punchType hint
 */
function buildPrefilledTemplateCsv({ employees, dates, isBnc = false }) {
  const blanks = PREFILLED_COLUMNS.slice(3).map(() => "");
  const guide = { name: GUIDE_MARKER, email: "", date: "YYYY-MM-DD", ...guideCells(isBnc) };
  const lines = [PREFILLED_COLUMNS.join(","), PREFILLED_COLUMNS.map((c) => csvCell(guide[c])).join(",")];
  for (const e of employees) {
    for (const date of dates) {
      lines.push([csvCell(e.name), csvCell(e.email), date, ...blanks].join(","));
    }
  }
  return "\uFEFF" + lines.join("\n") + "\n";
}

module.exports = { parsePunchLogCsv, buildTemplateCsv, buildPrefilledTemplateCsv, CsvShapeError, KNOWN_COLUMNS };
