# Changelog — v2.10.49

> **BB-098** — leave credits by fiscal year: automatic grants, regularization and expiration, with
> reminders before credits expire. It is off for every company until an admin runs the setup preview
> and Apply. **PadPro is set up** (applied 2026-10-21): 40h per fiscal year from Jan 1, monthly accrual
> starting January 2027, 2-year lifetime, 60-day reminder, and a 20h catch-up at 6 months. The admin
> balance matrix now also returns each employee's fiscal-year breakdown (`creditLots`), and there's a
> new leave report endpoint (`GET /api/reports/leave`).
>
> **BB-101** — Lennie Capulong (PadPro, Staff Supervisor) was missing a punch on Sunday 10/11/2026. It
> was added with a one-off script as 08:00 AM → 05:00 PM, Regular, 9h with no lunch.
>
> **BB-102** — admins, superadmins and supervisors can add, edit and delete the lunch on an employee's
> completed punch. Hours are recomputed, and the Cutoff page shows them.
>
> **BB-089 (rework)** — fixed-hours employees (SV) still get their flat 80h for scheduled duty, but work
> on an **off day** (no scheduled shift) is no longer auto-excluded. It goes to the admin for approval,
> and approved off-day hours are paid as **OT** on top of the 80h.
>
> **BB-103** — Upload Schedule (for BNC): a date range of up to 14 days, a pre-filled template, marking by
> existing shifts or by time blocks, and Replace or Skip on conflicts. Overnight overlaps are now detected.
>
> **BB-104** — Cutoff Approvals (B&C): "Approve Schedule" should be greyed out when the employee has no
> schedule that day. Client-only; the server already sends `availableShifts`. Waiting on the client to confirm.

---

## BB-098 — Leave credits: fiscal-year grants, regularization, expiration ✅ Complete (server; PadPro set up)

**Why:** a PadPro fiscal year is worth 40h of sick leave. Hours not used within the credit lifetime
should expire, and employees should be reminded ahead of time. Before this change balances were a
single number with no record of when each hour was granted. The old accrual worker never ran:
`accrualEnabled` couldn't be set, and every policy was forced to `accrualFrequency: "none"`.

### The rule

- Company-wide, with two separate toggles: **Leave Grant** (yearly lump or monthly accrual of
  `leaveGrantHours`) and **Leave Expiration** (credits stay usable for `leaveCreditLifetimeYears`
  fiscal years, counting the year granted, then expire at that fiscal year's end).
- Balances are tracked as fiscal-year lots (`LeaveCredit`). Leave usage takes the oldest lot first,
  and a cancelled leave gives hours back to the same lots (`LeaveCreditUsage`).
- **Regularization:** credits start `leaveRegularizationMonths` after `User.hireDate`. On that date:
  - yearly mode: `none` (wait for the next FY), `prorated` (months left in the FY ÷ 12) or `full`
  - monthly mode: `none` (accrual starts next month) or `catch_up` (the waiting period's worth at once)
  - Catch-up hours belong to the fiscal year of the regularization date.
  - Employees regular before setup get nothing extra; their credits are in the opening balance.
  - A waiting period with no hire date: the employee is skipped and listed in the setup preview.
- **Setup:** a preview shows how existing balances split into fiscal-year lots (40h chunks, newest
  first, the same rule as `check-bb098-padpro-leave-balances.js`). Apply saves the settings, creates
  the lots, expires anything past its lifetime (with ledger rows), and marks the current grant period
  as already granted.
- Fiscal year start and grant mode are locked after setup. Changing the lifetime only affects new
  fiscal-year lots.

### Schema — `add-bb098-leave-credit-expiration.sql` (applied to the shared DB; script removed)

- `Company`: 9 settings plus `leaveCreditsInitializedAt`. `leaveYearStartMonth` is reused;
  `accrualEnabled` / `newEmployeeCatchUp` are left in place but no longer read.
- `LeaveBalance`: `lastGrantPeriod`, `regularizationGrantedAt`.
- New tables: `LeaveCredit`, `LeaveCreditUsage`.
- Enums: `LeaveTransactionType.expired`, `NotificationCode.LEAVE_CREDITS_EXPIRING`, new
  `LeaveGrantMode`, `LeaveRegularizationGrant`.

### Code

- **New `services/Leave/leaveCreditService.js`:** fiscal-year math, lot add/consume/restore,
  expiration, reminders, grants, setup preview/apply.
- **New `workers/leaveCreditWorker.js`:** hourly, idempotent, per-company timezone; expire → remind →
  grant. It replaces `leaveAccrualWorker.js`, which has been removed (along with
  `leaveUtils.monthlyIncrement`).
- **New `controllers/Features/leaveCreditSetupController.js`** and routes
  `POST /leave-balances/credit-setup/{preview,apply}`.
- **`leaveApprovalService.applyLeaveApproval`:** paid hours are taken from lots once setup is done.
- **`Cutoff/leaveConflictCredit`:** the credit-back restores lots.
- **`leaveBalanceController.adjustBalance`:** now one transaction per leave type; it adds to the
  current FY lot or takes from the oldest. `listMatrix` gains `expired`.
- **`leaveController.listBalances`:** `expired`, `creditLots`, `nextExpiration`; `credits` includes
  expired.
- **`companySettingsController`:** new fields on GET/PATCH, plus the toggle rules.
- **`server.js`:** schedules `leaveCreditWorker` in place of `leaveAccrualWorker`. **`docs/CLAUDE.md`:**
  the workers table is updated.

Before setup none of the lot code runs, so companies that never turn this on behave exactly as
before.

**Client contract:** see `docs/CLIENT_LEAVE_CONTRACT.md` → BB-098.

### Follow-up — `creditLots` on the admin balance matrix

`GET /leave-balances/matrix`: every cell also returns
`creditLots: [{ fiscalYear, label, remainingHours, expiresOn }]`, oldest first (same shape as
`/leaves/balances`). It is `[]` until setup is applied.
- Unlike `/leaves/balances`, fully used years are included at `remainingHours: 0`. Expired years are
  left out. A lot that a cancelled leave refilled after expiry stays until the worker expires it again.
- Sum of `remainingHours` = `available` whenever `available >= 0`. A negative (debt) balance has every
  year at 0.
- `leaveBalanceController.listMatrix` loads the company's credit settings and adds one `LeaveCredit`
  query to the existing `Promise.all`.

Answers to the client's questions (also in `docs/client-handoff-BB-098.md` §4):
- `LEAVE_CREDITS_EXPIRING` reminders are sent by the hourly worker, never by Apply. An employee already
  inside the window at Apply gets it within about an hour.
- No notification is sent when hours expire, at Apply or by the job. Only the `expired` ledger row is
  written. A notification for that is a possible follow-up, not built.

### Follow-up — Leave reports (`GET /api/reports/leave`)

The client's request: Generate Report from Company Settings → Leave Settings. The server returns JSON
and the client builds the CSV / PDF / XLSX files. There are five types, sharing one set of filters:
`summary` (balances as of a date), `activity` (credited / used / adjusted / expired / unpaid per
month, quarter or year, on a calendar or fiscal basis), `expiration` (fiscal-year lots and their expiry
state), `requests` (leave requests in a range) and `ledger` (raw `LeaveTransaction` rows).

- **Scope:** admin and superadmin see the whole company. **Supervisors see their own department only.**
  Another department or employee returns 403, and so does a supervisor with no department.
- **Ledger rules:** `accrual` → granted. `deduction` → used. An `adjustment` with `leaveId` (cutoff
  credit-back) nets used. An `adjustment` without `leaveId` → adjusted. `expired` → expired.
  `creditedHours` = granted + positive admin adjustments, because every credit made before setup is an
  adjustment.
- **As-of balances** are anchored on today's `LeaveBalance` minus the changes after the date. This
  stays correct for balances that existed before the ledger.
- **`activity`:** hours follow the ledger entry date. `unpaidHours` follows the leave day (`LeaveDay`).
  The range is capped at 5 years, for `ledger` too.
- **New column `LeaveCredit.expiredHours`** (`add-bb098-leave-credit-expired-hours.sql`, applied to
  the shared DB; script removed). `expireLot` increments it, so a lot's used hours = granted − remaining −
  expired. No backfill: nothing has expired yet.

| File | Change |
|---|---|
| `src/services/Reports/leaveReportService.js` | New. Filters, scope, and the five report builders |
| `src/controllers/Reports/leaveReportController.js` | New. `getLeaveReport` |
| `src/routes/Reports/leaveReportRoutes.js` + `src/routes/index.js` | New route, mounted under `/api/reports` |
| `src/services/Leave/leaveCreditService.js` | `expireLot` writes `expiredHours`, and `fyStartStr` is now exported |
| `src/prisma/schema.prisma` | `LeaveCredit.expiredHours` |

**Client contract:** `docs/client-handoff-BB-098-reports.md`. It answers the client's four questions and
lists where the response differs from their draft.

### Status — ✅ complete on the server (PadPro set up 2026-10-21)

- Pre-Apply backup: `scripts/backup-bb098-padpro-leave-credits-pre-apply-2026-10-21.json`, written by
  `backup-bb098-padpro-leave-credits-pre-apply.js`. The last ledger row in it is
  `cmvh2lc1l2gr7td4ur6nndkj8`.
- Both SQL scripts (`add-bb098-leave-credit-expiration.sql`, `add-bb098-leave-credit-expired-hours.sql`)
  have already run on the shared prod DB and were deleted afterwards. Nothing schema-related is left to
  do before the deploy.
- Setup was applied 2026-10-21 from a local server, because local and prod share one DB. Apply
  expired only Eduardo Aviso's 4.75h (FY2024). The grant mode was then corrected to monthly; see the
  fix below.
- Final settings: 40h per fiscal year, FY starts Jan 1, monthly accrual (3.33h on the 1st, starting
  **Jan 1, 2027**), 2-year lifetime, 60-day reminder, 6-month regularization with a 20h catch-up.
  Both toggles are on.
- What happens next:
  - **Nov 1, 2026:** the `LEAVE_CREDITS_EXPIRING` reminder goes to 6 employees for 99h of FY2025 Sick
    Leave (Eduardo Aviso 40h, Josefina Chavez 35.25h, Fetsy Padernal 10h, Shirley Capati 7.75h,
    Jasbleidi Mendoza 3.75h, Arnold Capati 2.25h). It's in-app plus a phone push, with no email.
  - **Jan 1, 2027:** whatever is left of those FY2025 hours expires, and the first monthly accrual
    lands.
- Fetsy Padernal and Robert Ramirez have no hire date, so they get no automatic grants until one is
  set.
- **Deploy v2.10.49 soon.** Until it's on prod, a leave approved or cancelled there, or a balance
  adjusted there, doesn't update the per-year credit records. Only a server running this code runs
  the hourly leave job.
- **Open follow-up (do before Jan 1, 2027):** expiry only touches lots with hours left. A fiscal year that
  was fully used before its expiry date stays at `remainingHours: 0` with `expiredAt: null`, so the matrix
  and the leave report keep showing it as a 0h year forever. The fix is to leave out lots whose
  `expiresOn` has passed. It's about one line in each query.
- **Not built (possible follow-ups):** a notification when hours actually expire, and email reminders.

### Fix — PadPro applied with the wrong grant mode

- Setup was applied on 2026-10-21 with Yearly lump sum and Regularization = Full. It should have been
  Monthly accrual (40h / 12 per month) and Catch up (20h on the regularization day). PadPro's FY2026
  40h is already in the opening balances, so monthly accrual starts **January 2027**.
- The check (`check-bb098-padpro-grant-mode.js`) found nothing to reverse. Setup wrote no grants, no
  regularization grants, no leave usage and no adjustments. The only expired row was Eduardo Aviso's
  4.75h (FY2024). All 96 balances are marked `FY2026`.
- Code (`leaveCreditService.runGrants`): the "already granted" check now also accepts a **later**
  period (`periodCovered`), so a balance marked `2026-12` isn't granted October or November. Before,
  any key that didn't match the current one triggered a grant. The claim now matches the exact
  previous value.
- Data (`fix-bb098-padpro-monthly-accrual.js`): sets the grant mode to monthly accrual and
  regularization to catch up, and changes the markers from `FY2026` to `2026-12`. It has a dry run,
  `--apply`, `--revert` and a backup. Whatever server runs the hourly leave job must have the
  `periodCovered` change. Otherwise it grants October's share on its next run.
- **Applied 2026-10-21 (PT)** on the shared prod DB, from local code that has the change. Prod's old
  code doesn't run the leave job, so no deploy was needed first. The
  re-check showed `monthly_accrual` / `catch_up`, 96 balances at `2026-12`, no grants, and only the one
  expired row. The first monthly accrual is January 2027.

**One-off scripts (kept in `scripts/`, untracked):**
- `check-bb098-padpro-leave-balances.js` (CSV expiration forecast)
- `backup-bb098-padpro-leave-credits-pre-apply.js` + `backup-bb098-padpro-leave-credits-pre-apply-2026-10-21.json`
- `check-bb098-padpro-grant-mode.js` (read-only) and `fix-bb098-padpro-monthly-accrual.js` + `backup-bb098-padpro-monthly-accrual.json`

---

## BB-101 — Missing punch for Lennie Capulong, Sunday 10/11/2026 ✅ Done (data fix)

**Why:** Lennie Capulong (PadPro, Staff Supervisor, user `cmnei2ajg0091nr4u2p5cc7rf`) had no punch on
Sunday 10/11/2026.

**Checked first** (`check-bb101-lennie-oct11.js`, read-only): no punch, punch request or leave on 10/11,
and no schedule (Sunday). The covering cutoff `cmuhqsh4e07czsj50nfvbfbdy` (2026-09-30 → 2026-10-13,
Staff Supervisor) was **locked**, and the user reopened it before the fix. Approving a Request Punch Log
does not check for a locked or processed cutoff, so the reopen was required.

**Fix** (`fix-bb101-lennie-oct11-add-punch.js`, dry run / `--apply` / `--revert`):
- Created a completed REGULAR TimeLog 08:00 AM → 05:00 PM America/Los_Angeles (15:00Z → 00:00Z), the
  same way an approved Request Punch Log does (`lunchBreak {}`, `autoLunchDeductionMinutes 0`). That
  makes 9h net, since PadPro's minimum lunch is 0.
- Ran `computeTimeLogSummary` and added a pending `TimeLogApproval` in the cutoff.
- The punch is visible on the Cutoff page (confirmed by the user).

**Note:** Lennie is on BB-089 fixed hours. With the BB-089 rework below, this Sunday counts as an
**off day** (she has no schedule plotted, so the weekend rule applies). The punch stays pending and is
paid as OT if approved, instead of being auto-excluded. The cutoff was left open for that. Re-lock it
after review.

No code change.

**One-off scripts (kept in `scripts/`, untracked):**
- `check-bb101-lennie-oct11.js`
- `fix-bb101-lennie-oct11-add-punch.js`
- `backup-bb101-lennie-oct11-add-punch.json`

---

## BB-102 — Admin add / edit / delete lunch on a punch ✅ Server complete (client pending)

**Why:** admins couldn't fix a wrong or missing lunch on an employee's punch. The only admin break
action removed *auto-injected* breaks, so lunch corrections were one-off scripts (Alec Duna 08/28,
Beverly 10/08, Jasbleidi 09/25 from BB-092).

### Endpoints (admin, superadmin, supervisor)

- `PUT /api/timelogs/:id/lunch-break`, body `{ start, end }` (ISO). Adds the lunch, or replaces it.
- `DELETE /api/timelogs/:id/lunch-break`. Removes any lunch: punched, admin-added or auto-injected.

### Allowed only when

- The punch is in the admin's company and is completed (it has a clock-out).
- `start < end`, and both are inside clock-in and clock-out.
- The punch is not in a locked or processed cutoff (`getLockedCutoffForLog`).
- No `TimeLogApproval` for the punch is past `pending`. Approved hours are stored on the approval and
  wouldn't follow the recompute (the BB-040 risk), so the admin resets the approval on the Cutoff page first.

### What it writes

- `lunchBreak = { start, end, editedBy, editedAt, previous }`. `previous` is the lunch it replaced,
  because TimeLog has no audit trail of its own. Delete sets `lunchBreak` to null and logs the removed
  value to the server log.
- It clears `autoLunchApplied` and `autoLunchDeductionMinutes`. The explicit deduction override is also
  the "no lunch" marker the data fixes use, and it would otherwise ignore the new lunch.
- It then runs `computeTimeLogSummary`. Regular punches deduct `max(lunch, minimumLunchMinutes)`.
  Driver/Aide punches deduct the lunch from the segment it falls in (BB-092). Pending Cutoff rows read
  these TimeLog fields live, so the Cutoff page shows the new hours on its next load.
- A socket `timeLogUpdated` is sent to the employee, with type `lunchBreakEdited` or `lunchBreakDeleted`.

After a delete, the company's `minimumLunchMinutes` rule applies again, the same as for a punch that never
had a lunch. PadPro's minimum is 0.

This also unblocks the BB-092 open item: Jasbleidi's 09/25 lunch can now be corrected from the app.

**Code:** `src/controllers/Features/timeLogController.js` (`upsertLunchBreak`, `deleteLunchBreak`),
`src/routes/Features/timeLogRoutes.js`. No schema change. **Client handoff:** `docs/client-handoff-BB-102.md`.

---

## BB-089 (rework) — Fixed-hours employees: off-day work is approvable OT ✅ Server complete (client pending)

**Why:** fixed-hours employees (SV staff) had **every** pending punch auto-excluded, and the payroll export
forced their OT to 0. Work on a day off, such as Lennie Capulong's Sunday 10/11 (BB-101), could never be
approved or paid. The flat 80h is meant for scheduled duty only: 10 working days × 8h in a two-week cutoff.

### The rule

- **Scheduled day** (the employee has a non-cancelled `UserShift` that date): covered by the flat hours,
  including running past the shift end. Pending punches are auto-excluded, as before
  (`FIXED_HOURS_NOTE`).
- **Off day** (no `UserShift` that date, in the company timezone): the punch stays **pending** with
  `OFF_DAY_NOTE` ("Off-day work (BB-089) — paid as OT if approved"). The admin approves or excludes it.
  - An off-day punch that was auto-excluded earlier goes back to pending. That covers punches in
    cutoffs that are still open, Lennie's Sunday included.
  - Pending off-day punches now **block lock/finalize** until they're decided, like any other pending
    punch.
- **Approved off-day hours = OT, with no threshold**, on both the `cutoff` and `daily` bases. Scheduled-day
  hours never count toward their OT. It creates the usual `CutoffOtBlock`, pending until the admin
  approves it.
- **No schedule plotted** (common for SVs; Lennie shows "0h scheduled" on every day): when a
  fixed-hours employee has no `UserShift` at all in the cutoff, **Saturday and Sunday** count as off days
  and Mon–Fri as scheduled. This matches the flat 80h assumption of 10 weekdays × 8h, and a missing
  schedule can't turn every punch into an OT request.
- Unchanged: the flat hours include paid leave (regular = flat − leave), and rows are editable.

### Code

| File | Change |
|---|---|
| `src/services/Cutoff/fixedHoursService.js` | New `OFF_DAY_NOTE`, `getOffDayTimeLogIds(cutoffPeriod, userIds)`. `applyFixedHoursForCutoff` excludes scheduled-day punches only, reopens or marks off-day ones, and clears the marker for ex-members |
| `src/services/Cutoff/cutoffOtService.js` | `computeOtForCutoffBasis` / `computeOtForEmployeeDay`: for a user with a `CutoffFixedHours` row, count only approved off-day hours, with threshold 0 |
| `src/services/Payroll/payrollExportService.js` | Fixed-hours rows no longer zero `ot`. The approved off-day OT block is exported on top of the flat regular hours |
| `src/controllers/Features/cutoffPeriodController.js` | `getCutoffApprovals`: new `isOffDay` on each approval. The OT block `breakdown` for fixed-hours employees lists off-day days only, with `threshold: 0`. `getCutoffSummary`: fixed-hours `overtimeHours` = approved OT blocks, and `totalHours` = flat + OT |

No schema change and no database script.

### API / client impact

- `GET /api/cutoff-periods/:id/approvals`: each approval gains **`isOffDay: boolean`**. It is true for a
  fixed-hours employee's punch on a day with no scheduled shift.
- For fixed-hours employees, off-day approvals now arrive as `status: "pending"` with
  `notes: "Off-day work (BB-089) — paid as OT if approved"`. Before, everything arrived `excluded`.
- `otBlocks[]` can now include fixed-hours employees (`isFixedHoursEmployee: true`). Their
  `breakdown.threshold` is 0, and `breakdown.days` lists only off-day dates.
- Client work on the Cutoff page:
  - Show Approve/Exclude on a fixed-hours employee's row when `isOffDay`, with an "Off-day · OT" badge.
  - Stop treating every fixed-hours punch as read-only.
  - Show their OT block approval.
- Cutoff summary: `overtimeHours` for fixed-hours employees can now be above 0.

### Test checklist

1. Lennie, cutoff 2026-09-30 → 2026-10-13 (left open for this; she has no schedule, so the weekend rule
   applies): the Sunday 10/11 punch is pending with `isOffDay: true`. Her weekday punches stay excluded.
2. Approve the Sunday punch with **Edit at 8h** (the user's call: the 8–5 punch counts as 8h). An OT block
   of 8h appears, pending. Approve it. Leave her fixed-hours row at 80.
3. Cutoff summary: Lennie shows regular 80 (minus any paid leave), OT 8, and total 88.
4. Lock the cutoff. It is blocked while an off-day punch is still pending.
5. Process it. The payroll export has Lennie at Regular 80, OT 8.
6. A fixed-hours employee **with** a schedule: a punch on a date with no shift is pending as off-day, and
   a punch on a scheduled date stays excluded, even when it is a weekend shift.


---

## BB-103 — Upload Schedule (rework of Upload Weekly Schedule, for BNC) ✅ Server complete (client pending)

**Why:** the weekly upload always covered 7 days and came with an empty template. The only way to mark
time was 46 half-hour blocks, and every import created new `Shift` records, even when an identical shift
already existed.

### The rule

- **Date range:** start and end date, at most **14 days**.
- **Template:** pre-filled, with one row per active employee × date. It can cover everyone in scope, one
  department, or specific people. Its columns are `email, name, date`, and rows match on email.
- **Two marking modes:**
  - **`time_blocks`:** the 46 half-hour columns, as before. A matching existing Shift (same times and
    name) is reused instead of creating a duplicate.
  - **`shifts`:** one column per picked existing Shift. A `1` assigns that Shift on that date. No `Shift`
    records are created.
- **Blank rows** are skipped and counted.
- **Overlaps:** an overnight shift spills into the next date. Overlaps are checked within the file and
  against existing (non-cancelled) assignments.
- **Statuses:** each preview item is `ready`, `conflict_existing`, `conflict_file` or `error`, with
  server-decided `allowedActions`.
- **Replace** deletes the clashing assignments and creates the new one, in one transaction per item. The
  employee gets `SCHEDULE_REPLACED`. Replace is blocked when the existing assignment:
  - is completed
  - belongs to an employee with punches that day
  - falls in a locked or processed cutoff
- **Limit:** 2,000 rows per file.

### Code

- **`src/utils/csvScheduleParser.js`:**
  - shift-mode header building and parsing (`shiftColumnHeaders`, strict marks)
  - `normalizeDate` (accepts `M/D/YYYY`)
  - pre-filled `buildTemplateCsv` with a BOM
  - `mergeBlocksToTimeRanges` returns `[]` for a blank row instead of throwing
- **`src/services/Features/scheduleImportService.js`:**
  - new `buildScheduleTemplate`, `previewSchedule` and `confirmSchedule`
  - existing assignments, punches and locked cutoffs are loaded in one query each per request
  - overlaps are compared on an absolute minute timeline
  - the old `rows` preview and confirm are kept for the current client
- **`src/controllers/Features/scheduleImportController.js`:**
  - routes on `mode`; without it, the old flow runs
  - confirm returns 200, or 207 when anything failed
- **`app.js`:** `/api/schedule-import/confirm` accepts JSON bodies up to 5 MB. The default is 100 KB,
  and the confirm request echoes every preview item back.

**Fixed along the way:**
- Supervisor scope never worked. `req.user` has no `departmentId`, so the preview showed the whole
  company and confirm failed every row.
- Overnight shifts never registered as overlapping.
- Cancelled assignments counted as conflicts.
- Inactive employees showed as "ready" in the preview.

### API / client impact

**Client contract:** `docs/client-handoff-BB-103.md`.
- The template, preview and confirm contracts all change. The old calls keep working until the new
  client ships: `weekStart`, a preview without `mode`, and a confirm with `rows`.
- No schema change, no SQL.

### Test checklist (BNC)

1. Download a shifts-mode template for 14 days with two shifts. Check that it has one row per employee
   per date and two shift columns.
2. Mark an overnight shift (7 PM–5 AM) on day 1 and a 4 AM shift on day 2 for the same person. Both
   should come back as `conflict_file`.
3. Mark a shift over an existing assignment. It should be `conflict_existing` with
   `allowedActions: ["skip","replace"]`. Replace it, then check that the old one is gone, the new one
   exists, and the employee got "Shift Changed".
4. Try to replace an assignment on a day the employee already punched. Only `skip` should be offered.
5. Rename a shift-column header and upload. It should return 400 "template is out of date".
6. Upload a time-blocks file twice with the same times. The second import should reuse the Shift
   created by the first.
7. As a supervisor: other departments' employees are rejected, and your own department imports
   correctly.
8. Save the template in Excel (dates become `10/26/2026`) and upload it. It should parse correctly.

---

## BB-104 — Cutoff Approvals: "Approve Schedule" greyed out when there's no schedule (B&C) ⏳ Client-only, awaiting client confirmation

**Report:** on B&C, clicking "Approve Schedule" does nothing when the employee has no shift assigned on
the punch's date. There are no shifts to pick from.

**Server:** no change. The cutoff approvals response (`cutoffPeriodController`, B&C block) already sends
`availableShifts` on every approval. It is `[]` when no non-cancelled shift is assigned on the punch's
date in the company timezone. The B&C strategy already rejects approve-schedule without a `shiftId`
(400).

**Client:**
- Disable "Approve Schedule" when `availableShifts` is empty, with a tooltip.
- Approve Raw, Edit and Reject stay available.

The message to the client asks them to confirm the bug first: `docs/client-handoff-BB-104.md`.

---

## Release notes — v2.10.49

- **Database:** nothing to run. Both BB-098 SQL scripts were already applied to the shared DB, and
  BB-102, BB-089, BB-103 and BB-104 have no schema change.
- **Deploy soon.** PadPro's leave credits are already set up, so leave approvals, cancellations and
  balance adjustments on prod need this code to keep the per-year credit records in step. The
  FY2025 expiry reminders go out on **Nov 1, 2026** only from a server running this version.
- **Branch:** create `release/v2.10.49` before committing. Leave `.DS_Store` and `.vscode/` out of the
  commit. The one-off `scripts/` files stay untracked, as usual.
- **Client work pending:** BB-098 (credit lots, settings, reports, the `LEAVE_CREDITS_EXPIRING`
  notification), BB-102, BB-089, BB-103 and BB-104. Each one's handoff doc is listed in its section.
