# Changelog — v2.10.31

> **BB-062** — one employee's orphaned open punch (clock-in with no clock-out, unreachable by
> the auto-close cron) deleted via a scoped, backed-up script. Data-only fix; no code changed.
>
> **BB-051** — investigated a real punch-vs-approved-leave conflict (Albert Dalere) surfaced by
> the recent auto-revert toggle. Confirmed the "0h total" display is the intended pending-conflict
> state, but found `resolveConflict`'s "Honor Punch" path isn't segment-aware for Driver/Aide
> multi-segment days — a real corruption risk once auto-revert (or a manual Honor Punch) runs
> against this record. Toggle turned back off as a precaution. No code changed yet; fix pending
> go-ahead.
>
> **BB-066** — advancing a department's `CutoffPeriod` to `"processed"` (not `"locked"` — moved
> after real testing, see below) now auto-generates/refreshes that department's payroll summary
> and folds it into a single, take-latest `PayrollExportBatch` JSON per company+period — turning
> the one-time manual archive script into a standing part of the payroll flow. **Confirmed working
> end-to-end.** Fetch/download side now also shipped: `GET /api/payroll-export/by-cutoff-period/:id`
> (admin/supervisor/superadmin only), for another developer to build the actual download UI
> against — see `docs/CLIENT_PAYROLL_EXPORT_CONTRACT.md`.

---

## Data Fix

### BB-062 — Arlene Backeng: Orphaned Open Punch Never Auto-Closed

**Problem (reported):** Arlene Backeng's Punch Logs showed a 07/27/2026 record with a Time In
(08:05 AM) but no Time Out, flagged "Missing Out" in the client UI ("D-5: Session is active
past scheduled shift end. Clock-out is missing.") and stuck that way for 7+ days.

**Root cause:** `autoClockOutJob.js` (the live two-pass warn/close cron, registered in
`cronScheduler.js`, runs every 5 min) only finds sessions to close via the `LiveUser` table
(`LiveUser.closeAt <= now`) — it never queries `TimeLog` directly. `LiveUser.userId` is
`@unique`, so only one open session can be tracked per employee at a time. Confirmed via a
read-only diagnostic script
(`scripts/check-bb062-arlene-missing-clockout.js`) that no `LiveUser` row existed for this
employee at all — so this `TimeLog` (`status: true`, `timeOut: null`) was invisible to the
cron and could never be auto-closed or approved as-is.

Note: `src/jobs/autoClockOutSafeguard.js` looks like it would have been a `TimeLog`-based
safety net for exactly this case (a direct 5-hour-past-shift-end sweep, no `LiveUser`
dependency), but it is **not registered** in `cronScheduler.js` — superseded by the two-pass
`autoClockOutJob.js` redesign and left as dead code. No fallback currently exists for a
session that loses its `LiveUser` row.

**Fix — data only, single record:** Wrote (did not run) `scripts/fix-bb062-remove-arlene-missing-clockout.js`,
following this repo's dry-run/`--apply`/`--revert` convention. Targets the one confirmed
`TimeLog` id directly (not "whichever open record exists") and re-verifies its state
(correct user, `status: true`, `timeOut: null`) immediately before deleting, refusing to act
if anything had changed since confirmation. Backs up the full row plus everything related to
it (`LiveUser`, `TimeLogApproval`, `ContestTimeLog`, `Overtime`, any `RequestedTimeLog`
referencing it) to `scripts/backup-bb062-arlene-missing-clockout.json` before deleting, so
`--revert` can fully restore it if needed.

**Run and applied** by the user — confirmed via the resulting backup file
(`scripts/backup-bb062-arlene-missing-clockout.json`). No related `TimeLogApproval`,
`ContestTimeLog`, `Overtime`, or `RequestedTimeLog` rows existed for this record, so nothing
else was affected. The 07/27/2026 punch is removed from Arlene Backeng's Punch Logs; her
08/03/2026 punch (already `Complete` before this fix) was untouched throughout.

**Client-side impact:** none — no endpoint, payload, or contract changed. The record simply
no longer exists.

**Not fixed here (flagged for a future ticket):** the underlying gap that let a `TimeLog`
lose its `LiveUser` tracking row in the first place (most likely when the employee clocked in
again for 08/03 without the 07/27 session ever having been closed — `LiveUser.userId`'s unique
constraint means a new clock-in has to either replace or fail against an existing row for the
same user) was not traced to a specific code path or fixed. This ticket only removed the one
resulting orphaned record; the same class of orphaning could recur for another employee.
`autoClockOutSafeguard.js` existing as unregistered dead code — a `TimeLog`-based fallback
that wouldn't depend on `LiveUser` at all — is also worth a decision (revive and register it,
or remove it) rather than leaving it silently inert.

---

## Feature

### BB-066 — Automatic PayrollExportBatch Generation on Cutoff-Period "Processed"

**Idea:** the payroll integration prep work (`docs/changelog-v2.10.30.md`) only ever ran once,
manually, hardcoded to one company/period. BB-066 makes it a standing part of the existing
per-department status flow on the Cutoff Periods list, so every department incrementally builds
the same period's payroll JSON instead of requiring another one-off script run.

**Trigger pivoted mid-ticket — `"processed"`, not `"locked"`.** Originally wired to
`status: "locked"` (the "Lock Period" row action). While verifying it against a real multi-status
test run, confirmed the actual admin flow always goes `Open → Locked → Processed`, and that
`"processed"` is the one status `updateCutoffStatus` already treats as truly final — it explicitly
blocks any further status change once a period is processed, while `"locked"` can still be
reopened back to `"open"` with no guard at all. Moved the hook to fire on `"processed"` instead,
so a period only gets snapshotted once it's genuinely done, not on a status that might still be
reverted. No other design changed — same per-department incremental merge, same take-latest
upsert, same non-blocking failure handling described below; only the triggering status moved.

**Behavior:**
- Each row on the Cutoff Periods list is a single department's `CutoffPeriod`. Advancing one to
  `"processed"` (via `PATCH /api/cutoff-periods/:id/status`, `{ status: "processed" }`) now
  computes *that department's* Regular/OT/Driver/Training/PTO summary and merges it into the
  **one** JSON payload for the whole `companyId + periodStart + periodEnd` — "push or add" that
  department's employees, not a separate file per department.
- **Locking and unlocking do nothing new** — only `"processed"` triggers generation. A period can
  be locked/reopened any number of times with no effect on the payroll JSON.
- **Re-processing recomputes just that department** — its entries in the shared JSON are replaced
  with fresh numbers; other departments' most-recently-processed entries are untouched.
- **Take-latest, not append-only:** `PayrollExportBatch` is upserted (`ON CONFLICT` on
  `companyId, periodStart, periodEnd`) — one row per period, always the current merged snapshot,
  no history of prior JSON states kept.
- **Non-blocking:** the status change itself always succeeds even if export generation throws
  (logged, not surfaced as a failure) — the response/notification text simply falls back to the
  pre-BB-066 wording rather than falsely claiming the period is "secured."
- **Notification audience note:** the enriched "secured — N employee(s)" wording is only added to
  the API response (`message`, seen by the acting admin via the toast). The existing
  `CUTOFF_PROCESSED` notification broadcasts company-wide to every active employee, not just
  management (pre-existing behavior, unrelated to this ticket) — left deliberately unenriched so
  payroll headcount details aren't sent to non-management staff.

**Verified working end-to-end** by the user, against a real multi-department, multi-period
dataset (the Driver/Aide rows shown in testing carried hundreds of approved punches each). One
client-side issue surfaced during verification and was resolved: a "Lock Period" option had been
added to already-`processed` rows, which the server correctly rejects with `400`
(`"Cannot change status of a processed cutoff period."` — a pre-existing guard, not something
this ticket introduced). Rather than loosening that guard to permit `processed → locked`, which
would have undone the exact "processed is the one truly final status" property this ticket's
whole design depends on, the client-side option was reverted instead — menu stays empty for
processed rows, matching the terminal-state design intent. If reopening a processed period is
ever a genuine need, that's a separate ticket requiring its own product decision (does it also
invalidate the already-generated `PayrollExportBatch` snapshot? audit trail? downstream
notification?), not a quick guard removal.

**Why raw SQL / not simply reusing the old script:** `PayrollExport`/`PayrollExportBatch`
(`scripts/create-payroll-archive-tables.sql`) are deliberately not modeled in `schema.prisma` —
kept that way here too, via `$queryRaw`/`$executeRaw`, no `prisma generate` needed. The old
script's date-range + company-wide queries were also replaced with `cutoffPeriodId`-scoped
queries for punches/OT (`TimeLogApproval.cutoffPeriodId`, `CutoffOtBlock.cutoffPeriodId` both
already tie a record to its specific per-department cutoff row) — simpler and more correct than
re-deriving department membership from a date range. Leave/PTO still needs
`user.departmentId` + date-range, since `LeaveDay` has no `cutoffPeriodId`.

**Schema change (script written, not run — user applies manually):**
`scripts/add-payroll-export-department-and-batch-unique.sql` adds a nullable `departmentId`
column to `PayrollExport` (so a department's delete+reinsert never touches another department's
rows for the same period) and a unique index on `PayrollExportBatch(companyId, periodStart,
periodEnd)` (required for the upsert). Both additive, `IF NOT EXISTS` throughout, safe to run
any time — **must be applied before this code path is exercised**, since the `departmentId`
column and the upsert's conflict target don't exist yet without it.

**New file:** `src/services/Payroll/payrollExportService.js` —
`generatePayrollExportForCutoffPeriod(cutoffPeriod)`, the ported/parameterized version of the
one-time script's classification + write logic, called from `updateCutoffStatus`.

**Client-side impact:** none required — purely additive. `PATCH /api/cutoff-periods/:id/status`'s
response gains an optional `data.payrollExport: { generated, employeeCount }` field on
`"processed"`, and the existing `CUTOFF_PROCESSED` notification's `payload` carries the same
data (its `message` text stays generic/unenriched — see the notification-audience note above).

### BB-066 (follow-up) — Fetch/Download Endpoint

**New:** `GET /api/payroll-export/by-cutoff-period/:id` — `src/controllers/Payroll/payrollExportController.js`
(`getPayrollExportByCutoffPeriod`) + `src/routes/Payroll/payrollExportRoutes.js`, mounted at
`/api/payroll-export` in `src/routes/index.js`. `:id` is any single department's `CutoffPeriod`
id for the target period; returns the merged company+period `PayrollExportBatch` payload
regardless of which department's id was used to look it up. `404` if no department has processed
that period yet — an expected response for an Open/Locked period, not an error state.

**Access:** `admin`/`supervisor`/`superadmin` only, via the existing JWT Bearer
(`authMiddleware.js`) + `authorizeRoles` pattern — same as every other endpoint in this API, no
new auth mechanism introduced. Deliberately not exposed to typical employee users, since the
payload spans every department that's processed for the period, not just one — flagged as a
known non-department-filtered read for supervisors specifically (a supervisor sees other
departments' figures too, not just their own), not yet narrowed.

**For another developer to build against** — full request/response contract, including a sample
payload, is in `docs/CLIENT_PAYROLL_EXPORT_CONTRACT.md` ("Fetch/download endpoint" section). No
further server-side scope remains open on BB-066 as of this entry.

---

## Investigation — Not Yet Fixed

### BB-051 — Punch-vs-Approved-Leave Conflict: Segment-Unaware `resolveConflict` Risk

**Reported:** Albert Dalere (DayCare, Driver/Aide) has an approved Sick Leave (Jul 26 – Aug 3)
overlapping days he actually worked — a 3-segment Driver Day (Driver AM / Regular / Driver PM)
each punch/segment showing correct individual hours (1.15h / 5.5h / 1.25h) but a **"0h total"**
at the day level in cutoff review, with the approved leave still attached to every segment.

**Confirmed as expected:** per the BB-051/BB-054 contract (`docs/CLIENT_LEAVE_CONTRACT.md`), an
unresolved `hasLeaveConflict: true` approval intentionally contributes 0 to the payable day total
until an admin picks "Honor Punch"/"Honor Leave" — or, with the new company-level
`leaveConflictAutoRevert` toggle (`Company.leaveConflictAutoRevert`, default off) turned on, until
that resolves it automatically. This part is not a bug.

**Sync vs. auto-revert — clarified:** the "Sync" button (`syncCutoffApprovals`,
`cutoffPeriodController.js:796`) only creates missing approval records and recomputes
hours/OT — it never touches leave conflicts. The BB-051 auto-revert logic actually lives inside
`getCutoffApprovals` (`cutoffPeriodController.js:1167`), the plain GET/list endpoint — so it fires
on every page load/refresh of the cutoff review screen while the toggle is on, not on Sync.
When it fires, it calls `resolveConflict(choice: "punch")` directly: the leave is cancelled, a
flat 8h is refunded to balance, and the approval goes straight to `status: "approved"` — it does
**not** get re-queued for manual approval.

**Bug found (unfixed):** `resolveConflict`'s "Honor Punch" branch
(`src/services/Cutoff/daycareCutoffStrategy.js:699-761`) is **not segment-aware**, unlike
`approveSingle`/`approveBulk` in the same file, which correctly key off
`approval.segmentType`/`segmentStart`/`segmentEnd`/`lastDriverSegment()` and only write the
shared `TimeLog.timeIn/timeOut` once, on the last segment. `resolveConflict` instead
unconditionally overwrites the *whole* `TimeLog.timeIn/timeOut` from a single generic shift
lookup, with no regard for which segment triggered it. For a 3-segment Driver Day like this one,
auto-revert (or three manual Honor Punch clicks) would call `resolveConflict` three times against
the same `TimeLog`, each overwrite clobbering the correct 3-segment breakdown down to one generic
shift window — likely destroying two of the three segments' correct hours.

**Action taken:** none to code. `leaveConflictAutoRevert` was switched back off for this company
as a precaution, since simply reopening/refreshing this cutoff period's approvals view while the
toggle was on would have triggered the bug against this exact record. Albert's conflict remains
unresolved (pending manual Honor Punch/Honor Leave) until the fix ships.

**Client-side impact:** none anticipated for the fix itself — pure server-side computation
correction, no endpoint/payload/contract change.

**Not fixed here:** the segment-aware `resolveConflict` fix itself — investigated and scoped,
pending explicit go-ahead before implementation.

---

## Files Changed

| File | Change |
|---|---|
| `scripts/check-bb062-arlene-missing-clockout.js` | BB-062: new, read-only diagnostic script (confirmed the orphaned record and root cause) |
| `scripts/fix-bb062-remove-arlene-missing-clockout.js` | BB-062: new, scoped delete script with dry-run/`--apply`/`--revert` and full backup (written, run manually) |
| `docs/changelog-v2.10.31.md` | BB-051: documented investigation findings — no source files changed |
| `scripts/add-payroll-export-department-and-batch-unique.sql` | BB-066: new, additive schema script — `PayrollExport.departmentId` + `PayrollExportBatch` unique index (written, not yet run) |
| `src/services/Payroll/payrollExportService.js` | BB-066: new — `generatePayrollExportForCutoffPeriod`, per-department summary generation + take-latest JSON merge; includes `[BB-066]` entry/source-count/done console logs for diagnosing the empty-result issue hit during testing |
| `src/controllers/Features/cutoffPeriodController.js` | BB-066: `updateCutoffStatus` calls the export service on `status: "processed"` (moved from `"locked"` mid-ticket, non-blocking), enriches the response `message`/`data.payrollExport` on success. `"locked"`/`"processed"` notification text otherwise unchanged from pre-BB-066 |
| `docs/CLIENT_PAYROLL_EXPORT_CONTRACT.md` | BB-066: new client handoff doc, updated through the locked→processed pivot and the fetch/download endpoint; client's toast change already shipped and needed zero further changes |
| `src/controllers/Payroll/payrollExportController.js` | BB-066 follow-up: new — `getPayrollExportByCutoffPeriod`, read-only fetch of a period's `PayrollExportBatch` |
| `src/routes/Payroll/payrollExportRoutes.js` | BB-066 follow-up: new — `GET /by-cutoff-period/:id`, admin/supervisor/superadmin only |
| `src/routes/index.js` | BB-066 follow-up: mounts the new routes at `/api/payroll-export` |
