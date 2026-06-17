# Changelog — v2.10.16

> All companies.

---

## Features

### Leave Request — Affected Schedules Preview

**Files changed:**
- `src/controllers/Features/leaveController.js`
- `src/routes/Features/leaveRoutes.js`
- `src/prisma/schema.prisma`

**Context:**
When an employee submits a leave request, the system can now identify and snapshot which of their scheduled shifts fall within the requested date range. This gives supervisors visibility into exactly which shifts are impacted when reviewing a leave request.

**Changes:**

New endpoint `GET /api/leaves/affected-schedules`:
- Accepts `startDate` and `endDate` as query params (`YYYY-MM-DD`)
- Returns all non-cancelled `UserShift` records for the logged-in employee within that range
- Includes `shiftName`, `assignedDate`, `startTime`, `endTime`, `crossesMidnight`, and computed `scheduledHours` per shift
- Returns an empty array if no shifts are filed for those dates — not an error

`POST /api/leaves/submit` — new optional body fields:
- `affectedShiftIds` (`string[]`) — array of `userShiftId` values from the affected-schedules response. The server snapshots the full shift details (name, date, scheduled hours) at submission time and stores them on the leave record
- `isPaid` (`boolean`) — explicitly marks the leave as paid or unpaid. Defaults to `true` if omitted

**Schema change:**
- Added `affectedShifts Json?` to the `Leave` model
- Migration: `ALTER TABLE "Leave" ADD COLUMN IF NOT EXISTS "affectedShifts" JSONB;`
- Run migration first, then `npx prisma generate`

---

### Leave Request — Paid vs Unpaid Balance Deduction

**Files changed:**
- `src/controllers/Features/leaveController.js`

**Context:**
Previously, `isPaid` was stored on the leave record but never acted upon during approval — every approved leave always deducted from the employee's balance regardless. This fix wires `isPaid` into the approval flow correctly.

**Changes:**

`_deductBalance` — now respects `isPaid`:
- `isPaid: true` → deducts hours from `LeaveBalance`, calculated from actual scheduled shift hours within the leave date range (shift-based, via existing `calcRequestedHours`)
- `isPaid: false` → skips deduction entirely, leave is recorded as unpaid with no balance impact

This applies to both single-approver and two-step (escalated) approval flows.

---

### Leave Policies — Balance Included in Response

**Files changed:**
- `src/controllers/Features/leavePolicyController.js`

**Context:**
The `GET /api/leaves/policies` endpoint previously returned only policy configuration. It now includes the logged-in employee's current available balance per leave type, so the client can show remaining balance immediately when a leave type is selected.

**Changes:**

`getAvailablePolicies` — new field `balanceHours` on each policy object:
- Joined from `LeaveBalance` scoped to the requesting user
- Returns `0` if no balance record exists yet for that policy

**Updated response shape:**
```json
{
  "success": true,
  "data": [
    {
      "id": "...",
      "leaveType": "Sick Leave",
      "annualAllocation": "120.00",
      "accrualUnit": "hours",
      "accrualFrequency": "monthly",
      "carryOverAllowed": false,
      "negativeAllowed": false,
      "balanceHours": 80.00
    }
  ]
}
```

---

## Bug Fixes

### Arlene Falces — Coffee Break Elapsed on 05/29/2026 Evening Punch

**Root cause:**
The coffee break timer was started at 22:59 UTC (45 seconds before the 23:00 UTC clock-in) and was never closed before clock-out. The system auto-closed it at 06:00 UTC the following day — 1 hour past the actual clock-out (05:00 UTC). This resulted in a 7.01h coffee break deduction on a 6.00h shift, driving `netWorkedHours` to 0.00h.

**Fix:**
Manual correction applied to TimeLog `cmprix4890d2nsi4w0eawo3si`:
- `coffeeBreaks` cleared to `[]`
- `netWorkedHours` restored to `6.00`

---

## Client-Side Notes

### Leave Request Form — Required Updates

The following changes are needed on the client to support the new leave request features:

1. **On leave type selected** — call `GET /api/leaves/policies`, read `balanceHours` for the selected type and display the available balance to the employee.

2. **On date range filled** — call `GET /api/leaves/affected-schedules?startDate=...&endDate=...` and display the matched shifts as a preview list. Empty array means no shifts filed — show nothing, do not block submission.

3. **Add Paid / Unpaid toggle** — default to Paid. Pass `isPaid` (boolean) in the submit payload.

4. **On submit** — include `affectedShiftIds` (array of `userShiftId` from the affected-schedules response) in the request body alongside the existing fields.

**Full submit payload:**
```json
{
  "type": "Sick Leave",
  "fromDate": "2026-06-16",
  "toDate": "2026-06-18",
  "approverId": "...",
  "isPaid": true,
  "leaveReason": "Not feeling well.",
  "affectedShiftIds": ["userShiftId1", "userShiftId2"]
}
```
