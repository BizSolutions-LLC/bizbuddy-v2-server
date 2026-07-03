# Employee Timelog Module — Authoritative Reference

This document is the canonical source of truth for how Employee Timelog computation,
display, and post-approval sync work. Read this before touching any timelog-related
computation, display logic, or cutoff approval strategy.

Last updated: 2026-06-25 (v2.10.18 — sync-back design decided, pending implementation)

See also: [`TIMEKEEPING_GLOSSARY.md`](./TIMEKEEPING_GLOSSARY.md) for canonical term definitions
(Raw/Effective Clock-In, Worked Duration, TR, SL, OT) shared with the client-side application.

---

## Two Distinct Views — And Why They Differ

The system has two places that display hours for the same punch:

| View | Source | When computed |
|---|---|---|
| Employee Timelog detail | `TimeLog.*SegmentHours`, `netWorkedHours` | At clock-out, via `computeTimeLogSummary` |
| Cutoff Period approval row | `TimeLogApproval.actualHours` | At approval time, via cutoff strategy |

**Before cutoff approval:** Both views are driven by `computeTimeLogSummary`. They should agree.

**After cutoff approval:** The two views diverge. The cutoff page reflects the admin's approval
decision (snapped times, raw mode, edited times). The timelog detail continues to show the
pre-approval computed values. This is the known gap this document addresses.

---

## Source of Truth Hierarchy

Once a cutoff period record is approved, the following priority applies:

```
TimeLogApproval.actualHours      ← PAYROLL SOURCE OF TRUTH (always wins)
TimeLog.*SegmentHours            ← display only; stale after approval until sync-back
TimeLog.netWorkedHours           ← display total; stale after approval until sync-back
TimeLog.rawOtMinutes             ← irrelevant for 80h/cutoff companies; do not use for payroll
```

`cutoffOtService.js` already reads exclusively from `TimeLogApproval.actualHours` when
computing period OT — it never uses `TimeLog.netWorkedHours` as the primary source.
The fallback to `netWorkedHours` in that service is a legacy safety net for pre-strategy records.

---

## computeTimeLogSummary — What It Does

**File:** `src/services/timeLogComputeService.js`

Computes all derived fields for a completed `TimeLog` record and writes them back to the DB.
Called at clock-out, after admin edits, after cutoff reset, and optionally at backfill.

### Fields written (all on `TimeLog`)

| Field | Meaning |
|---|---|
| `driverAmSegmentHours` | Hours within Driver/Aide AM Shift window (clamped to window, never OT) |
| `regularSegmentHours` | Hours within Regular Shift window (clamped to window) |
| `driverPmSegmentHours` | Hours within Driver/Aide PM Shift window (clamped to 2:45 PM end) |
| `netWorkedHours` | Sum of all segment hours (DRIVER_AIDE); gross minus breaks (REGULAR) |
| `rawOtMinutes` | Minutes past Driver PM end, grace-adjusted (DRIVER_AIDE); minutes past shift end (REGULAR) |
| `lateHours` | Lateness in hours, 0 if within grace period |
| `undertimeHours` | Undertime in hours, 0 if within grace period |
| `scheduledHours` | Total scheduled shift duration |
| `grossHours` | Raw timeOut − timeIn (no deductions) |
| `isTooEarlyPunch` | true if clock-in is more than earlyClockInGraceMinutes before shift |

### Segment clamping rule (DRIVER_AIDE)

`driverPmSegmentHours` is ALWAYS capped at the Driver PM window end (2:45 PM for this company).
Time after 2:45 PM is captured in `rawOtMinutes`, NOT in `driverPmSegmentHours`.
This is pre-approval behavior — the cutoff approval may pay differently (see below).

---

## DRIVER_AIDE Approval — How actualHours Is Set

**File:** `src/services/Cutoff/daycareCutoffStrategy.js`

A DRIVER_AIDE punch produces **three** `TimeLogApproval` records, one per segment:
- `driver_am` — Driver/Aide AM segment
- `regular` — Regular Hours segment
- `driver_pm` — Driver/Aide PM segment (last segment; may extend past window in raw mode)

### approvalMode: "schedule"

| Segment | approvedClockIn | approvedClockOut | actualHours |
|---|---|---|---|
| driver_am | segmentStart (window start, e.g. 6:45 AM) | segmentEnd (8:00 AM) | 1.25h |
| regular | segmentStart (8:00 AM) | segmentEnd (1:30 PM) | 5.5h |
| driver_pm | segmentStart (1:30 PM) | segmentEnd (2:45 PM) | 1.25h |

### approvalMode: "raw"

| Segment | approvedClockIn | approvedClockOut | actualHours |
|---|---|---|---|
| driver_am | max(actual timeIn, segmentStart) | segmentEnd (8:00 AM) | 1.23h (actual) |
| regular | segmentStart (8:00 AM) | segmentEnd (1:30 PM) | 5.5h |
| driver_pm | segmentStart (1:30 PM) | **actual timeOut (3:30 PM)** | 2.01h |

**Key design decision for raw mode Driver PM:**
The Driver PM segment is the last segment of the day. In raw mode, `approvedClockOut` extends
all the way to the actual clock-out. This absorbs any post-window time (what would be OT) into
the PM segment itself. There is no separate OT approval for that time — it is paid as part of
the PM segment. See `daycareCutoffStrategy.js:232–236`.

---

## The Sync-Back Design (Pending Implementation)

### Problem

After DRIVER_AIDE segments are approved, the `TimeLog` fields still show pre-approval values:
- `driverPmSegmentHours`: 1.25h (window-capped)
- `netWorkedHours`: 7.98h

While the cutoff page shows the approved values:
- Driver PM: 2.01h (raw mode, extends to actual clock-out)
- Total: 8.76h

This creates confusion when an admin reviews a "Cutoff: Approved" timelog and sees 7.98h
instead of the 8.76h that was actually paid.

### Solution

After each DRIVER_AIDE segment approval, check whether ALL sibling segments for the same
`timeLogId` are now approved. If yes, sync approved `actualHours` back to the `TimeLog` fields:

```
driverAmSegmentHours  ← TimeLogApproval(driver_am).actualHours
regularSegmentHours   ← TimeLogApproval(regular).actualHours
driverPmSegmentHours  ← TimeLogApproval(driver_pm).actualHours
netWorkedHours        ← sum of the three above
```

This sync fires automatically — no manual button, no admin action required.

### Trigger condition

```js
const pendingCount = await prisma.timeLogApproval.count({
  where: {
    timeLogId:     timeLog.id,
    cutoffPeriodId,
    status:        { not: "approved" },
  },
});
if (pendingCount === 0) { /* sync back */ }
```

Zero non-approved siblings → all three segments approved → sync immediately.

### When sync fires

| Action | Sync fires? |
|---|---|
| First or second segment approved | No — siblings still pending |
| Last (third) segment approved | Yes |
| Bulk approve (all 3 in one call) | Yes — check per timeLogId after loop |
| Any segment reset to pending | No — revert instead (see Reset section) |

### TimeLog field contract

| Segment state | TimeLog fields reflect |
|---|---|
| Any segment still pending | Pre-approval `computeTimeLogSummary` values |
| All segments approved | Approved `actualHours` from `TimeLogApproval` |

---

## Reset Safety

**File:** `src/controllers/Features/cutoffPeriodController.js` — `resetApproval()`

### Current behavior (pre-sync-back implementation)

When an admin resets an approved segment to pending:
1. If `originalTimeIn` is set on `TimeLog` (modified during "Approve Schedule"):
   → restore `timeIn`/`timeOut` from `originalTimeIn`/`originalTimeOut`
   → call `computeTimeLogSummary` (fire-and-forget)
2. Else (DRIVER_AIDE — `timeIn`/`timeOut` never modified):
   → just set `isApproved = false`
   → `computeTimeLogSummary` is NOT called ← gap

### Required behavior after sync-back implementation

Reset of any DRIVER_AIDE segment must:
1. Flip `TimeLogApproval.status` to pending (existing behavior)
2. Always call `computeTimeLogSummary` **awaited**, not fire-and-forget, for DRIVER_AIDE punch types
3. This restores `driverAmSegmentHours`, `regularSegmentHours`, `driverPmSegmentHours`,
   `netWorkedHours` back to pre-approval computed values

### Why this is safe

- `timeIn`/`timeOut` are never modified for DRIVER_AIDE approval — raw punch always intact
- `originalTimeIn`/`originalTimeOut` are never deleted from the `TimeLog` record
- `computeTimeLogSummary` is deterministic — same raw inputs always produce same computed outputs
- Re-running it on reset always restores the correct pre-approval state

### Reset invariant

Resetting ONE segment reverts ALL `TimeLog` segment fields to pre-approval values, even if the
other two segments are still approved. This is correct — `TimeLog` fields must reflect a
consistent state: either all pre-approval or all approved. Mixed states are not allowed.
The other segments' `TimeLogApproval.actualHours` records are untouched — they hold their
approved values and will re-sync to `TimeLog` fields once all three are approved again.

---

## OT Status — Three States (DayCare / 80h Cutoff Companies)

For companies with `otBasis = "cutoff"` (80h/period threshold), per-punch OT is meaningless.
OT cannot be determined for any individual punch — it requires the full period total.
The `OT Status` field in the timelog detail must NOT use `rawOtMinutes` for these companies.

### Source

Read from `CutoffOtBlock` for the employee's cutoff period:

```js
const otBlock = await prisma.cutoffOtBlock.findUnique({
  where: { cutoffPeriodId_userId_date: { cutoffPeriodId, userId, date: periodEnd } },
  select: { status: true },
});
```

### Display values

| `CutoffOtBlock` state | Display label | Meaning |
|---|---|---|
| No record exists | `-` | No OT produced — period total ≤ 80h, or cutoff not yet settled |
| Record exists, `status = "pending"` | `Included` | Period total exceeded 80h; OT block computed, pending admin approval |
| Record exists, `status = "approved"` | `Approved` | Period OT confirmed and approved |

### Important nuance

`Included` and `Approved` do NOT mean this specific punch IS overtime. They mean this punch's
hours are part of a period where OT was produced. The OT is a property of the entire cutoff
period, not of any individual punch.

---

## Implementation Scope

Changes required to implement sync-back + OT Status fix:

| File | Change |
|---|---|
| `src/services/Cutoff/daycareCutoffStrategy.js` | After DRIVER_AIDE `approveSingle`: check sibling count; if zero pending, write approved `actualHours` to `TimeLog` segment fields and `netWorkedHours` |
| `src/services/Cutoff/daycareCutoffStrategy.js` | After DRIVER_AIDE `approveBulk`: same check per `timeLogId` after the approval loop |
| `src/controllers/Features/cutoffPeriodController.js` | `resetApproval()`: for DRIVER_AIDE punch types, always `await computeTimeLogSummary()`, not only when `originalTimeIn` is set |
| Timelog detail endpoint / frontend | OT Status: read from `CutoffOtBlock.status` for `otBasis = "cutoff"` companies; display `-`, `Included`, or `Approved` |

**No changes needed:**
- `cutoffOtService.js` — already reads from `TimeLogApproval.actualHours`, not `TimeLog` fields
- Cutoff period approval page — already reads from `TimeLogApproval`, already correct
- `computeTimeLogSummary` — no changes; called on reset to restore pre-approval values

---

## Key Files Reference

| File | Role |
|---|---|
| `src/services/timeLogComputeService.js` | Core computation engine — all derived TimeLog fields |
| `src/services/timeLogComputeUtils.js` | Shared utility helpers for computation |
| `src/services/Cutoff/daycareCutoffStrategy.js` | DayCare approval strategy — approveSingle, approveBulk, resolveConflict |
| `src/services/Cutoff/bncCutoffStrategy.js` | B&C approval strategy |
| `src/services/Cutoff/cutoffOtService.js` | Period OT and daily OT computation; writes CutoffOtBlock |
| `src/services/Cutoff/scheduleMatchingService.js` | Shift matching utilities |
| `src/controllers/Features/cutoffPeriodController.js` | Cutoff period CRUD, resetApproval, approveOtBlock |
| `src/controllers/Cutoff/cutoffApprovalsController.js` | Approval list, sync, bulk operations |

---

## Shift Names — Canonical (DayCare)

`computeTimeLogSummary` and `resolveDriverAideSegments` depend on these exact shift names
in the company's Shift catalog. Renaming them in the admin UI breaks segment computation.

| Canonical Name | Segment |
|---|---|
| `Driver/Aide AM Shift` | Pre-regular driving window (e.g. 6:45 AM – 8:00 AM) |
| `Regular Shift` | Program hours (e.g. 8:00 AM – 1:30 PM) |
| `Driver/Aide PM Shift` | Post-regular driving window (e.g. 1:30 PM – 2:45 PM) |
