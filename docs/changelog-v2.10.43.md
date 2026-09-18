# Changelog — v2.10.43

> **BB-087** — the yearly "TOTAL STAFF HOURS" Summary report — previously built by hand each year
> via a chain of VLOOKUPs across a copied-and-pasted spreadsheet — can now be generated on demand
> as a downloadable `.xlsx` file, with per-employee yearly and monthly Total/Driver/Regular/OT
> hour breakdowns.
>
> **BB-090** — investigated: excluded records in the Cutoff Review screen were a dead end with no
> way back. Root cause traced to the client UI, not the API — no server change needed.

---

## BB-087 — Summary for Yearly Total Hours Report

**Why:** Admins maintained a "TOTAL STAFF HOURS" workbook manually — copy the latest payroll-date
tab into a Master workbook each cutoff period, then VLOOKUP monthly totals into a Summary tab (see
`docs/Sample_Yearly_Total_Hours_Report.xlsx`, the reference sample this ticket was scoped against).
Scope was narrowed to the Summary tab only — not the full multi-tab workbook with per-payroll-date
detail, driver/aide split, training, or sick-leave columns.

**Data source:** the Cutoff-based `PayrollExport` table (per-employee, per-cutoff-period
aggregates already written by `payrollExportService.js` when a department marks a period
`processed` — BB-066), summed across all periods in the requested calendar year. A period is
bucketed into whichever calendar month its `periodEnd` falls in.

**`yearlyTotalHoursReportService.js`** (new) — `getYearlyTotalHoursSummary(companyId, year)`
groups `PayrollExport` rows by employee, computing yearly `totalHours` (regular + driver +
training + pto) and `otHours`, plus the same breakdown per calendar month —
including separate `driverHours` and `regularHours` per month, added after the initial build at
the user's request — and a `numberOfMonths` count (months with any nonzero hours), matching the
sample Summary tab's own column.

**`generateYearlyTotalHoursReportXlsx.js`** (new) — builds the "Summary" worksheet via `exceljs`
(new dependency — no Excel-writing library existed in the repo before this; only `pdfkit` for PDFs
and `csv-parse` for CSV import). Columns: `Name of Employee | TOTAL Hrs | OT Hrs`, then per month
`{Month} Total Hrs | {Month} Driver Total Hrs | {Month} Regular Total Hrs | {Month} OT Hrs`, then
`Number of Months`. Returns a `Buffer`, same convention as `generatePayslipPDF.js`/`generateCheckPDF.js`.

**`yearlyTotalHoursReportController.js`** (new) — `GET
/api/reports/yearly-total-hours/:companyId?year=YYYY`, streams the generated workbook back with
`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and a
`Content-Disposition: attachment` filename. Auth/company-scoping copied from the existing
`payrollExportController.js` pattern: admin/supervisor limited to their own `companyId` (`403`
otherwise), superadmin unrestricted.

**Client-side impact:**
- Brand-new endpoint, no prior contract — communicated directly to the client side (no contract
  doc kept in this repo for this one).
- Response is a **binary `.xlsx` file**, not the usual JSON envelope — the one thing flagged as
  needing different handling than most endpoints in this API.
- UI work needed: a download trigger + year picker. `/dashboard/company/punch-logs` was suggested
  as a reasonable home for it, but left as the client's call.

**Files Changed:**

| File | Change |
|---|---|
| `package.json` | Added `exceljs` dependency |
| `src/services/Reports/yearlyTotalHoursReportService.js` | New — yearly/monthly per-employee hours aggregation from `PayrollExport` |
| `src/utils/generateYearlyTotalHoursReportXlsx.js` | New — Summary worksheet generation via `exceljs` |
| `src/controllers/Reports/yearlyTotalHoursReportController.js` | New — report download route handler, company-scoped |
| `src/routes/Reports/yearlyTotalHoursReportRoutes.js` | New — route + auth wiring |
| `src/routes/index.js` | Registered `/reports` route |

---

## BB-090 — Add Re-Exclude Button in the Cutoff Periods Page

**Why:** once a time log record in the Cutoff Review screen was marked "Excluded," there was no
way to undo it — the row rendered a static "Excluded" badge with no action buttons at all. Flagged
as a recurring pain point for staff who excluded something by mistake or changed their mind.

**Investigation finding: no server-side change needed.** `resetApproval()`
(`cutoffPeriodController.js:1854`, `PATCH /api/cutoff-periods/:id/approvals/:approvalId/reset`)
already accepts both `approved` **and** `excluded` as valid source statuses — the API has
supported resetting an excluded record back to `pending` since it was written. The gap was
client-only: `CutoffReview.jsx` (`TimelineRow`, `PunchSubRow`, `DriverSegmentRow`) only rendered
the Reset button when status was `approved`, never `excluded`, even though `onReset` was already
threaded through all three components. Once reset to `pending`, the existing `Exclude` action
(already wired) re-excludes it — same flow that already works for approved rows.

**Confirmed during testing:** a `400` hit while testing the reset endpoint directly was expected
behavior, not a bug — `resetApproval()` only returns `400` when the cutoff period is
`locked`/`processed`, or when the targeted approval isn't currently `approved`/`excluded`. No fix
required there.

**No files changed in this repo** — scoped entirely to `bizbuddy-v2-client-web`
(`CutoffReview.jsx`), which is being handled directly with the client side rather than implemented
from here.
