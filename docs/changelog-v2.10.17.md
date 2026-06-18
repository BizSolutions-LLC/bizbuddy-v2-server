# Changelog — v2.10.17

> DayCare companies only.

---

## Bug Fixes

### Cutoff Approval — Grace-Period Snap Now Applied in Approve Raw Mode

**Files changed:**
- `src/services/Cutoff/daycareCutoffStrategy.js`

**Context:**
When a supervisor approved a time log using "Approve Raw", the grace-period snap was silently skipped — even if the employee punched in within the allowed grace window. This meant employees who clocked in slightly late (but within grace) were still penalized with reduced hours, while the same scenario under "Approve Schedule" correctly credited them from their scheduled start time.

**Root cause:**
`fetchScheduleForDate` was only called inside the `approveSchedule` branch. The `approveRaw` branch had no access to the employee's shift, so grace-period logic could never run.

**Fix:**

`approveSingle` and `approveBulk` — `fetchScheduleForDate` is now called once before the `approvalMode` branch, making the shift available to both paths.

In `approveRaw` mode:
- If the employee's clock-in falls within the grace window (i.e., late but ≤ `graceMs`), `finalClockIn` is snapped to the scheduled start for **hours computation only**
- The raw punch time is preserved separately as `rawClockIn` and written to `approvedClockIn` — so the displayed clock-in in the UI remains the actual punch time
- Employees fully outside the grace window are unaffected

No schema changes. No migration required.
