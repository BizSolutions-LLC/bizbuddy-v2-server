# Changelog — v2.10.40

> **BB-077** — admins/supervisors can now bulk-import historical punch logs from a CSV file
> instead of filing one manual request per punch. Ships with a downloadable template endpoint
> and per-row partial success reporting.

---

## Feature

### BB-077 — CSV Bulk Import of Historical Punch Logs

**Why:** Backfilling attendance history (e.g. onboarding a company with paper timesheets, or
correcting a bulk data gap) previously meant submitting and approving `RequestedTimeLog`s one at
a time through `requestPunchLogController.js`. For anything beyond a handful of records this
was impractical, so BB-077 adds a bulk path that reuses the exact same creation/validation logic
as the single-request flow rather than duplicating it.

**`csvPunchLogParser.js`** (new) — pure CSV parsing and header-shape validation, no DB access.
Requires `date`, `clockIn`, `clockOut` columns and at least one of `employeeId`/`email`; unknown
extra columns are ignored rather than rejected. Also builds the downloadable template CSV
(`buildTemplateCsv()`), whose example row is now built by mapping over the same `KNOWN_COLUMNS`
array used for the header, so the two can never drift out of alignment again.

**`punchLogImportService.js`** (new) — `importPunchLogsFromCsv()` resolves each row's employee
by `employeeId`/`email`, validates punch type (rejecting unrecognized values and — mirroring
`submitRequestPunchLog`'s existing rule — Driver/Aide types for BNC companies), handles
overnight-shift rollover, rejects in-file duplicate rows and rows overlapping an existing punch,
and rejects any row whose date falls inside a locked/processed cutoff period (via the new
`getLockedCutoffForDate()` in `timeLogController.js`, a date-based counterpart to the existing
`getLockedCutoffForLog()` for callers with no existing `TimeLog` to look up from). Capped at 300
rows per upload. A `supervisor` uploader is restricted to importing only their own department's
employees, matching the existing restriction on `viewAllRequestedPunchLogs`; `admin`/`superadmin`
remain company-wide. Row-level problems (bad data, employee not found/out of scope, conflicts,
locked period) are collected into `failed[]` rather than aborting the whole file — a bad row
doesn't block the good ones.

Each row's `date` cell is normalized to strict `YYYY-MM-DD` (`normalizeDateCell()`, accepting
`YYYY-MM-DD` and common `M/D/YY`/`M/D/YYYY` variants) before being combined with `clockIn`/
`clockOut` and handed to `parseClockTime()`. This was found necessary during manual testing: a
spreadsheet's `date` column format is a per-cell property, not a per-column one, so a file with
an ISO-formatted first row and the rest autofilled/dragged down (rendering as e.g. `8/3/26`) fed
`parseClockTime()` an ambiguous, non-ISO string on those later rows — its `moment.tz()` fallback
parser misinterpreted them, silently shifting the resulting clock-in/out time by several hours
while the date itself still looked correct. Normalizing the date cell up front removes the
ambiguity for every row regardless of how the source spreadsheet formatted it.

**`requestPunchLogController.js`** — extracted `createTimeLogFromRequest()` from
`approveRequestedPunchLog` so the single-approve and bulk-import paths create the resulting
`TimeLog` (and compute its derived hour fields) through one shared function instead of two
copies that could silently drift apart. Also exports `parseClockTime`/`findOverlappingLog` for
reuse by the import service.

**`punchLogImportController.js`** / **`punchLogImportRoutes.js`** (new) — `GET
/api/punch-log-import/template` (downloads the blank CSV template) and `POST
/api/punch-log-import/upload` (multipart upload, field name `file`, 5MB limit, restricted to a
`.csv` extension/mimetype), both gated to `admin`/`supervisor`/`superadmin`.

**Client-side impact:** two new endpoints the client repo needs UI for.
- `GET /api/punch-log-import/template` — a simple file download (template button).
- `POST /api/punch-log-import/upload` — multipart file upload, field name `file`, `.csv` only.
  Responds **HTTP 207** with:
  ```json
  {
    "message": "Import complete. 1 imported, 1 failed.",
    "data": {
      "created": [{
        "row": 2, "employeeId": "EMP-001",
        "date": "2026-08-01",
        "clockIn": "2026-08-01T08:00:00-04:00",
        "clockOut": "2026-08-01T16:00:00-04:00",
        "timeLogId": "...", "requestedTimeLogId": "..."
      }],
      "failed": [{
        "row": 7, "employeeId": "EMP-014",
        "date": "8/3/26", "clockIn": "08:00", "clockOut": "16:00",
        "reason": "Employee not found in this company."
      }]
    }
  }
  ```
  This is a partial-success response, not a plain success/error — the client needs a results
  view (e.g. a table) showing every row with an approved/failed status, using `date`/`clockIn`/
  `clockOut` to render the row without re-reading the original file. On `created` rows those
  three fields are the actual parsed/stored values (clock times formatted in the company's
  timezone with offset); on `failed` rows they're the raw CSV cell values as uploaded, since
  parsing may not have succeeded. A whole-file rejection (bad CSV shape, wrong file type, or over
  the 300-row cap) still comes back as a plain `400` before anything is written, with no `data`
  payload.

---

## Files Changed

| File | Change |
|---|---|
| `src/utils/csvPunchLogParser.js` | New — CSV shape parsing/validation, template builder |
| `src/services/Features/punchLogImportService.js` | New — row-level import business logic, department-scoped for supervisors |
| `src/controllers/Features/punchLogImportController.js` | New — template/upload route handlers |
| `src/routes/Features/punchLogImportRoutes.js` | New — routes, multer config with CSV-only `fileFilter` |
| `src/controllers/Features/requestPunchLogController.js` | Extracted `createTimeLogFromRequest()`; exported `parseClockTime`/`findOverlappingLog` |
| `src/controllers/Features/timeLogController.js` | New `getLockedCutoffForDate()` helper |
| `src/routes/index.js` | Registered `/punch-log-import` route |
| `package.json` | Added `csv-parse`, `multer` dependencies |
