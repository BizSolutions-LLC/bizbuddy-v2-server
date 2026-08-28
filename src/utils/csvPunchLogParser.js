// src/utils/csvPunchLogParser.js
// Pure CSV parsing/shape validation for the punch-log bulk-import feature (BB-077).
// No Prisma calls here — row-level business validation happens in punchLogImportService.js.

const { parse } = require("csv-parse/sync");

const REQUIRED_COLUMNS = ["date", "clockIn", "clockOut"];
// At least one of these must be present as a column so a row can identify an employee.
const IDENTIFIER_COLUMNS = ["employeeId", "email"];
const KNOWN_COLUMNS = [...REQUIRED_COLUMNS, ...IDENTIFIER_COLUMNS, "punchType", "reason", "notes"];

class CsvShapeError extends Error {}

/**
 * Parses a CSV buffer into row objects and validates the header shape.
 * Throws CsvShapeError (caller should respond 400, no rows processed) if the header
 * is missing a required column or has no employee-identifier column at all.
 * Unknown extra columns are ignored rather than rejected, so a template with stray
 * spreadsheet columns doesn't hard-fail the whole upload.
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
  return records.map((data, i) => ({ rowNumber: i + 2, data }));
}

function buildTemplateCsv() {
  const exampleRow = {
    date: "2026-08-01",
    clockIn: "08:00",
    clockOut: "16:00",
    employeeId: "EMP-001",
    email: "jane.doe@example.com",
    punchType: "REGULAR",
    reason: "",
    notes: "Backfilled from paper timesheet",
  };
  const header = KNOWN_COLUMNS.join(",");
  const example = KNOWN_COLUMNS.map((c) => exampleRow[c]).join(",");
  return `${header}\n${example}\n`;
}

module.exports = { parsePunchLogCsv, buildTemplateCsv, CsvShapeError, KNOWN_COLUMNS };
