# Changelog — v2.10.18

> Leave transaction ledger, DayCare segment clock-in/out fixes, OT block breakdown, reset improvements, and leave request date handling.

---

## New Features

### Leave Transaction Ledger

A full audit trail for every leave balance movement is now recorded in a new `LeaveTransaction` table.

**Schema changes (`src/prisma/schema.prisma`):**
- New model `LeaveTransaction` with fields: `type` (enum: `accrual` / `deduction` / `adjustment`), `hours`, `balanceBefore`, `balanceAfter`, `leaveId` (nullable), `performedById` (nullable), `note`
- New enum `LeaveTransactionType`
- `LeavePolicy` and `User` gain the required Prisma relations

**Migration:** `scripts/add-leave-transaction-ledger.sql` — creates the table, enum, foreign keys, and indexes. Run manually before deploying.

**Transaction writers:**
| Event | Type | Where |
|---|---|---|
| Leave approved (single or final) | `deduction` | `leaveController._deductBalance` |
| Admin adjusts balance | `adjustment` | `leaveBalanceController.adjustBalance` |
| Monthly leave accrual | `accrual` | `leaveAccrualWorker` (monthly loop) |
| Yearly leave reset/grant | `accrual` | `leaveAccrualWorker` (yearly loop) |

---

### `GET /leave-balances/transactions` — Transaction History Endpoint

New paginated endpoint returning a user's leave transaction log.

**File:** `src/controllers/Features/leaveBalanceController.js`, `src/routes/Features/leaveBalanceRoutes.js`

- Accessible to all roles (`employee`, `supervisor`, `admin`, `superadmin`)
- Non-management users only see their own transactions
- Management can query any employee in their company via `?userId=`
- Query params: `userId`, `policyId`, `type`, `limit` (max 200, default 50), `offset`
- Returns `{ data, pagination: { total, limit, offset, hasMore } }`

---

### `GET /leave-balances` — Balance List Enriched with Usage and Transactions

**File:** `src/controllers/Features/leaveController.js` → `listBalances`

- Management can now query balances for any employee in the company via `?userId=`
- Response now includes `usedHours` (total deductions from the ledger) and `transactions` (last 100 records) per policy

---

### Leave Records Now Include Deduction Transaction

**File:** `src/controllers/Features/leaveController.js` → `_attachTransactions`

`getUserLeaves`, `getPendingLeavesForApprover`, and `getLeavesForApprover` now attach the deduction `LeaveTransaction` record to each leave item in the response under a `transaction` field (or `null` if none exists yet — e.g. records approved before this version).

---

### OT Block Breakdown in Cutoff Approvals

**File:** `src/controllers/Features/cutoffPeriodController.js` → `getCutoffApprovals`

When the cutoff period response includes OT blocks, each block now carries a `breakdown` object:

```json
{
  "breakdown": {
    "days": [
      { "date": "2026-06-10", "hours": 8.5, "isTraining": false },
      { "date": "2026-06-10", "hours": 8.0, "isTraining": true }
    ],
    "totalHours": 8.5,
    "threshold": 80,
    "otHours": 0
  }
}
```

- Training hours appear as separate rows with `isTraining: true` — they are excluded from `totalHours` and OT math (matching `computeOtForCutoffBasis` behavior), but are visible to the UI so it can render them as grayed-out rows
- For daily-OT companies, the breakdown is scoped to the block's calendar date only

---

## Bug Fixes

### DayCare — Raw Mode: AM Segment Clock-In Now Clamped to Segment Window

**File:** `src/services/Cutoff/daycareCutoffStrategy.js` → `approveSingle`, `approveBulk`

**Problem:** In Raw approval mode, the global `timeIn` (the employee's first punch of the day) was being assigned directly as `approvedClockIn` for all three segments (AM, Regular, PM). For PM and Regular segments, the global punch-in precedes the segment window — crediting those segments from the global time inflated hours incorrectly.

**Fix:** `approvedIn` for Raw mode is now `max(actual timeIn, segmentStart)`. If the employee clocked in before the segment window starts (as is always true for non-AM segments), they are credited from the segment start, not from their first punch.

---

### DayCare — Raw Mode: PM Segment Pays Through Actual Clock-Out

**File:** `src/services/Cutoff/daycareCutoffStrategy.js` → `approveSingle`, `approveBulk`

**Problem:** All segments were capped at `segmentEnd` in Raw mode. For the PM (last) segment, this meant early clock-outs were not reflected — the employee was credited through their scheduled end even if they left early.

**Fix:** When `approvalMode === "raw"` and `segmentType === "driver_pm"`, `approvedOut` is set to the actual `timeLog.timeOut` instead of `segmentEnd`. AM and Regular segments still cap at their `segmentEnd` to prevent double-counting with subsequent segments.

---

### DayCare — Cutoff Approval List: Segment Hours Now Reflect Approved Clock-In/Out

**File:** `src/controllers/Features/cutoffPeriodController.js` → `enrichApprovals`

**Problem:** `segmentHours` in the approval list was calculated from the stored `TimeLog` segment fields, which do not account for whether an approval was done in Schedule vs Raw mode — leading to incorrect displayed hours.

**Fix:** For approved records, `segmentHours` is now computed directly from `approvedClockIn` / `approvedClockOut` on the `TimeLogApproval` record. A guard is applied: if `approvedClockIn` is before `segmentStart`, the record is a stale historical entry written before the Raw clip fix and falls back to the stored value.

---

### Reset Approval Now Restores Raw TimeLog and Handles Excluded Status

**File:** `src/controllers/Features/cutoffPeriodController.js` → `resetApproval`

**Problems:**
1. Only `approved` records could be reset; `excluded` records (auto-excluded on Training reclassification) could not.
2. When an "Approve Schedule" approval was reset, the `TimeLog.timeIn/timeOut` remained snapped to the shift window instead of being restored to the original raw punch times.

**Fixes:**
- Accepts `excluded` status in addition to `approved`
- If `timeLog.originalTimeIn` is set, the reset restores `timeIn` and `timeOut` to the original values and triggers a `computeTimeLogSummary` recompute asynchronously
- If `originalTimeIn` is not set (raw approval or no modification), only `isApproved` is toggled

---

### Training Reclassification Auto-Excludes Pending Driver Segments

**File:** `src/controllers/Features/cutoffPeriodController.js` → `setPunchType`

**Problem:** When a day was reclassified as TRAINING via `setPunchType`, any pending DRIVER_AIDE segment approval records for the same employee on the same day remained in `pending` state, creating data inconsistency.

**Fix:** When `punchType === "TRAINING"`, the system now finds all DRIVER_AIDE `TimeLog` records for that user on that local calendar day and bulk-updates their pending segment approval records to `excluded`, with a note: `"Auto-excluded: day reclassified as Training"`. The response includes `excludedSegmentCount`.

---

### `effectiveTimeIn` Now Snaps Late-Within-Grace Clock-Ins for Regular Employees

**File:** `src/services/timeLogComputeService.js` → `computeTimeLogSummary`

**Problem:** `effectiveTimeIn` (used for net hours computation) was only snapped to `shiftStart` for early clock-ins. A late clock-in that fell within the grace window was not snapped — the employee was effectively penalized with reduced net hours even though grace should have protected them.

**Fix:** Added `isLateWithinGrace` check: if `timeIn > shiftStart` and `timeIn − shiftStart ≤ graceMs`, `effectiveTimeIn` is also snapped to `shiftStart`. This ensures late-within-grace punch-ins receive the same full-shift credit as on-time punch-ins. Raw `timeIn` is never modified.

---

### Leave Request: Dates Stored as Noon in Company Timezone

**File:** `src/controllers/Features/leaveController.js` → `submitLeaveRequest`

**Problem:** `new Date(fromDate)` and `new Date(toDate)` were used directly, which interprets plain `YYYY-MM-DD` strings as UTC midnight — causing the stored date to appear as the previous calendar day for companies in negative-offset timezones (e.g. California UTC−7).

**Fix:** Dates are now parsed in the company's `timeZone` at noon (`12:00:00`) via `moment.tz`. Noon is immune to UTC offset drift across all timezones (UTC−12 to UTC+12), so the stored date always matches the intended calendar date.

---

### `calcRequestedHours` — Shift Workers Without Shifts in Range Now Deduct 0, Not Full Days

**File:** `src/utils/leaveUtils.js` → `calcRequestedHours`

**Problem:** If a shift-assigned employee had no scheduled shifts within their leave date range (e.g., a leave during a gap period), `shiftHoursMap.size === 0` was incorrectly treated as "no shifts at all" and the employee was credited as salaried — deducting the company default hours for every weekday.

**Fix:** When `shiftHoursMap` is empty, a fallback query checks whether the employee has *any* non-cancelled `UserShift` record. If yes, they are treated as a shift worker (deduct 0 for unscheduled days). Only if they have no shifts anywhere are they treated as salaried.

---

## Files Changed

| File | Change |
|---|---|
| `src/prisma/schema.prisma` | New `LeaveTransaction` model + `LeaveTransactionType` enum + `User`/`LeavePolicy` relations |
| `scripts/add-leave-transaction-ledger.sql` | Migration script for `LeaveTransaction` |
| `src/controllers/Features/leaveBalanceController.js` | `adjustBalance` writes ledger; new `getTransactions` endpoint |
| `src/routes/Features/leaveBalanceRoutes.js` | `GET /transactions` route |
| `src/controllers/Features/leaveController.js` | Transaction writes on approval; `_attachTransactions`; `listBalances` enriched; date timezone fix |
| `src/workers/leaveAccrualWorker.js` | Accrual writes ledger records |
| `src/utils/leaveUtils.js` | `calcRequestedHours` shift-worker fallback fix |
| `src/services/Cutoff/daycareCutoffStrategy.js` | Raw mode `approvedIn`/`approvedOut` segment fixes |
| `src/controllers/Features/cutoffPeriodController.js` | Segment hours from approval record; OT breakdown; reset restore; Training auto-exclude |
| `src/services/timeLogComputeService.js` | Late-within-grace snap for regular employees |
