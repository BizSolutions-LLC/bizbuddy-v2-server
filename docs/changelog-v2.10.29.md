# Changelog — v2.10.29

> Three related tickets on the cutoff/timelog approval pipeline, all shipping together in
> `release/v2.10.29`:
> - **BB-056** — unpaid leave counted as full payable hours on the cutoff page.
> - **BB-057** — excluded segments never synced back to TimeLog, and the day-level cutoff
>   status stayed stuck on "Pending" even once fully decided.
> - **BB-058** — the Punch Logs summary row showed raw clock-in/out instead of the approved,
>   schedule-adjusted time.
>
> All three are server-side fixes only; each has client-repo follow-up work still pending
> (see each section's Open Items). None of the three needed a schema/migration change.

---

## API Contract Change

### BB-056 — Cutoff Approvals Don't Distinguish Paid vs. Unpaid Leave

**Files:** `src/controllers/Features/cutoffPeriodController.js`

**Problem:** On `GET /api/cutoff-periods/:id/approvals`, standalone leave rows (an approved leave
day with no matching punch) reported `hours` as the employee's *scheduled* hours for that day,
regardless of whether the underlying `Leave` was paid or unpaid. A fully unpaid multi-week Vacation
Leave (`Leave.isPaid: false`) rendered identically to worked/paid time and rolled into the
per-employee `PAYABLE` total on the cutoff page.

**Root cause:** `Leave.isPaid` is only the *submitted intent* for the whole request; the real
per-day outcome is written to `LeaveDay` (`isPaid` per calendar date) by
`applyLeaveApproval()` (`src/services/Leave/leaveApprovalService.js`) at approval time — including
split days, where a paid leave that exhausts `LeaveBalance` mid-day produces **two** `LeaveDay` rows
for the same date (one `isPaid:true`, one `isPaid:false`). The cutoff Approvals response never
queried `LeaveDay` at all: the full `Leave` record (including `isPaid`/`actualPaidHours`/
`actualUnpaidHours`) was already nested in each row's `leave` object, but the `hours` value driving
`PAYABLE` had no concept of "payable" — it was schedule-derived only, with no field a client could
sum unambiguously.

Separately, punch rows carrying a leave-conflict flag (`hasLeaveConflict`, `leaveRecord`/
`pendingLeave`) exposed only `{id, leaveType, status}` — no paid/unpaid info at all, unlike the
standalone-row case.

**Fix:** Purely additive — no schema or migration changes, `LeaveDay` already existed and was
already being populated at approval time.

- Batch-fetch `LeaveDay` rows for every approved leave in the period and sum paid hours per
  `(leaveId, date)`.
- Add a new `payableHours` field to each standalone `leaves[]` row — the real payable amount for
  that day (`0` for unpaid, partial for split days, matches `hours` for a normal fully-paid day).
  Leaves approved before `LeaveDay` existed (no rows found) fall back to `leave.isPaid` deciding
  full scheduled hours vs. `0`, so pre-existing paid leave isn't silently zeroed out.
- Add `isPaid` (`leaveRecord`/`pendingLeave`) and `actualPaidHours`/`actualUnpaidHours`
  (`leaveRecord`, approved case only) to punch-row leave-conflict objects, for consistency with
  standalone rows.

**Verified:** confirmed live against an employee (approved Vacation Leave, `isPaid: false`,
`0h used` against balance) whose cutoff page showed `8h`/day rolled into a `104h` `PAYABLE` total;
traced to `getCutoffApprovals` as the only endpoint capable of producing that row (the plain
`GET /:id` and list endpoints never query `Leave` at all, so they were ruled out as the source).

**Client work still open:**
- `PAYABLE` totals are computed client-side by summing `hours`; the client must switch to summing
  `payableHours` for leave rows. Recommended as `row.payableHours ?? row.hours` so the client can
  ship independently of server deploy order without a rollout window where paid leave briefly
  displays as unpaid.
- Client may also want to badge a leave row "Unpaid"/"Partially Paid" when `payableHours < hours`,
  using the already-nested `leave.isPaid`/`actualUnpaidHours`.

**Broader payroll gaps identified but out of scope:** the legacy `/api/payroll` run system
(`payrollController.computeEntryForUser`) pays every approved leave day flat regardless of
`isPaid`; the newer `/api/payroll-system` engine has no leave awareness at all;
`AttendanceSummary.leavePaidHours`/`leaveUnpaidHours` are schema-only and never populated; cutoff
approval (`approveSingle`/`approveBulk`) still doesn't block approving a punch that conflicts with
an approved leave, it only flags it. None addressed here — flagged for a future ticket.

---

## Bug Fix

### BB-057 — Excluded Segments Never Synced Back / Day Status Stuck on "Pending"

**Files:** `src/controllers/Features/timeLogController.js`, `src/services/Cutoff/daycareCutoffStrategy.js`

**Problem (reported):** On the Punch Logs detail panel, a DRIVER_AIDE punch with an excluded
segment (e.g. Driver AM excluded, Regular approved, Driver PM excluded) kept showing the
excluded segment's raw pre-review hours (`0.17h`) instead of `-`/`0`, `Total Clock Hours`
included those stale hours, and the "Cutoff" badge stayed on `Pending` even though every
segment had an explicit admin decision. Downstream, anything gating on that stale status
(e.g. the Punch Logs Actions column) kept treating a fully-decided day as still open.

**Root causes — three independent bugs, same symptom class:**

1. **`syncApprovedSegmentsToTimeLog`** (`daycareCutoffStrategy.js:36-72`) gated on
   `status: { not: "approved" }` — treating `excluded` the same as `pending`, i.e. still
   blocking. A day with any excluded segment could never reach `pendingCount === 0`, so the
   function that writes reviewed hours back onto `TimeLog.driverAmSegmentHours` /
   `regularSegmentHours` / `driverPmSegmentHours` / `netWorkedHours` never fired — those
   fields stayed stuck at their original `computeTimeLogSummary` (pre-review) values
   indefinitely.
2. **`getCompanyTimeLogs`** (`timeLogController.js`, `/api/timelogs`) only ever returned the
   single most-recently-created `TimeLogApproval` row per punch as `cutoffApproval`, with no
   per-segment matching and no day-level aggregation. A punch's real decision status was
   whichever row happened to be "most recent," which is meaningless on a mixed-outcome day.
3. **`syncApprovalRecords`'s `skipDuplicates` insert has no real DB unique constraint behind
   it** (contested during investigation — see Open Items), so a later re-sync can leave a
   stray fresh `pending` row sitting alongside already-decided rows for the same segment,
   which the old single-most-recent-row logic could pick over the real decision.

**Fix:**

- `syncApprovedSegmentsToTimeLog` (`daycareCutoffStrategy.js:40-72`): gate changed to
  `status: { notIn: ["approved", "excluded"] }` — excluded is now correctly terminal, not
  blocking. Write-back logic changed to explicitly write `0` for an excluded segment's hours
  instead of silently skipping that field (previously, even once the gate passed, an
  excluded segment's `TimeLog` field was never touched — it stayed stale).
- `getCompanyTimeLogs` (`timeLogController.js`): added `segmentApprovals` — all of a punch's
  `TimeLogApproval` rows, deduped per `segmentType` (preferring a decided row over a stray
  pending duplicate). Added `dayCutoffStatus` — a single day-level aggregate derived from the
  deduped set: `"pending"` if any segment is still undecided, `"approved"` if every segment
  is terminal (approved and/or excluded — meaning "decided," not "everything was payable"),
  `null` if the punch has no approval rows yet. The legacy `cutoffApproval` field is left
  unchanged for backward compatibility; client should migrate reads to `segmentApprovals` /
  `dayCutoffStatus`.

**Backfill:** fixing the gate only helps future approvals — already-decided-but-stuck
`TimeLog`s needed a one-time correction. Wrote (did not run) two scripts following the
existing `backfill-syncback-cutoff-jun10-23.js` dry-run/`--apply`/`--revert` convention:
- `scripts/backfill-syncback-evelyn-jul8.js` — single-record sanity check, run first to
  confirm the corrected logic against one known example before trusting the broad run.
- `scripts/backfill-syncback-excluded-segments.js` — full backfill, all companies/periods
  (unlike the earlier Jun 10-23 script, this one specifically includes sets with an excluded
  segment rather than skipping them). **Run and applied** — 322 already in sync, 377 updated.

**Verified:** confirmed live against Evelyn Garnace's Jul 8 2026 punch (Driver AM excluded,
Regular approved) before and after the sanity-check script; confirmed against Arnold
Capati's Jun 25 2026 punch (Driver AM excluded, Regular + Driver PM approved) as the
Actions-column/badge symptom case. `Total Clock Hours` confirmed correct post-backfill.

**Client work still open:**
- Match segment hours to `segmentApprovals` by `segmentType` and render excluded segments as
  `-`/`0`, excluded from `Total Clock Hours`.
- Point `CutoffApprovalBadge`, and whatever gates the Punch Logs Actions column, at
  `dayCutoffStatus` instead of the legacy `cutoffApproval.status`.

**Data-model gaps surfaced but not fixed:**
- **Overlapping cutoff periods, no safeguard.** `createCutoffPeriod`'s overlap check
  (`cutoffPeriodController.js:274-289`) and the auto-generation job only compare periods within
  the *same* `departmentId` scope; a company-wide (`departmentId: null`) period and a
  department-scoped period can legitimately cover the same dates for the same company with
  nothing preventing it. If that happens, `syncApprovalRecords` creates a fully independent set
  of `TimeLogApproval` rows per period for the same punch, and there is no canonical rule for
  which period "wins" when `getCompanyTimeLogs` reports a single `dayCutoffStatus`/
  `segmentApprovals` for that punch (current code doesn't scope by `cutoffPeriodId` at all — a
  correctness gap on its own, separate from this bug, not yet fixed). Needs a business-rule
  decision before it can be addressed in code.
- **Unresolved contradiction on `TimeLogApproval` duplicate prevention.** One investigation this
  session concluded no real DB unique constraint backs `syncApprovalRecords`'s `skipDuplicates`
  insert (no migration ever creates it); a second concluded a partial unique index does exist
  per `docs/changelog-v2.7.5.md`, applied via a since-deleted one-off script (this project
  applies schema changes via disposable raw SQL scripts, not tracked migrations). Not resolved
  directly against the live DB — worth confirming before more work assumes either answer.

---

### BB-058 — Punch Logs Summary Shows Raw Clock Time Instead of Approved Time

**Files:** `src/controllers/Features/timeLogController.js`

**Problem (reported):** On the Punch Logs page, an employee's day summary (e.g. "07/08/2026
06:47 AM → 07/08/2026 02:19 PM") didn't match the approved times shown in the Cutoff Review
breakdown for the same day ("In: Jul 8, 6:45 AM → ... → Out: Jul 8, 2:45 PM"). Reproduced
across multiple employees/dates (Josefina Chavez Jul 8/17, Daynee Cuaresma Jul 10) — the
raw punch time was always used for the summary row, and it can diverge from the approved
time on **either end**: a slightly-late clock-in on `driver_am` still displays the scheduled
start (6:45 AM) once approved, and an early clock-out on `driver_pm` still displays the
scheduled end (2:45 PM) once approved in schedule mode.

**Root cause:** Raw `TimeLog.timeIn`/`timeOut` are — correctly, by design — never modified by
approval; they stay ground truth. Schedule-mode segment approval (`daycareCutoffStrategy.js`,
pre-existing behavior, not changed here) sets `TimeLogApproval.approvedClockIn`/
`approvedClockOut` to the segment's scheduled window boundary rather than the raw punch time
when appropriate (`driver_am`/`regular` always; `driver_pm` only when the actual clock-out
was early — a late clock-out already matches raw, nothing to correct). Both `GET /api/timelogs`
and `GET /api/timelogs/user` selected raw `timeIn`/`timeOut` only and never exposed
`approvedClockIn`/`approvedClockOut` at all — the correct value existed in the DB the whole
time, but the list endpoints had no way to surface it.

**Fix:** Purely additive, both list endpoints, no schema change, no backfill needed (this is
a response-shape gap, not corrupted data — every existing record already has the correct
`approvedClockIn`/`approvedClockOut` sitting in `TimeLogApproval`).

- Added `approvedClockIn`/`approvedClockOut` to the `TimeLogApproval` select on both
  `getCompanyTimeLogs` and `getUserTimeLogs`.
- Added a day-level rollup, **`dayApprovedClockIn`** / **`dayApprovedClockOut`**, computed
  from the (BB-057-deduped) segment set: earliest **approved** segment's `approvedClockIn`
  (`driver_am` → `regular` → `driver_pm` priority) and latest **approved** segment's
  `approvedClockOut` (reverse priority). `null` when nothing in the relevant position was
  actually approved (a fully-excluded day, or a still-pending one) — in which case the
  client's fallback correctly shows raw time, since there's nothing else to show.
- Brought `getUserTimeLogs` up to full parity with `getCompanyTimeLogs` in the process: it
  still had the pre-BB-057 `take: 1`/no-dedup pattern, now also gets `segmentApprovals` and
  `dayCutoffStatus`.
- Refactored the BB-057 dedup/rollup logic (`dedupApprovalsBySegment`, `computeDayCutoffStatus`)
  out of `getCompanyTimeLogs` into shared module-level helpers alongside the new
  `pickApprovedClockTime`, so both endpoints share one implementation instead of drifting.

**Verified:** confirmed live against raw API responses for Josefina Chavez (Jul 8: raw
`timeIn` 6:47 AM / `dayApprovedClockIn` 6:45 AM; raw `timeOut` 2:19 PM / `dayApprovedClockOut`
2:45 PM — both correct) and a still-open, undecided day (Jul 22: `dayApprovedClockIn/Out`
correctly `null`, no fabricated value).

**Client directive sent:** wherever `t.timeIn`/`t.timeOut` is rendered as the day's summary
time (`EmployeesPunchLogs.jsx`, `PunchLogs.jsx` render cells only), swap to
`t.dayApprovedClockIn ?? t.timeIn` / `t.dayApprovedClockOut ?? t.timeOut`. Explicitly **not**
applied to the Edit Time In/Out dialog (must prefill from raw, or an edit would silently
overwrite the wrong baseline), Delete confirmation, sort/date-bucketing keys, or
`CutoffReview.jsx`/`buildRowsFromApprovals()` (different, pre-existing approved-time
mechanism).

**Client work still open:**
- CSV/PDF export scope undecided — `lib/exports/punchLogs.js` and
  `lib/exports/employeePunchLogs.js` render raw `timeIn`/`timeOut` directly and have the same
  underlying bug; client team flagged this as a separate scope decision rather than bundling
  into this ticket.
- `buildRowsFromApprovals()` raw-vs-approved mismatch — flagged during this investigation
  (client repo, `EmployeesPunchLogs.jsx`, used for the locked-cutoff report): takes
  `max(raw tl.timeOut)` across a day's segments despite a code comment claiming it reflects
  "what was actually reviewed." Related to this bug class but a distinct code path; client
  team said they'd track it separately.

---

## Files Changed

| File | Change |
|---|---|
| `src/controllers/Features/cutoffPeriodController.js` | BB-056: `getCutoffApprovals` — new `payableHours` on standalone leave rows (via `LeaveDay` lookup), `isPaid`/`actualPaidHours`/`actualUnpaidHours` on punch-row leave-conflict objects |
| `src/services/Cutoff/daycareCutoffStrategy.js` | BB-057: `syncApprovedSegmentsToTimeLog` gate now treats `excluded` as terminal; excluded segments explicitly write `0` instead of being skipped |
| `src/controllers/Features/timeLogController.js` | BB-057: `getCompanyTimeLogs` — new `segmentApprovals`/`dayCutoffStatus`. BB-058: `approvedClockIn`/`approvedClockOut` selected on both endpoints; new `dayApprovedClockIn`/`dayApprovedClockOut`; `getUserTimeLogs` brought to parity; shared helpers extracted to module scope |
| `scripts/backfill-syncback-evelyn-jul8.js` | BB-057: new, single-record sanity-check script (written, run manually) |
| `scripts/backfill-syncback-excluded-segments.js` | BB-057: new, full backfill script (written, run manually with `--apply`) |
