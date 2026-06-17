# Changelog — v2.10.3

> DayCare exclusive. BNC unaffected.

---

## Bug Fixes

### DayCare — DRIVER_AIDE segment In/Out times blank on cutoff page

**Files changed:**
- `src/controllers/Features/cutoffPeriodController.js`

**Root cause:**  
`createCutoffPeriod` created the three `TimeLogApproval` rows (driver_am, regular, driver_pm) for DRIVER_AIDE punches without calling `resolveDriverAideSegments`, leaving `segmentStart`/`segmentEnd` as `null`. The auto-sync that does populate them only ran when `existingCount === 0`, so existing cutoffs were never backfilled. The client reads `segmentStart`/`segmentEnd` for the In/Out column — null values rendered as `—`.

**Fix A — `createCutoffPeriod`:**  
Now calls `resolveDriverAideSegments` for all DRIVER_AIDE logs in the period and stores `segmentStart`/`segmentEnd` on each approval row at creation time.

**Fix B — `getCutoffApprovals` auto-sync backfill:**  
When approval records already exist but any DRIVER_AIDE row has `segmentStart IS NULL`, the endpoint now resolves and updates those rows before returning the response. Applies automatically on the next page load — no manual sync required.

---

## Features

### DayCare — `approvalMode` support for REGULAR punch approvals

**Files changed:**
- `src/services/Cutoff/daycareCutoffStrategy.js`
- `src/controllers/Features/cutoffPeriodController.js`

**Context:**  
The client-side cutoff page is adding a four-button approval model for DayCare: **Approve Shift**, **Approve Raw**, **Edit**, **Exclude**. The server previously only had a single approve path (always schedule-snapped). This adds the `approvalMode` fork so the client can distinguish between the two approval intents.

**Changes:**

`daycareCutoffStrategy.approveSingle` — added `approvalMode` parameter:
- `approvalMode: "schedule"` (default) — existing behavior: snap clock-in to schedule start within grace period, cap clock-out at schedule end, update `timeLog.timeIn`/`timeOut` with cleaned values.
- `approvalMode: "raw"` — no schedule lookup, no snapping. Raw `timeLog.timeIn`/`timeOut` used as-is. `timeLog` is marked `isApproved: true` but `timeIn`/`timeOut` are not overwritten. Hours computed directly from raw times.

`daycareCutoffStrategy.approveBulk` — same `approvalMode` fork applied for bulk operations.

`cutoffPeriodController.bulkUpdateApprovals` — now reads `approvalMode` from the request body and passes it to the strategy (was previously omitted).

**DRIVER_AIDE segments** — segment hours are unaffected by `approvalMode` (always uses stored computed hours). However `approvedClockIn`/`approvedClockOut` now differ by mode:
- `approvalMode: "schedule"` → stores `segmentStart`/`segmentEnd` as the approved times (the scheduled window per segment)
- `approvalMode: "raw"` → stores `timeLog.timeIn`/`timeLog.timeOut` (the raw overall daily punch)

This allows the client to display the correct cleaned times per segment row after approval.

**Client contract:**
```
Approve Shift  →  { action: "approve", approvalMode: "schedule" }
Approve Raw    →  { action: "approve", approvalMode: "raw" }
```

---

## Client-Side Notes (no server changes required)

The following were identified and confirmed as client-only fixes during this release:

1. **In/Out display — status-aware rendering:**  
   Pending/excluded rows should read `timeLog.timeIn`/`timeLog.timeOut` (raw). Approved rows should read `approvedClockIn`/`approvedClockOut`. `segmentStart`/`segmentEnd` demoted to scheduled reference window only. All fields already present in the API response.

2. **DriverGroupRow — raw punch on day header:**  
   Raw clock-in/out (shared across all 3 segment rows) should be shown at the day header level. Can be read from `group.segments[0].rawTimeIn` / `rawTimeOut`.

3. **DRIVER_AIDE segment rows — pending In/Out display:**  
   Pending segment rows should show `segmentStart`/`segmentEnd` (the scheduled window) not `timeLog.timeIn`/`timeLog.timeOut` (the shared daily punch). The shared raw punch belongs on the day header only. After approval: read `approvedClockIn`/`approvedClockOut` as usual.

4. **Approve Shift — bypass shift picker for all DayCare records:**  
   `handleApproveSchedule` should bypass the shift picker for all non-BNC records (both driver segments and regular punches). DayCare has no shift picker — fire `doApprove(rec.id, { approvalMode: "schedule" })` directly. Picker flow remains for BNC regular punches only.

5. **DayCare action buttons — 4-button model for all DayCare punch types:**  
   Both driver segments (`!isBNC && isSegment`) and regular punches (`!isBNC && !isSegment`) should use `["approve-schedule", "approve-raw", "edit", "exclude"]`. The single-Approve fallback is removed for DayCare entirely. Server already supports `approvalMode: "schedule"` and `approvalMode: "raw"` for both punch types.

6. **Reset button — wrong endpoint:**  
   The Reset button must call `PATCH /api/cutoff-periods/:id/approvals/:approvalId/reset` with no body. It was incorrectly calling `PATCH /api/cutoff-periods/:id/approvals/:approvalId` with `{ action: "reset" }`, which returns 400 (not a valid action).
