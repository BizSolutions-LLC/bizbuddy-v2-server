# Changelog — v2.10.19

> DayCare/Driver-Aide timelog data integrity: approved segment values now sync back to the Employee Timelog, reset always recomputes, and OT Status reflects the cutoff-period OT block instead of per-punch raw minutes.

---

## New Features

### DRIVER_AIDE: Approved Segment Hours Sync Back to Employee Timelog

**Files:** `src/services/Cutoff/daycareCutoffStrategy.js`

**Problem:** The Employee Timelog module displays values from `TimeLog` fields computed by `computeTimeLogSummary` at clock-out time. For DRIVER_AIDE punches, `computeTimeLogSummary` always caps `driverPmSegmentHours` at the PM segment window end (2:45 PM). When an approval uses Raw mode, the PM segment extends to the employee's actual clock-out time — producing approved values that diverge from the Timelog display indefinitely.

**Fix:** A new `syncApprovedSegmentsToTimeLog(timeLogId, cutoffPeriodId)` helper fires after every DRIVER_AIDE segment approval. It checks whether all sibling segments for that punch are now `approved`; if so, it reads the `actualHours` from each `TimeLogApproval` record and writes them back to `TimeLog`:

- `driverAmSegmentHours` ← `driver_am` actualHours
- `regularSegmentHours` ← `regular` actualHours
- `driverPmSegmentHours` ← `driver_pm` actualHours
- `netWorkedHours` ← sum of the three segments

The sync is fire-and-forget (non-blocking) in `approveSingle` and awaited in sequence in `approveBulk` for all unique DRIVER_AIDE timelogs in the batch.

**Reset safety:** `originalTimeIn`/`originalTimeOut` are never modified. If a segment is reset, `computeTimeLogSummary` restores the pre-approval computed values from the raw punch times (see reset fix below).

---

### Employee Timelog: OT Status Field from Cutoff OT Block

**File:** `src/controllers/Features/timeLogController.js` → `getCompanyTimeLogs`

For companies with `otBasis === "cutoff"`, the Employee Timelog API now returns an `otStatus` field on each DayCare row derived from `CutoffOtBlock.status` rather than per-punch `rawOtMinutes`.

| `CutoffOtBlock.status` | `otStatus` displayed |
|---|---|
| No block found | `"-"` |
| `"included"` | `"Included"` |
| `"approved"` | `"Approved"` |

This correctly reflects that OT for 80h/cutoff companies is a period-level determination, not calculable per punch.

**Implementation:** After building the rows array, the controller collects unique `(userId, cutoffPeriodId)` pairs from rows that have a `cutoffApproval`, bulk-fetches the matching `CutoffOtBlock` records in a single query, builds a lookup map, then annotates each row's `otStatus` from the map.

---

## Bug Fixes

### Reset Approval: DRIVER_AIDE Punches Now Always Recompute After Reset

**File:** `src/controllers/Features/cutoffPeriodController.js` → `resetApproval`

**Problem:** The reset path called `computeTimeLogSummary` only inside the `if (originalTimeIn)` branch (i.e. only when a Schedule-mode approval had snapped `timeIn`/`timeOut`). DRIVER_AIDE punches never have `originalTimeIn` set — the approval process does not modify their `timeIn`/`timeOut` fields — so the recompute was silently skipped. After a sync-back had written approved values to the TimeLog fields, resetting a DRIVER_AIDE segment would flip `isApproved` back to `false` but leave the approved segment hours in place.

**Fix:** `computeTimeLogSummary` is now always `await`ed after both branches of the reset, regardless of punch type. This deterministically restores pre-approval segment values from the raw punch times.

---

## Data Backfill

### Jun 10–Jun 23 Cutoff: DRIVER_AIDE Timelog Segment Fields Backfilled

All DRIVER_AIDE timelogs for company `cmnegwuxm0004rf7fzo6wjrw2` in the Jun 10–Jun 23, 2026 cutoff period were backfilled to reflect approved `actualHours` values (sync-back was not yet in place when these records were approved).

| Outcome | Count |
|---|---|
| Updated | 109 |
| Already correct | 67 |
| Skipped (segments not fully approved) | 18 |

Going forward, newly approved DRIVER_AIDE segments self-sync automatically.

---

## Documentation

### `docs/TIMELOG_MODULE.md` — New Canonical Reference

Added a module-level reference document covering: two-view data model (TimeLog vs TimeLogApproval), source-of-truth hierarchy, `computeTimeLogSummary` field definitions, DRIVER_AIDE approval modes (Schedule vs Raw), sync-back design and reset safety, OT Status three states, and key implementation files.

---

## Files Changed

| File | Change |
|---|---|
| `src/services/Cutoff/daycareCutoffStrategy.js` | `syncApprovedSegmentsToTimeLog` helper; wired into `approveSingle` and `approveBulk` |
| `src/controllers/Features/cutoffPeriodController.js` | `resetApproval` always awaits `computeTimeLogSummary` after both branches |
| `src/controllers/Features/timeLogController.js` | `getCompanyTimeLogs` adds `otStatus` from `CutoffOtBlock` for cutoff-basis OT companies |
| `docs/TIMELOG_MODULE.md` | New module reference document |
