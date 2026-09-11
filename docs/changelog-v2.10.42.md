# Changelog — v2.10.42

> **BB-086** — historical punch logs can now be bulk-imported from the legacy PadPro system's
> payroll-summary CSV export (aggregate daily hour totals, not raw punches) into a DayCare
> company's open cutoff period, via the same preview/confirm review flow as the other CSV
> importers.
>
> **BB-088** — the employee Overview dashboard's analytics endpoint gains four new metrics
> (usual clock-in/out, average hours and overtime per day/week/month), and a bug fix so the
> admin Overview dashboard's "Leave by Type" chart shows readable leave-type names instead of
> raw policy ids.

---

## BB-086 — Backtrack Punch-Log Import from Legacy PadPro Export

**Why:** Companies migrating off the legacy "PadPro" payroll system have historical attendance
data trapped in its payroll-summary export format — a wide grid with one row per employee and
pre-aggregated **hour totals** per day (regular / driver AM / driver PM), not raw clock-in/out
timestamps. None of the existing importers fit: the flat punch-log importer (BB-077) expects
real timestamps, and there was no path at all for backfilling this aggregate-hours shape into
`TimeLog`. BB-086 adds one, scoped to DayCare companies only (not B&C).

**Two-phase, like the schedule importer (BB-081)** rather than BB-077's one-shot commit: because
the synthesized punch times are inherently best-effort (derived from hour totals, not real
punches), nothing is written until an admin has reviewed the preview and confirmed.

**`csvBacktrackPunchLogParser.js`** (new) — parses the PadPro grid: locates the period label
("Date: January 7 to 20, 2026"), the three segment column-groups (Day Program / D-A AM / D-A
PM hours), and the shared day-of-month sub-header, cross-checking each group's per-employee
"Hours" subtotal against the sum of its daily cells and collecting mismatches as row warnings
rather than failing the file.

**`backtrackSegmentSynthesis.js`** (new) — pure, DB-free math turning a day's aggregate hour
totals into synthetic `TimeLog` `timeIn`/`timeOut` records that, once run through the Cutoff
Period page's existing "Approve Raw" flow, credit back the same per-segment totals. This
required reproducing `daycareCutoffStrategy.js`'s exact raw-mode crediting formula: a single
punch record can only vary its **first** segment (via `timeIn`, capped at the segment's own
window) or **last** segment (via `timeOut`, open-ended into OT) — any segment in between is
always credited its full scheduled window regardless of the punch. For an ordinary day where
the CSV's regular-hours value already matches the full scheduled window (within the company's
grace period, which the approval step would round back up to full credit anyway), this emits
one `DRIVER_AIDE` record spanning AM→PM. Only when the regular-hours shortfall genuinely
exceeds grace — a real partial/short day — does it fall back to **two** records
(`DRIVER_AIDE_AM` then `DRIVER_AIDE_PM`) so that day's actual value can still be captured
exactly instead of silently rounding up.

**`backtrackImportService.js`** (new) — `previewBacktrackImport()` (parse, fuzzy-match employee
names via Jaccard token similarity, resolve each day's shift windows from the employee's
`UserShift` or the company's catalog `Shift`, synthesize records, predict post-approval credited
hours per segment, flag conflicts/locked periods — writes nothing) and
`commitBacktrackImport()` (re-validates the possibly admin-edited preview rows against current
DB state, creates `RequestedTimeLog`/`TimeLog` records through the same pipeline BB-077 uses,
then syncs the target cutoff period's `TimeLogApproval` queue). When no `cutoffPeriodId` is
given, preview auto-selects an existing open period covering the file's date range if one
exists, otherwise still returns the full preview with `needsCutoffPeriod: true` and a suggested
range so the client can prompt to create one before confirming.

**Reused, not duplicated:** `findCutoffForCompany` and `syncApprovalRecords` were exported from
`cutoffPeriodController.js` (previously module-private) instead of being reimplemented, since
they're exactly what the existing `/:id/sync` route already uses.

**Client-side impact:**
- Two brand-new endpoints, no prior contract: `POST /api/backtrack-punch-log-import/preview`
  (multipart `file` field, optional `cutoffPeriodId`; returns a preview, writes nothing) and
  `POST /api/backtrack-punch-log-import/confirm` (JSON body: `cutoffPeriodId` + the
  possibly-edited preview `entries`; `207` response).
- New UI needed: an upload entry point (DayCare companies only — hide/disable for B&C), a review
  screen listing each employee/day row's status (`ready` / `conflict` / `error` /
  `unresolved-employee` / `informational`) with the predicted post-approval credited hours per
  segment, a manual employee-assignment control for `unresolved-employee` rows, and a per-row
  skip toggle before confirming.
- If preview comes back with `needsCutoffPeriod: true`, the client should prompt to create a
  cutoff period (existing `POST /api/cutoff-periods`) covering the suggested
  `suggestedPeriodStart`/`suggestedPeriodEnd` range before allowing confirm.

**Files Changed:**

| File | Change |
|---|---|
| `src/utils/csvBacktrackPunchLogParser.js` | New — PadPro grid CSV parsing |
| `src/utils/backtrackSegmentSynthesis.js` | New — aggregate-hours-to-punch-times synthesis, mirroring raw-mode approval crediting |
| `src/services/Features/backtrackImportService.js` | New — preview/commit business logic, employee matching, shift-window resolution |
| `src/controllers/Features/backtrackPunchLogImportController.js` | New — preview/confirm route handlers |
| `src/routes/Features/backtrackPunchLogImportRoutes.js` | New — routes, multer config |
| `src/routes/index.js` | Registered `/backtrack-punch-log-import` route |
| `src/controllers/Features/cutoffPeriodController.js` | Exported existing `findCutoffForCompany` and `syncApprovalRecords` for reuse (were module-private) |

---

## BB-088 — Improve Overview Page

**Why:** The employee Overview dashboard only showed totals (Total Hours, Overtime, Absences)
for the selected period — no sense of an employee's *typical* pattern (when they usually clock
in/out) or normalized rates (hours/OT per day vs. projected per week/month). Separately, the
admin Overview dashboard's "Leave by Type" chart was found to be unusable — the client repo has
no local leave-type lookup, and the server was sending raw `LeavePolicy` ids instead of names.

**Employee Overview — new metrics** (`GET /api/analytics/employee`,
`employeeAnalyticsController.js`, `getEmployeeAnalytics`): added a `patterns` block
(`usualClockIn`/`usualClockOut` — median first-punch/last-punch time-of-day across days with a
session in the period, formatted e.g. `"9:02 AM"`, robust to one-off outlier days) and an
`averages` block (`hoursPerDay`/`overtimePerDay` = total ÷ days with a logged session;
`hoursPerWeek`/`hoursPerMonth` and their overtime equivalents = that daily figure projected
×7/×30, since the page's own period picker already governs which days are being averaged).
Overtime here intentionally reuses the same real-time estimate
(`actualHours − scheduledHours` per shift-day) already driving the page's existing Overtime
tile, rather than the payroll-authoritative `CutoffOtBlock`, so the two OT figures on screen
stay consistent with each other. Purely additive — every existing response field is unchanged.

**Admin Overview — "Leave by Type" fix** (`adminAnalyticsController.js`,
`getAdminAnalyticsDashboard`): `Leave.leaveType` is a legacy field that actually stores the
`LeavePolicy` id, not a display name (`policyId` is the formalized FK, kept in sync). The
`leaveByType` chart aggregation was grouping directly on that raw id. Fixed by batch-resolving
the distinct `leaveType` ids to their `LeavePolicy.leaveType` names (falling back to the raw
value if no match is found) before aggregating — the same pattern `leaveController.js`'s
`_attachPolicyNames()` already uses elsewhere in the codebase, reused rather than reimplemented.

**Client-side impact:**
- `GET /api/analytics/employee` gains two new top-level fields: `patterns: { usualClockIn,
  usualClockOut }` (either may be `null` if no qualifying sessions exist in the period — render
  as `—`) and `averages: { hoursPerDay, hoursPerWeek, hoursPerMonth, overtimePerDay,
  overtimePerWeek, overtimePerMonth }`. New UI needed on the employee Overview page — e.g. two
  more stat cards for the usual clock-in/out times and an averages row/section near the Daily
  Hours chart. The projected week/month figures are rates, not literal calendar buckets, so a
  small "projected" label/tooltip is recommended.
- `GET /api/analytics/admin-dashboard`'s `charts.leaveByType[].type` now contains a leave-type
  **name** instead of an id — same field, same shape, content-only fix. No client code change
  required; `OverviewAdmin.jsx`'s existing `x="type"` chart binding now renders correctly.

**Files Changed:**

| File | Change |
|---|---|
| `src/controllers/Features/employeeAnalyticsController.js` | New `patterns` (usual clock-in/out) and `averages` (hours/OT per day/week/month) in the employee analytics response |
| `src/controllers/Features/adminAnalyticsController.js` | `leaveByType` aggregation now resolves `LeavePolicy` names instead of grouping on the raw legacy `leaveType` id |
