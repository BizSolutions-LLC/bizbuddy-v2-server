# Changelog — v2.10.32

> **BB-066 (follow-up)** — `PayrollExport`/`PayrollExportBatch` are now modeled in `schema.prisma`
> (previously raw-SQL-only), and `GET /api/cutoff-periods` gained a per-period
> `payrollExport: { generated, employeeCount, generatedAt }` field so the client's new Payroll
> Report Preview can show generated-vs-not without an N+1 call per row. Along the way, discovered
> that `generatePayrollExportForCutoffPeriod` can only ever fire once per department-period (no
> re-trigger path exists for an already-`"processed"` period) — which explained why two Piedmont
> Adult Day Program periods, marked `"processed"` before this feature's trigger existed yet, had
> real approved punch/OT/leave data but no export. Both backfilled; one open question remains on
> a third department-period that was processed *after* the trigger existed and still got nothing.

---

## Schema

### BB-066 (follow-up) — Model `PayrollExport` / `PayrollExportBatch` in `schema.prisma`

**Why:** these two tables (`scripts/create-payroll-archive-tables.sql` +
`scripts/add-payroll-export-department-and-batch-unique.sql`) were deliberately raw-SQL-only per
the original BB-066 design (`docs/changelog-v2.10.31.md`). Modeling them closes that gap ahead of
further payroll-export work (the client's download UI, this entry's list enrichment).

**Added**, placed after `CutoffOtBlock` in `schema.prisma`:
- `id BigInt @default(autoincrement())` on both — not the `cuid()` `String` convention used
  everywhere else in this file, because the live columns are `BIGSERIAL`, not `TEXT`. Not
  currently a behavior concern: `id` is never selected/returned by either existing call site.
- Every index/unique carries an explicit `map:` name matching what the two SQL scripts actually
  created (e.g. `PayrollExportBatch_company_period_unique`), so a future `prisma db push`/
  `migrate diff` recognizes them as already existing instead of trying to create duplicates.
- No relation fields to `Department`/`User`/`CutoffPeriod` — the live columns have no FK
  constraints, and adding `@relation` now would imply constraints that don't exist plus require
  back-relations on `Department`/`User`. Left as a follow-up if ever wanted.
- `payrollExportService.js`/`payrollExportController.js` still use `$queryRaw`/`$executeRaw`
  unchanged — this ticket is schema declaration only, not a call-site migration.

**Verified applied** via a new read-only diagnostic
(`scripts/check-bb066-payroll-export-schema-applied.js`) confirming every table/column/index the
two SQL scripts should have created actually exists in the live DB, before trusting the new
models — all confirmed present, including the `departmentId` column and both BB-066 follow-up
indexes.

---

## Feature

### BB-066 (follow-up) — Per-Period Payroll-Export Status on `GET /api/cutoff-periods`

**Ask (from the client side):** the new Payroll Report Preview needs to show, per period in a
list of 20+, whether its export has been generated — checkmark vs. greyed-out. The only existing
way to check was `GET /api/payroll-export/by-cutoff-period/:id` per row (404 if missing), an N+1
pattern for a list this size.

**Added:** `getCutoffPeriods` (`cutoffPeriodController.js`) now runs one extra batched
`$queryRaw` per list call (not per row) — collects the distinct `(periodStart, periodEnd)` pairs
in the current page and looks up matching `PayrollExportBatch` rows for the caller's `companyId`
in a single query, then maps the result onto each period:

```js
payrollExport: {
  generated: boolean,
  employeeCount: number | null,
  generatedAt: string | null,
}
```

Field names deliberately match `updateCutoffStatus`'s existing single-record
`data.payrollExport: { generated, employeeCount }` response, for consistency across all three
surfaces (list, single-status-update, detail-fetch). `payload` itself is intentionally excluded
from the list response — embedding full employee arrays into every row would bloat a 20+-row
response for no reason; the client already has the detail endpoint for that once a period's
picked.

**Contract confirmed alongside this ask** (no server changes needed for either):
- `GET /api/payroll-export/by-cutoff-period/:id` success/404 response shapes — unchanged, exact
  payload documented back to the client verbatim.
- `?departmentId=` filter on `getCutoffPeriods` (including the `"none"` company-wide case) —
  already worked as-is; the preview reuses it directly.

**Client-side impact:** yes, and this is exactly what was asked for — `period.payrollExport?.generated`
is real now instead of always falling through to the "Not generated yet" placeholder.

---

## Data Fix

### BB-066 — Backfilled Piedmont Adult Day Program Exports for Pre-Trigger "Processed" Periods

**How the gap was found:** `generatePayrollExportForCutoffPeriod` has exactly one call site
(`updateCutoffStatus`, `cutoffPeriodController.js:541`), and that endpoint refuses to run at all
once a period is already `"processed"` (`cutoffPeriodController.js:502-504`,
`"Cannot change status of a processed cutoff period."`). So generation can only ever fire once,
on the single transition *into* `"processed"` — there is no in-app way to re-trigger it for a
period that already carries that status, whether it predates the feature or failed silently.

Cross-referencing `CutoffPeriod.updatedAt` (the processed-at timestamp) against commit `b1da582`
(`2026-08-07T02:53:18Z` UTC — the commit that added `generatePayrollExportForCutoffPeriod` and
its only call site) explained most of it: periods processed before that instant never had a
chance to call a function that didn't exist in the codebase yet.

**Jul 22 – Aug 4, 2026** (Driver/Aide, Staff Supervisor, Staff) — all three processed before the
commit landed. Diagnostic (`scripts/check-bb066-piedmont-jul22-aug4-source-data.js`) confirmed
real approved data for all three (593/18/108 approved `TimeLogApproval` rows respectively, plus
OT and paid leave) despite `0` `PayrollExport` rows. Backfilled by calling the real
`generatePayrollExportForCutoffPeriod()` directly per department
(`scripts/fix-bb066-backfill-piedmont-jul22-aug4-export.js`), scoped so it structurally cannot
write outside this one company+period. **Run and confirmed complete by the user** — the merged
`PayrollExportBatch` payload now includes all 3 departments instead of just Staff's 12.

**Jul 8 – 21, 2026** (Driver/Aide, Staff Supervisor, Staff) — Driver/Aide processed before the
commit (same explanation as above). **Staff Supervisor and Staff processed ~23 minutes *after*
the commit landed** and still ended up with `0` `PayrollExport` rows despite real approved data
(30, and 92 + 1 OT + 1 leave day, respectively) — diagnostic:
`scripts/check-bb066-piedmont-jul8-jul21-source-data.js`. Backfill script written
(`scripts/fix-bb066-backfill-piedmont-jul8-jul21-export.js`), same scoping/safety pattern as
above — **not yet run as of this entry.**

**Not resolved:** why Staff Supervisor/Staff's Jul 8–21 processing (after the trigger existed)
still produced nothing. Two explanations remain open — deploy lag (commit merged but not yet
live on the server at that moment) vs. a real runtime error that `updateCutoffStatus`'s
`try/catch` swallowed (only logged as `console.error("[⚠️ BB-066] Payroll export generation
failed for", id, exportErr.message)`, never surfaced). Distinguishing them would need server
logs from around `2026-08-07T03:16` UTC, which weren't available for this investigation. Backfill
was chosen as the path forward regardless, since the same function already ran successfully for
these exact same departments (including Staff Supervisor) on the Jul 22–Aug 4 period — low risk
either way, but the underlying "why" is still unknown.

**Client-side impact:** none — these are data-only backfills using the existing generation
function; no endpoint/payload/contract changed.

---

## Investigation — Not Yet Fixed / Open

### BB-066 — No Re-Trigger Path for Already-`"processed"` Periods

`updateCutoffStatus`'s `cutoffPeriod.status === "processed"` guard blocks the endpoint entirely
for a period already in that state — by design, so a truly-final status can't be reopened. But
that also means if generation fails silently (swallowed by the `try/catch`) or a period was
processed before the feature existed, **the only recovery today is a one-off manual backfill
script per period**, as done above. Not fixed here: whether a proper admin-facing "regenerate"
action should exist for this case — flagged, not scoped.

### BB-066 — 31 Other Processed Periods Across 4 Other Companies Still Missing Exports

The original company-wide scan (`scripts/check-bb066-processed-periods-export-status.js`) found
34 of 37 `"processed"` `CutoffPeriod` rows missing a `PayrollExportBatch`; only the 6 Piedmont
rows (2 periods) above have been investigated/addressed. The remaining 31 — across BizSolutions
LLC, Sunshine Learning, Nikey, and BizMobile Development Inc. — are all pre-Aug-7 (pre-feature)
and haven't been triaged. Open question, not yet answered: do any of those older periods still
need an export handed to the external payroll system, or does only current/recent data matter
going forward? No action taken pending that decision.

---

## Files Changed

| File | Change |
|---|---|
| `src/prisma/schema.prisma` | New `PayrollExport`/`PayrollExportBatch` models, mirroring the live raw-SQL tables exactly (`BigInt` id, explicit index `map:` names, no relations) |
| `src/controllers/Features/cutoffPeriodController.js` | `getCutoffPeriods` enriched with per-period `payrollExport: { generated, employeeCount, generatedAt }` via one batched query per list call; added `Prisma` import |
| `src/services/Payroll/payrollExportService.js` | Comment fix only — removed stale "not modeled in schema.prisma" claim |
| `src/controllers/Payroll/payrollExportController.js` | Comment fix only — same stale-comment cleanup |
| `scripts/check-bb066-payroll-export-schema-applied.js` | New, read-only — confirmed the two BB-066 SQL scripts' schema changes are live in the DB |
| `scripts/check-bb066-processed-periods-export-status.js` | New, read-only — company-wide scan of `"processed"` periods vs. `PayrollExportBatch` existence (found the 37/34 split) |
| `scripts/check-bb066-piedmont-jul22-aug4-source-data.js` | New, read-only — confirmed real approved source data existed for the 2 departments missing export rows |
| `scripts/fix-bb066-backfill-piedmont-jul22-aug4-export.js` | New, write — backfilled all 3 Piedmont departments for this period; run and applied by the user |
| `scripts/check-bb066-piedmont-jul8-jul21-source-data.js` | New, read-only — same diagnostic for the earlier Piedmont period; surfaced the post-trigger-failure anomaly |
| `scripts/fix-bb066-backfill-piedmont-jul8-jul21-export.js` | New, write — backfill for this period; written, not yet run as of this entry |
