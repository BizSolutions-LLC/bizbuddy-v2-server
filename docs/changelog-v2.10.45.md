# Changelog — v2.10.45

> **BB-087 (follow-up)** — the Yearly Total Hours report (first shipped in v2.10.43) now accepts
> download options: group by **Monthly / Quarterly / Yearly**, pick which months or quarters to
> include, and optionally add **Driver / Regular / OT / Average-per-cutoff** columns. Employee names
> are now formatted **"LastName, FirstName"**. The rule for which month a cutoff belongs to is now
> written down: the month its last day falls in.

---

## BB-087 — Yearly Total Hours Report: grouping, period selection, optional columns

**Why:** the v2.10.43 report always produced 12 monthly groups with every column. Admins need a
modal to choose monthly, quarterly or whole-year output, limit it to specific months or quarters, and
choose which breakdown columns appear. Names also need to match the payroll sheets' "Last, First"
format.

### Month rule: a cutoff counts in the month its last day falls in

Each cutoff period is bucketed **whole** into the calendar month of its `periodEnd`, the last day
of the cutoff. Days are never split by calendar month or year.

- Jun 10–23 → **June**
- Jun 24–Jul 7 → **July**
- Quarters derive from that same month (e.g. Mar 25–Apr 7 → April → **Q2**).
- Yearly = every cutoff whose `periodEnd` falls in the year, so Dec 24–Jan 6 counts toward the
  **following** year.

Bucketing by release/payment date (`CutoffPeriod.paymentDate`) was tried during review and
reverted. The cutoff end date is the confirmed rule.

### What's counted (unchanged, confirmed)

Only **approved** data is included, because the report reads `PayrollExport`, which is written when a
department marks a cutoff **processed** (`cutoffPeriodController.js`):
- time logs with an `approved` approval, `approved` OT blocks, and paid leave days from `approved` leaves;
- pending / excluded / rejected records are left out;
- cutoffs that are still `open` or `locked` (not yet processed) don't appear at all;
- the data is saved at the moment the cutoff is processed. Changes after that appear only when the
  cutoff is processed again.

### `yearlyTotalHoursReportService.js`

`getYearlyTotalHoursSummary(companyId, year, { groupBy, periods })`
- `groupBy`: `month` (`Jan`..`Dec`), `quarter` (`Q1`..`Q4`) or `year` (single `Year` key).
- `periods`: which months or quarters to include (default all). Ignored for `year`.
- Per period: `totalHours` (regular + driver + training + pto), `driverHours`, `regularHours`,
  `otHours`, `cutoffCount` (distinct cutoffs for that employee; one cutoff counts once even when
  it has rows under two departments), and `averageHours` = `totalHours ÷ cutoffCount`.
- Yearly `totalHours` / `otHours` cover **only the included periods**, so picking only Q1 gives
  Q1 totals.
- `numberOfPeriods`: included months or quarters with any hours. For `year`, it's the number of months
  with any hours, by `periodEnd` month.
- Names come from `UserProfile` as **"LastName, FirstName"**, falling back to
  `PayrollExport.employeeName`, and are sorted by that. There's no middle-name field in the schema, so
  the middle initial ("LastName, FirstName M.") is deferred to a separate ticket.

### `generateYearlyTotalHoursReportXlsx.js`

- **Monthly / Quarterly:** `Name | TOTAL Hrs | OT Hrs`, then per included period
  `{Period} Total Hrs` plus any requested `{Period} Driver Total Hrs` / `Regular Total Hrs` /
  `OT Hrs` / `Avg Hrs per Cutoff`, then `Number of Months` / `Number of Quarters`.
- **Yearly (compact):** `Name | TOTAL Hrs | OT Hrs`, then any requested `Driver Total Hrs` /
  `Regular Total Hrs` / `Avg Hrs per Cutoff`, then `Number of Months`. There's no per-period Total
  group, and `ot` is ignored, because both would repeat the fixed TOTAL/OT columns.
- Title row shows the grouping, e.g. `TOTAL STAFF HOURS - 2026 (Quarterly: Q1, Q3)` or
  `TOTAL STAFF HOURS - 2026 (Yearly)`.

### `yearlyTotalHoursReportController.js` / `yearlyTotalHoursReportRoutes.js`

Parses and validates the new query params. Invalid values return `400` JSON `{ message }`. Auth and
company-scoping are unchanged.

### API contract — `GET /api/reports/yearly-total-hours/:companyId`

| Param | Values | Default |
|---|---|---|
| `year` | e.g. `2026` | current year |
| `groupBy` | `month` \| `quarter` \| `year` | `month` |
| `periods` | comma list: `Jan,Feb,...` (month) or `Q1,Q2,...` (quarter). Case-sensitive, ignored for `year` | all for the grouping |
| `columns` | comma list of `driver,regular,ot,average`. `ot` is ignored for `year` | none (Total only) |

Examples:
```
?year=2026&groupBy=month&periods=Jan,Feb,Mar&columns=driver,regular,ot
?year=2026&groupBy=quarter&periods=Q1,Q3&columns=average
?year=2026&groupBy=year&columns=driver,regular,average
```

**Client-side impact:**
- **Behavior change from v2.10.43:** with no params, the file now has monthly **Total only**.
  Before, it had Total/Driver/Regular/OT per month. The client should send `columns` to get the
  breakdowns.
- Response is still a binary `.xlsx` file. Errors stay JSON, so with `responseType: 'blob'` the
  error message has to be read from the blob.
- UI: a download modal with a year picker, a Monthly/Quarterly/Yearly radio, month (Jan–Dec) or quarter
  (Q1–Q4) checkboxes (all checked by default, hidden for Yearly), and optional Driver / Regular / OT /
  Average checkboxes (off by default, OT hidden for Yearly). The full client handoff text was shared
  with the client side directly.

**Files Changed:**

| File | Change |
|---|---|
| `src/services/Reports/yearlyTotalHoursReportService.js` | Month/quarter/year grouping, period filter, per-cutoff average, "LastName, FirstName" names |
| `src/utils/generateYearlyTotalHoursReportXlsx.js` | Dynamic columns per grouping and selected options; compact Yearly layout |
| `src/controllers/Reports/yearlyTotalHoursReportController.js` | Parse and validate `groupBy` / `periods` / `columns` |
| `src/routes/Reports/yearlyTotalHoursReportRoutes.js` | Route doc comment updated with the new params |
