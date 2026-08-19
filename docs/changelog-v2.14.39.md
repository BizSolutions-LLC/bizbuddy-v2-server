# Changelog — v2.14.39

> **BB-074** — cutoff-approval segment rows left over from a punch-type reclassification (e.g. a
> duplicate-punch day where one punch gets retyped to Driver AM Only and another to Regular) are
> now automatically cleaned up, instead of lingering as orphaned pending rows on the review screen.
> **BB-073** — root-caused but **not yet fixed in code**: `leaveConflictAutoRevert` silently fails
> to cancel/credit a leave when the `Leave` row's stored date carries a non-midnight time-of-day.
> Also found along the way: a related, separate, unfixed miscategorization bug in the payroll
> export service for single-route Driver/Aide days. See "Known Issues" below.

---

## Bug Fix

### BB-074 — Orphaned Segment Approvals Left Behind After a Punch-Type Change

**Why:** `syncApprovalRecords()` generates one `TimeLogApproval` row per entry in
`DRIVER_SEGMENT_MAP[punchType]` at sync time. If an admin later reclassifies that `TimeLog`'s
punch type (e.g. full `DRIVER_AIDE` → `DRIVER_AIDE_AM`, or all the way to `REGULAR`), nothing
removed the approval rows generated under the *old* type — they sat there as pending, orphaned
rows: a `driver_pm` segment on a now-AM-only day, or a full 3-segment set under a now-`REGULAR`
punch that shouldn't have any segment-typed rows at all. Surfaced while investigating a real
duplicate-punch case (Jasbleidi Mendoza, Piedmont Adult Day Program, 2026-08-10) — after manually
reclassifying her two Aug 10 punches to resolve the duplication, the review screen kept showing 6
stale segment rows instead of the correct 2 (Driver AM + Regular) plus a separate flat Regular
punch row.

**`cleanupOrphanedSegmentApprovals(cutoffPeriodId, timeLogIds)`** (new helper,
`cutoffPeriodController.js`) — for the given `TimeLog` ids, deletes any `status: "pending"`
`TimeLogApproval` row whose `segmentType` is not in `DRIVER_SEGMENT_MAP[currentPunchType]`. Only
pending rows are ever touched — approved/excluded/rejected records are left alone, so this can
never retroactively undo a real payroll decision.

Wired into two places:
- **`syncApprovalRecords()`** — runs on every cold sync (new cutoff, or an existing one with zero
  approval records), scoped to *every* `TimeLog` in the period, not just currently-Driver/Aide
  ones — a `TimeLog` reclassified all the way to `REGULAR`/`TRAINING` no longer passes
  `isDriverSegmentPunchType` and would otherwise be missed.
- **`getCutoffApprovals()`**, existing-approvals branch — previously only the cold-sync path ever
  ran any cleanup; this covers every later page load of an already-synced cutoff, scoped by
  querying existing pending segment-typed approvals directly (catches a reclassified `TimeLog`
  regardless of what it's been changed to).

**Client-side impact:** none — purely removes now-invalid pending rows from what the approvals
endpoint already returns. No new fields, no change to any approve/exclude/edit action or payload.

---

## Known Issues (confirmed, not yet fixed)

### BB-073 — `leaveConflictAutoRevert` Silently Fails on Non-Midnight Leave Dates

**The bug:** `resolveConflict()`'s leave-cancel lookup — present in both
`daycareCutoffStrategy.js` (~line 773) and `bncCutoffStrategy.js` (~line 431) — compares
`Leave.startDate`/`endDate` against a punch's `timeIn` using full-timestamp `lte`/`gte`:

```js
const leave = await prisma.leave.findFirst({
  where: { userId, status: "approved", startDate: { lte: new Date(timeLog.timeIn) }, endDate: { gte: new Date(timeLog.timeIn) } },
});
```

When a `Leave` row's `startDate`/`endDate` carries a non-midnight time-of-day (observed in
production as `19:00:00.000Z` — noon Pacific, not midnight), an early-morning punch on the leave's
own calendar day fails the `lte` check, so the lookup silently returns nothing. The leave is never
cancelled and its deduction is never credited back — even though `leaveConflictAutoRevert` is on
and the punch approval itself succeeds and gets stamped "Conflict resolved — punch takes
precedence," making the operation look complete. The read-side conflict *detection* in
`cutoffPeriodController.js` (`leaveContextDraft`) is unaffected, since it compares calendar-day
strings rather than full timestamps.

**Confirmed via:** Jasbleidi Mendoza's Aug 10 approved Sick Leave — ledger showed
`submitted → deduction → approved` with no `cancelled` entry, despite two conflict-resolved Driver
punches that same day. Corrected manually for this one record; no code fix shipped this release.

**Fix direction (not yet implemented):** switch the leave lookup in both strategy files to
calendar-day matching, mirroring the string-slice comparison `cutoffPeriodController.js`'s
read-side detection already uses correctly, instead of comparing full timestamps.

### Payroll Export Miscategorizes Regular Segment Hours on Single-Route Driver/Aide Days

**The bug:** `payrollExportService.js`'s per-employee hour classification (~lines 91-110) branches
on `DRIVER_PUNCH_TYPES.includes(tl.punchType)` (`["DRIVER_AIDE_AM", "DRIVER_AIDE_PM"]`) and buckets
the *entire* approved amount into Driver hours — unlike the adjacent `DRIVER_AIDE` (full-day)
branch, which correctly checks `segmentType` and routes a `"regular"` segment to the Regular
bucket. An approved `"regular"` segment on a `DRIVER_AIDE_AM`/`DRIVER_AIDE_PM` day would be
miscounted as Driver hours in the payroll export batch instead of Regular hours.

**Status:** confirmed in code while investigating BB-074; not yet fixed, no ticket assigned.

---

## Files Changed

| File | Change |
|---|---|
| `src/controllers/Features/cutoffPeriodController.js` | New `cleanupOrphanedSegmentApprovals()` helper; called from `syncApprovalRecords()` and from `getCutoffApprovals()`'s existing-approvals branch |
