# Timekeeping Glossary — Canonical Term Reference

This is the single source of truth for timekeeping/payroll terminology used across the server
(`CUTOFF_PERIOD_MODULE.md`, `TIMELOG_MODULE.md`) and the client-side application. Do not
redefine these terms locally in other docs — link back here instead. If client-side and
server-side definitions ever diverge, this file wins; update both sides to match it.

Last updated: 2026-07-03

---

## Term Definitions

| Term | Definition |
|---|---|
| **Raw Clock-In** | The actual timestamp recorded when the employee clocks in. Never modified. Maps to `TimeLog.timeIn` prior to any policy adjustment. |
| **Raw Clock-Out** | The actual timestamp recorded when the employee clocks out. Never modified, with one sanctioned exception: the early-clock-out grace snap (`earlyClockOutGraceMinutes`) is a permanent DB write — see `CUTOFF_PERIOD_MODULE.md`. |
| **Effective Clock-In** | The clock-in timestamp after applying attendance policies — grace period, early-clock-in rules, schedule alignment. Maps to `effectiveTimeIn` / `finalClockIn` / `approvedClockIn` depending on company type and approval mode. |
| **Effective Clock-Out** | The clock-out timestamp after applying attendance policies — early clock-out rules, schedule alignment. Maps to `finalClockOut` / `approvedClockOut`. |
| **Worked Duration** | `Effective Clock-Out − Effective Clock-In`. Total elapsed working time before break deductions. |
| **Break Duration (BR)** | Total unpaid break time deducted from Worked Duration. Derived from `TimeLog.totalBreakMinutes` + `lunchDeductionMinutes` (breaks are stored as JSON — `coffeeBreaks`, `lunchBreak` — not a relational model). |
| **Net Worked Hours** | `Worked Duration − Break Duration`. Actual hours worked before leave/training adjustments. Maps to `TimeLog.netWorkedHours`. |
| **Training Hours (TR)** | Training hours credited for the day. Capped at `min(Worked Duration, defaultShiftHours)`. Maps to `TimeLogApproval.actualHours` for `TRAINING`-punchType records. |
| **Sick Leave Hours (SL)** | Approved, paid sick leave converted into hours based on the employee's scheduled shift. **Open item:** paid/unpaid status is tracked per leave *request* (`Leave.isPaid`), not per leave *type* — "sick vs. vacation" is not itself the determining factor for whether hours count here. Full leave-module semantics are scoped separately — see Open Items. |
| **Overtime Hours (OT)** | Hours exceeding the regular work requirement for the cutoff period, after excluding non-worked paid credits (TR, paid SL) from the threshold comparison. See Formulas below. |
| **Raw Overtime** | Time worked beyond the scheduled shift, before approval or payroll adjustment. Maps to `TimeLog.rawOtMinutes`. **Not used for payroll on cutoff-basis (80h/period) companies** — see `TIMELOG_MODULE.md`. Relevant for daily-basis (B&C) companies. |
| **Approved Overtime** | Raw Overtime that has been approved for payroll. For cutoff-basis companies this is a period-level approval (`CutoffOtBlock.status`), not per-punch. For daily-basis (B&C) companies it is closer to a literal per-punch approved raw OT. |
| **Time Zone** | The company's official time zone, used for all attendance and cutoff-boundary calculations (e.g. `America/Los_Angeles`). Always use `moment.tz(companyTimezone)` — never server-local time. |
| **Cutoff Status** | Two distinct state machines share this name informally — be specific about which one is meant. (1) **Record-level** — `TimeLogApproval.status`: `pending` / `approved` / `excluded`. (2) **Period-level** — `CutoffPeriod` status: open / locked / processed. |

---

## Formulas

```
Worked Duration      = Effective Clock-Out − Effective Clock-In

Net Worked Hours      = Worked Duration − Break Duration

Total Payable Hours   = Σ Net Worked Hours (approved, non-training/non-leave records)
                       + Σ Training Hours (TR)
                       + Σ paid Leave Hours (SL, or other paid leave once leave module is scoped)

OT Hours               = max(0, (Total Payable Hours − TR − SL) − Threshold)
```

`Threshold` is the cutoff-basis OT threshold (`cutoffOtThresholdHours`, e.g. 80h for a
bi-weekly 5+5 day DayCare cutoff — 10 working days × 8h). Applies to `otBasis: "cutoff"`
companies. B&C (`otBasis: "daily"`) uses a per-day threshold instead — see
`CUTOFF_PERIOD_MODULE.md`.

**Why TR and SL are subtracted rather than just excluded from the sum:** Training and paid
sick leave are flat, capped, non-OT-eligible credits. If they're left inside the total that
gets compared against the fixed period Threshold, they don't just get paid their own flat
amount — they also push other, genuinely worked hours across the OT line, generating OT
premium the employee never actually worked for. Subtracting them before the threshold
comparison means OT is earned only on hours actually worked beyond the period baseline.

**Status: IMPLEMENTED (server, TR only).** `cutoffOtService.computeOtForCutoffBasis` and the
`getCutoffApprovals` OT breakdown now exclude Training from the OT basis while keeping it in
TOTAL PAYABLE. This supersedes the OT basis logic shipped in Bug 6 (`CUTOFF_PERIOD_MODULE.md`,
v2.10.18), which included TR in the OT basis without subtracting it back out before the
threshold comparison — see that doc's Bug 6 entry for the full history. The **SL term is not
yet implemented** — leave still has no effect on OT basis or TOTAL PAYABLE in code today (see
Open Items). Historical backfill for periods already approved under the Bug 6 formula has not
been run yet — see Open Items.

---

## Open Items (Not Yet Implemented)

- **Leave module semantics.** `Leave.isPaid` exists in the schema but today is only read for
  `LeaveBalance` deduction bookkeeping — it has no effect on `TOTAL PAYABLE` or OT basis. The
  `leaveHours` field described in `CUTOFF_PERIOD_MODULE.md`'s "Approved Leave Handling" section
  does not exist in code; standalone leave rows carry no computed hours today. Full scope
  (SL vs. VL, paid/unpaid gating, per-employee-type hour lookup) is a separate discussion.
  Until this lands, SL has no code-level effect — it is already implicitly excluded from OT
  basis today (leave never had a `TimeLogApproval` row to begin with), which happens to match
  the target formula, but TOTAL PAYABLE does not yet add leave hours in.
- **Historical backfill.** Cutoff periods already approved under the Bug 6 formula (e.g.
  DayCare Jun 10–23, 2026) currently hold inflated OT values in `CutoffOtBlock`. The next read
  of `getCutoffApprovals` for an affected period will show the corrected breakdown/otHours, but
  the stored `CutoffOtBlock.otHours` only updates on the next recompute trigger (approve /
  reset / auto-exclude / bulk sync) — it will not silently fix itself. Scope and method
  (dry-run diff first, locked/processed period handling) to be decided before any write.

---

## Dropped Concepts

- **"Punch Type" as a clock-event classifier** (Clock-In / Clock-Out / Break-In / Break-Out /
  Manual Adjustment) was considered and dropped. `PunchType` already exists in the schema as a
  work-category/segment enum (`REGULAR`, `DRIVER_AIDE_AM`, `DRIVER_AIDE_PM`, `DRIVER_AIDE`,
  `TRAINING`) — reusing the name for a different concept would collide. No discrete
  punch-event log exists in the data model today (breaks are unstructured JSON, not event
  rows). If a real event-level log is ever built as its own feature, name and define this term
  then, grounded in the actual schema.

---

## See Also

- `docs/CUTOFF_PERIOD_MODULE.md` — cutoff approval actions, OT configuration, leave
  auto-exclusion, known bugs.
- `docs/TIMELOG_MODULE.md` — TimeLog computation fields, DRIVER_AIDE sync-back design, OT
  Status display.
