# Changelog — v2.10.26

> Cutoff Period "Raw" approval now honors the grace period for Driver-Aide segments and B&C, plus
> a display fix so the credited hours actually show up. BB-043 (Cutoff Review segment exclusion)
> investigated and root-caused — fix lands entirely in the client repo, no server changes.
> BB-048 widens the no-shift leave-day fallback to weekends/holidays and makes it time-window-aware;
> BB-045 lets a leave day split between paid and unpaid instead of stranding leftover balance.
> **Neither BB-048 nor BB-045 is committed, migrated, or deployed as of this writing** — both sit
> as uncommitted changes in this working tree, on top of the already-committed Leave Module
> Phase 1–5 + continuation work (`cd3d5a3`, `1bdc2f3`, already merged to `master`).

---

## Bug Fix

### BB-040 — "Raw" Approval Ignores Grace Period (Driver-Aide segments, B&C)

**Files:** `src/services/Cutoff/daycareCutoffStrategy.js`; `src/services/Cutoff/bncCutoffStrategy.js`;
`src/services/Cutoff/shiftLookupUtils.js` (new); `src/controllers/Features/cutoffPeriodController.js`

**Problem:** "Approve Raw" is supposed to preserve the employee's actual punch time for display,
while still crediting hours from the scheduled start when the punch falls within the company's
grace period — this already worked correctly for DayCare's REGULAR (non-segment) punches (fixed in
v2.10.17), but was never extended to two other raw-approval paths:

- **DayCare Driver-Aide segments** (`daycareCutoffStrategy.js`) — `approveSingle`/`approveBulk`'s
  DRIVER_AIDE branches computed `approvedIn = max(actualTimeIn, segmentStart)` with no grace
  comparison at all. A punch 10 minutes into a 15-minute grace window was credited from the actual
  punch, not the segment start.
- **B&C raw approval** (`bncCutoffStrategy.js`) — raw mode never snapped at all, by design (only
  "schedule" mode, which requires an admin-picked shift, applied grace). `actualHours` came straight
  from `netWorkedHours` (`src/services/strategies/bncStrategy.js`), which uses grace only for a
  separate `lateHours` reporting metric, never worked hours.

**Fix:**
- DayCare Driver-Aide segments (single + bulk): mirrors the existing REGULAR-path pattern — if the
  actual punch is within grace of `segmentStart`, the segment **hours computation** credits from
  `segmentStart`; `approvedClockIn` still stores the true raw punch for display.
- B&C (single, bulk, conflict "honor punch"): new `computeGraceCreditHours()` auto-detects the
  day's assigned shift and adds credited hours on top of `netWorkedHours` when the punch is within
  grace, without touching `TimeLog.timeIn`/`approvedClockIn`.
- New shared `shiftLookupUtils.js` — extracted `fetchScheduleForDate`/`combineDateTime` out of the
  DayCare-only-frozen strategy file so B&C could reuse the same day-shift lookup without duplicating
  it or reaching into a file explicitly commented "DayCare only."

**Related display bug found during verification:** `enrichApprovals()` (`cutoffPeriodController.js`)
recomputed DRIVER_AIDE segment hours live from `approvedClockIn`/`approvedClockOut` instead of
trusting the stored `actualHours` — since `approvedClockIn` intentionally stays the raw punch, this
always discarded the grace credit on the display side even though it was correctly written to the
DB. Fixed to prefer `approval.actualHours` for approved segments, matching the pattern already used
for non-segment punches, with the legacy timestamp-derived fallback preserved for older records.

**Verified:** Beverly Brazil, Piedmont Adult Day Program — Jul 14 Driver AM segment (window 6:45
AM–8:00 AM, actual punch 6:55 AM, 15-min grace). Confirmed via direct DB read that `actualHours`
was correctly credited to 1.25h while `approvedClockIn` retained the raw 6:55 AM punch; after the
display fix, the Cutoff Period Page correctly shows 1.25h.

**Not yet tested:** the B&C portion of this fix — B&C is not currently in active use; will be
ticketed separately if a real case is encountered.

---

### BB-048 — No-Shift Leave Days Widened to Weekends/Holidays, Now Time-Window-Aware

**Status:** Uncommitted, unmigrated, undeployed — layered on top of the existing uncommitted
BB-048 (Phase-1 cut) work already in this working tree (`fromTime`/`toTime` on submit/affected-schedules,
`Leave.requestedStartTime`/`requestedEndTime`, `isFallback` on `GET /api/leaves/affected-schedules`).

**Files:** `src/utils/leaveUtils.js`, `src/prisma/schema.prisma` (no further schema change beyond
what's already uncommitted), `docs/LEAVE_MODULE.md`, `docs/CLIENT_LEAVE_CONTRACT.md`

**Problem:** `calcDailyHours` excluded weekends and company holidays from deductible hours
unconditionally, before ever checking whether a real shift existed or a time window was submitted.
Confirmed real case: an employee submitted a Sunday-only leave request with an 8:00–12:00 window,
expecting 4h to be priced — the approver's preview showed `Total Hours: 0h` instead, because the
weekend exclusion ran before the no-shift fallback (added earlier in BB-048) ever got a chance to
apply. This exclusion predates BB-048 entirely and was untouched by the original no-shift-fallback
fix — it's a separate, deeper gate in the same function.

**Fix:** removed the `Holiday` table query and the `isWeekend`/`isHoliday` gate from
`calcDailyHours` entirely. Every calendar day in a leave range is now deductible — a real plotted
shift always wins regardless of the day of week; every other day (weekday, weekend, or holiday
alike, no distinction anymore) goes through the same fallback (entered time window capped at
`Company.defaultShiftHours`, or the flat default). `calcRequestedHours`, `previewLeaveApproval`/
`applyLeaveApproval`, and `getAffectedSchedules` all build on `calcDailyHours`, so they picked this
up automatically with no separate changes.

**Verified:** standalone re-derivation of `computeProration`'s day-walk against the reported case
confirmed the weekend day is now priced from the entered/default window instead of excluded.

---

### BB-045 — Leave Day Now Splits Between Paid and Unpaid Instead of Stranding Balance

**Files:** `src/prisma/schema.prisma`, `src/services/Leave/leaveApprovalService.js`,
`src/controllers/Features/leaveController.js`, `scripts/widen-leave-day-unique-constraint.sql` (new)

**Problem:** `computeProration` required a day's *entire* hours to fit within the remaining balance,
or the whole day fell to unpaid — a real approved request (35h available, 8 days × 8h) paid only 4
whole days (32h) and left 3h of balance permanently stranded, unable to partially cover the 5th day,
rather than paying 3h of it and marking the remaining 5h unpaid. Confirmed real: Antonette Franco,
Sick Leave, 7/24–7/31/2026, 64h total, 35h available, only 32h paid / 32h auto-unpaid.

**Fix:**
- `LeaveDay`'s unique constraint widened from `[leaveId, date]` to `[leaveId, date, isPaid]`
  (`scripts/widen-leave-day-unique-constraint.sql`, additive, no backfill — every existing row
  already satisfies the wider constraint since today there's exactly one row per date).
- `computeProration` rewritten: the one day where balance runs out mid-day now emits two entries
  sharing that date — a paid portion (whatever balance remained) and an unpaid portion (the rest)
  — instead of picking one side for the whole day. Every day before that point stays fully paid;
  every day after stays fully unpaid.
- `getLeaveDays` (`GET /:id/days`) now orders by `date asc, isPaid desc`, so a split date's paid row
  always lists before its unpaid row.
- `applyLeaveApproval`/`previewLeaveApproval` needed no changes — both already just map over
  whatever `computeProration` returns.

**Deliberately not addressed:** how a split day interacts with Phase 6's still-paused punch-wins
reversal, or with the still-deferred payroll/cutoff hour integration — both now have a slightly
harder open question ("which half of a split day") whenever they're eventually built. Noted in
`docs/LEAVE_MODULE.md`, not resolved here.

**Verified:** standalone re-run of the new `computeProration` against the Antonette Franco numbers
(35h available, 8×8h days) produced 35h paid / 29h unpaid, with the boundary day splitting 3h paid /
5h unpaid — matches the real case exactly.

---

## Investigated — No Server Changes

### BB-043 — Cutoff Review: Excluding One Driver/Aide Segment Excluded All Three

**Reported:** excluding a single Driver/Aide segment (driver_am/regular/driver_pm) appeared to
exclude all three; on reload, only the originally-clicked segment showed excluded while the other
two became unavailable.

**Investigation:** confirmed server-side that the single-segment exclude endpoint
(`PATCH /api/cutoff-periods/:id/approvals/:approvalId` → `approveSingle`'s exclude branch in both
strategy files) updates exactly one `TimeLogApproval` row by primary key — structurally unable to
affect sibling segments. No grouping/homogeneous-status assumption exists in the GET/list endpoints,
and no caching layer exists anywhere in this codebase that could explain a delayed "correction."

**Root cause (confirmed by client team):** entirely client-side, in `CutoffReview.jsx`'s
`confirmExclude` — a local optimistic-update block force-set every sibling segment's local status to
"excluded" based on an incorrect comment/assumption that the server cascades excludes across a
driver group. It doesn't. The single-segment network call was always correctly scoped.

**Fix:** client repo only — remove the sibling-cascade block, replace with a `refreshApprovals(recId)`
call matching the existing (correct) `doReset` pattern in the same file. No server repo changes.

**Flagged, not fixed here:** an adjacent, unrelated bug in the same file's "Excluded" tab filter
(checks a `localStatus` field that doesn't exist at the top level for `driver_group` records) —
left for a separate ticket if wanted.

---

## Files Changed

| File | Change |
|---|---|
| `src/services/Cutoff/daycareCutoffStrategy.js` | Driver-Aide segment raw approval now grace-aware (single + bulk); extracted `combineDateTime`/`fetchScheduleForDate` to shared module |
| `src/services/Cutoff/bncCutoffStrategy.js` | New `computeGraceCreditHours()`; grace credit applied in raw `approveSingle`, `approveBulk`, `resolveConflict` |
| `src/services/Cutoff/shiftLookupUtils.js` | New — shared day-shift auto-lookup (`fetchScheduleForDate`, `combineDateTime`) |
| `src/controllers/Features/cutoffPeriodController.js` | `enrichApprovals()` DRIVER_AIDE branch now prefers stored `actualHours` over a live recompute from `approvedClockIn`/`approvedClockOut` |
| `src/utils/leaveUtils.js` | BB-048: removed the `Holiday` query and `isWeekend`/`isHoliday` gate from `calcDailyHours` — every day is now deductible, weekend/holiday included |
| `src/prisma/schema.prisma` | BB-045: `LeaveDay`'s unique constraint widened to `[leaveId, date, isPaid]` to allow a split day |
| `src/services/Leave/leaveApprovalService.js` | BB-045: `computeProration` now splits the balance-boundary day into a paid entry + an unpaid entry instead of picking one side |
| `src/controllers/Features/leaveController.js` | BB-045: `getLeaveDays` now orders `date asc, isPaid desc` so a split date's paid row lists first |
| `scripts/widen-leave-day-unique-constraint.sql` | New — BB-045 migration, additive, no backfill |

---

## Open Items (Not in This Release)

- B&C raw-approval grace credit (this release) not yet verified against a real B&C case.
- BB-043's client-side fix (`CutoffReview.jsx`) — pending application/verification in the client repo.
- BB-043's adjacent "Excluded" tab filter bug (`CutoffReview.jsx`, `driver_group.localStatus`) —
  not ticketed yet.
- **BB-048 and BB-045 are not committed, migrated, or deployed** — both remain uncommitted changes
  in this working tree (alongside the earlier-uncommitted BB-048 Phase-1 work: `fromTime`/`toTime`,
  `requestedStartTime`/`requestedEndTime`, `isFallback`). `scripts/add-leave-requested-times.sql`
  and `scripts/widen-leave-day-unique-constraint.sql` both still need to be run manually before
  either ticket can be considered live. Matching client-repo changes are also uncommitted on
  `feature/leave-module-client`.
- How a split leave day (BB-045) interacts with Phase 6's punch-wins reversal and the deferred
  payroll/cutoff hour integration — not resolved, flagged for whoever picks those up.
