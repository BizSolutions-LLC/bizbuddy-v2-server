# Changelog — v2.10.30

> **BB-059** — investigation only, no code changed. Root cause identified via `RequestLog`
> analysis and live reproduction testing; resolution is a process/UI-awareness fix, not a
> server bug fix.
>
> **BB-054 / BB-051** — per-shift leave selection, a weekend-exclusion checkbox, and a
> company-level punch-vs-leave auto-revert toggle. Code shipped and schema migration applied
> (`scripts/add-leave-shift-exclusion-and-auto-revert-fields.sql`, confirmed via live query
> testing after `npx prisma generate`).
>
> **Payroll integration prep (no ticket number)** — secured the approved punch/leave data for
> Jul 8–21, 2026 into new archive tables, and generated the first Regular/OT/Driver/Training/PTO
> per-employee JSON export for the payroll team. See section below.

---

## BB-054 / BB-051 — Per-Shift Leave Selection, Weekend Exclusion, Punch-Conflict Auto-Revert Toggle

Three refinements to the employee leave request flow, confirmed with Carlo and cross-checked
against a matching client-side plan already scoped in the companion client repo (same
contract, built in parallel):

1. **Per-shift selection** — an employee with 2+ shifts on the same day (e.g. Driver AM /
   Driver PM) can deselect specific shifts from a leave request; the leave now deducts hours
   only for the shifts left selected. `Leave.affectedShiftIds`/`affectedShifts` already
   existed but was write-only — captured on submit, never read back by approval/deduction
   logic (`docs/LEAVE_MODULE.md` §15.3). This ships the missing consumer.
2. **Weekend exclusion checkbox** — `calcDailyHours` treats every day in a leave's range as
   deductible unconditionally today, including weekends with no plotted shift — a deliberate
   BB-048 behavior (commit `a14411c`). New optional `includeWeekends` flag (default `true`,
   preserving current behavior) lets an employee exclude unplotted Saturdays/Sundays from the
   deduction. A weekend day with a real scheduled shift is unaffected either way — the toggle
   never excludes actual worked hours.
3. **BB-051 auto-revert toggle** — a new company-level setting,
   `leaveConflictAutoRevert` (default `false`), for whether a punch-vs-leave conflict
   auto-resolves in favor of the punch instead of waiting for manual review in cutoff
   approvals. **Deliberately narrow scope**: does not touch `resolveConflict`'s existing
   mechanics (still cancels the *entire* Leave record and refunds a flat 8h with no ledger
   entry — a known, separately-tracked gap). Only the trigger changes: automatic vs. an
   admin's manual PATCH.

**Schema (`src/prisma/schema.prisma`):**
- `Leave.excludedShiftIds` — `Json? @default("[]")`. The `UserShift` ids the employee
  explicitly deselected. Kept separate from `affectedShiftIds`/`affectedShifts` (which is
  unchanged, still display-only) — overloading the existing field would make "deselected
  everything" indistinguishable from "no selection made" once empty-array omission kicked in,
  silently falling back to whole-day deduction.
- `Leave.includeWeekends` — `Boolean @default(true)`.
- `Company.leaveConflictAutoRevert` — `Boolean @default(false)`.

**`src/utils/leaveUtils.js` — `calcDailyHours`:** new options `excludeShiftIds` (filters the
shift-hours sum for a day) and `includeWeekends` (zeroes an unplotted weekend day's fallback).
A day where every shift is deselected correctly lands at 0h rather than falling through to the
no-shift fallback — `datesWithShift` now tracks "a real shift existed here" separately from
the post-exclusion hours sum, so the two can't be conflated.

**Call sites threaded through (all 4, so preview/approval/cutoff-sync can never disagree):**
- `submitLeaveRequest` (`leaveController.js`) — validates `excludedShiftIds` against the
  requester's own `UserShift` rows, persists both new fields.
- `getAffectedSchedules` (`leaveController.js`, the pre-submission preview) — accepts
  `includeWeekends` as a query param; zeroed weekend fallback rows now carry
  `excludedByWeekend: true` alongside `scheduledHours: 0`, so the client doesn't have to
  reimplement day-of-week logic to render them. (`excludedShiftIds` is *not* threaded here —
  real shift rows already come back individually with their own `scheduledHours`, so the
  client derives its live total by filtering client-side; passing the filter server-side
  would have been a no-op for this endpoint's response shape.)
- `_attachRequestedHours` (`leaveController.js`, list views) — reads a leave's stored
  selection so displayed totals match what approval actually computed.
- `leaveApprovalService.js` (`previewLeaveApproval` and `applyLeaveApproval`) — reads the
  leave's stored `excludedShiftIds`/`includeWeekends` for the real deduction.
- `cutoffPeriodController.js`'s cutoff-sync integration — same passthrough, so a later cutoff
  recompute can't silently revert a partial selection back to whole-day/whole-shift. Same risk
  class as the recent BB-040/BB-056–058 cutoff-sync fixes; flagged for careful QA.

**`hasLeaveConflict` is now shift-aware (`cutoffPeriodController.js`):** previously a pure
date-range overlap check with no concept of shifts — once a leave can legitimately exclude one
shift on a multi-shift day, that check alone would false-flag a punch on the *excluded* shift
as a conflict. Fixed by matching the punch's clock-in time against each of that day's shift
windows (new, self-contained correlation logic — batched by user/date rather than per-approval
queries) to find which specific shift the punch belongs to, then checking it against
`Leave.excludedShiftIds`. Note: there's no existing FK from `TimeLog` to `UserShift` anywhere
in this codebase, and the existing shift-lookup helper (`shiftLookupUtils.js`) only resolves a
single shift per day (`findFirst`) — this is new matching logic, not a reuse of an existing
multi-shift-aware primitive, so it's worth extra scrutiny in QA.

**BB-051 trigger (`cutoffPeriodController.js`):** when `leaveConflictAutoRevert` is `true`,
a detected pending conflict now calls the existing `resolveConflict(choice: "punch")` path
automatically (reusing the per-company strategy in `bncCutoffStrategy.js`/
`daycareCutoffStrategy.js` unchanged) instead of waiting for a manual click. `approvedBy` is
recorded as `null` for an auto-resolved record (nullable field, no human actor). The in-memory
response for the triggering request is patched so an auto-resolved approval/leave shows its
post-resolution state immediately, and `leaveRecords` is kept in sync so other days in the
same multi-day leave don't still render as "approved" after the whole request was just
cancelled.

**`src/controllers/Account/companySettingsController.js`:** `leaveConflictAutoRevert` wired
into the existing `GET`/`PATCH /api/company-settings` field set, same pattern as
`multiApprovalEnabled`.

**Migration note — schema changes written, not yet applied.** `scripts/add-leave-shift-exclusion-and-auto-revert-fields.sql`
(additive, `IF NOT EXISTS`, no backfill needed) must be run manually, followed by
`npx prisma generate`, before any of this takes effect — until then, `POST /api/leaves/submit`
throws `PrismaClientValidationError: Unknown argument excludedShiftIds` (confirmed via a live
client-side test against this contract). Delete the script file after running it, per this
repo's disposable-migration-script convention.

**Client-side impact:** the companion client repo has a matching plan already scoped against
this exact contract (new `excludedShiftIds`/`includeWeekends` submit fields, `includeWeekends`
preview query param + `excludedByWeekend` response field, `leaveConflictAutoRevert` settings
field). Documented in `docs/CLIENT_LEAVE_CONTRACT.md` under "BB-054 — Per-shift leave
selection, weekend exclusion, and BB-051's company-level auto-revert toggle."

**Not touched, deliberately:** `resolveConflict`'s existing revert mechanics (whole-leave
cancel, flat 8h refund, no ledger entry) — out of scope per the confirmed decision that BB-051
stays narrowly scoped to the on/off trigger only.

---

## Investigation

### BB-059 — "Ghost Password" — Employees' Passwords Silently Broken by Unrelated Admin Edits

**Problem (reported):** Multiple employees reported their password suddenly stopped working
with no changes made on their end — same password, previously working, rejected with
"Invalid credentials" on login. Client-side investigation (`bizbuddy-v2-client-web`) had
already ruled out the classic causes: the Edit Employee form was confirmed to only include
`password` in its update payload when an admin actually typed a new value.

**Server-side code audit — no defect found:**
- `bcrypt.compare`/`bcrypt.hashSync` usage (`accountSigninController.js`,
  `employeeController.js`, `resetPasswordController.js`, `accountSignupController.js`,
  `provisionController.js`) — consistent library (`bcryptjs@2.4.3`, never bumped), consistent
  salt rounds (`10`) everywhere.
- Every write path to `User.password` (admin update-employee, self-service change-password,
  forgot-password reset) only writes when a non-empty plaintext value arrives in that request,
  hashes fresh plaintext only (never re-hashes an existing hash), and uses explicit
  Prisma `data:` objects — no `data: {...req.body}` spread-bug pattern anywhere.
- No migration since `000_init` ever touched the `password` column; no Prisma
  `$use`/`$extends` middleware exists that could intercept or double-hash a write; no
  background job/worker touches `password`.

**`RequestLog` analysis** (`docs/sql/bb059_ghost_password_diagnostic.sql`, read-only,
60-day window): correlated `PUT /api/employee/:id` calls that carried a non-empty `password`
key against subsequent `401 Invalid credentials` logins for the same target employee. Found
a consistent, tight cause → effect pattern — edits followed by that employee's login failing
within seconds to low-tens-of-seconds, and in several cases the employee retried repeatedly
hours later (when they next tried to clock in), which explains why the connection wasn't
obvious from the employee's side. Example gaps: 11s, 12s, 13s, 13s, 17–25s across six
distinct employees/companies.

**Live reproduction — ruled out every code-level theory:**
- A single isolated edit (touching only an unrelated field, e.g. last name) never included
  `password` in the outgoing request — confirmed via browser Network tab, both before and
  after intentionally setting a password on a *different* record in the same session.
- Editing employee A with a real password, then immediately editing employee B without
  touching password, never leaked A's value into B's request — tested on both web and the
  iOS app (`BizBuddy/1 CFNetwork/... Darwin/...` in `RequestLog.userAgent`), no carryover.
- Checked for a retry/sync-replay mechanism (any API call in the 5 minutes following a
  legitimate password change that might resubmit a stale value) — none found; every
  subsequent request in that window was unrelated background traffic
  (`/api/notifications`, `/api/presence`, `/api/timelogs/*`, etc.), none carrying `password`.

**Conclusion:** No server or client code defect. The password-carrying edits are genuine,
non-empty submissions, concentrated on two admin accounts —
`cmnejl0ji00i4nr4ubxche5ij` (company `cmnegwuxm0004rf7fzo6wjrw2`) and
`cmo5xr1i00qyssq4tvrqijo5x` (company `cmo5xr1nm0qyvsq4tdeejn5bj`) — across dozens of
employees over two months, on both web (Chrome) and mobile (iOS app). Since this happens on
both platforms for the same actor and no platform-specific bug reproduces it, the most likely
explanation is that the acting admin isn't aware their own workflow (habitual re-entry, or
an autofill/password-manager suggestion silently populating that field) is resetting the
employee's password on routine, unrelated edits.

**Recommended next step (not a code fix):** have the admin behind those two accounts
screen-capture the Edit Employee form's password field immediately before hitting Save on a
routine edit, to see directly whether it's showing a value they didn't intentionally type
(autofill) or whether they're genuinely filling it in as habit (process gap requiring
employee notification when it happens).

**Files added (diagnostic only, not shipped as a fix):**
- `docs/sql/bb059_ghost_password_diagnostic.sql` — read-only queries: failed-login volume by
  day, failed-login → preceding password-event correlation, admin edits carrying a password
  field with platform detection, rapid repeated password-mutation calls, and post-password-
  event request timeline.

**Hardening worth considering separately (out of scope here):** `employeeController.js`'s
`if (password) { ... }` guard on `updateEmployee` is a bare truthy check — it will accept and
apply *any* non-empty string, including one an admin didn't intend to submit. A future ticket
could require an explicit "change password" intent flag from the client rather than trusting
field presence/truthiness alone. Not implemented here since the root cause turned out to be
upstream of that check, not the check itself.

---

## Payroll Integration Prep — Secure Jul 8–21, 2026 Punch/Leave Data, Generate Payroll JSON Export

Two related asks ahead of the external payroll system integration: (1) freeze the approved
punch and leave data for cutoff period Jul 8, 2026 – Jul 21, 2026 (company
`cmnegwuxm0004rf7fzo6wjrw2`) before it's consumed downstream, and (2) produce the JSON format
the payroll team's developers requested — `EmployeeName`, `EmployeeID`, `UserID`, Regular/OT/
Driver/Training Hours, and PTO (merged Sick + Paid Leave) — per employee for that period.

**Why not just lock the `CutoffPeriod`:** investigated `finalizeCutoffPeriod`
(`cutoffPeriodController.js`) as the obvious "secure it" mechanism first. Found it does **not**
actually guarantee immutability, despite comments claiming otherwise — it only flips
`CutoffPeriod.status` to `"locked"`, and the generic `PATCH /api/cutoff-periods/:id/status`
endpoint has no check blocking `"locked" → "open"`. Only `"processed"` status is genuinely
frozen, and that status carries other implications (signals payroll has already run) that
didn't fit here. Went with an independent snapshot instead, decoupled from anything the live
tables do later.

**Also found while investigating:** `payrollController.js` (the existing payroll-run code)
doesn't read from the cutoff/approval pipeline at all — it independently recomputes hours
straight from raw `TimeLog`/`Overtime`, with a cruder leave-hours estimate that doesn't use
`LeaveDay` or distinguish leave types. Two disconnected sources of "hours" exist in this system
today. This export deliberately sources from the cutoff/approval pipeline (`TimeLogApproval` +
`CutoffOtBlock`) — the numbers that were actually reviewed and approved in Cutoff Review —
not `payrollController.js`'s separate computation.

**New tables** (`scripts/create-payroll-archive-tables.sql`, additive only, not modeled in
`schema.prisma` — accessed via raw SQL, no `prisma generate` needed):
- `CutoffPunchArchive` — one row per approved `TimeLogApproval` in the period, denormalized
  (employee name/`employeeId` copied at snapshot time since `User` fields are mutable).
- `LeaveDayArchive` — one row per `LeaveDay` (paid and unpaid) overlapping the period.
- `PayrollExport` — one row per employee: the computed Regular/OT/Driver/Training/PTO totals.
- `PayrollExportBatch` — one row per generation run, with a `payload JSONB` column holding the
  exact JSON array also written to the output file — the direct "fetch this period's export"
  source of truth, no reconstruction from `PayrollExport`'s columns needed.

**Generation script** (`scripts/archive-and-export-payroll-2026-07-08-to-21.js`, `DRY_RUN=true`
by default): reads live data read-only, classifies each approved punch —
- Regular Hours = `REGULAR` punches + the `"regular"` segment of a `DRIVER_AIDE` 3-segment day
- Driver Hours = `DRIVER_AIDE_AM`/`DRIVER_AIDE_PM` punches + `driver_am`/`driver_pm` segments
- Training Hours = `TRAINING` punches
- OT Hours = approved `CutoffOtBlock` rows in range (date-range filtering works for both
  `otBasis: "daily"`, many rows per employee, and `"cutoff"`, one row per employee)
- PTO = all paid `LeaveDay` hours in range, every leave type merged into one figure (per-type
  breakdown printed during the run for sanity-checking, not filtered out)

then writes the 4 tables above and a JSON file to `scripts/output/`. Re-running is idempotent —
it clears any prior rows for the exact same company+period before writing fresh ones, so a
failed or repeated run never duplicates data.

**Bug hit and fixed during the first real run:** `PayrollExport`'s insert used
`.toFixed(2)` (a JS string) for the hour columns — Prisma binds string parameters as `text`,
and Postgres won't implicitly cast that into `numeric`, so the insert 500'd with
`column "regularHours" is of type numeric but expression is of type text`. Fixed with explicit
`::numeric`/`::int` casts on every bound numeric value. The archive-table inserts were
unaffected (they pass Prisma `Decimal` values directly, not `.toFixed()` strings).

**Result:** first successful run archived 759 punch records and 6 leave-day records, and
generated per-employee `PayrollExport`/`PayrollExportBatch` rows plus the handoff JSON at
`scripts/output/payroll-export-2026-07-08-to-2026-07-21.json`.

**Cleanup:** `scripts/add-leave-shift-exclusion-and-auto-revert-fields.sql` (the BB-054
migration, confirmed applied) is disposable per this repo's established pattern (see
`b8de353 chore: remove applied migration scripts and outdated docs`) — a candidate for
deletion, unlike the archive-generation files above, which stay since they're the live
generator for `PayrollExport`/`PayrollExportBatch`, not a one-time schema bump.
