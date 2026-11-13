# Changelog — v2.11.9

**Branch:** `release/v2.11.9` (2026-11-13). **Schema change:** none. **Tickets:** BB-124 (data fix complete; Payroll Grid change awaiting the user's test). **Client:** no change.

---

# BB-124 — Josie Soriano, Nov 9: Driver/Aide punch vs. approved sick leave

**Status:** the data fix is complete and confirmed by the user on 2026-11-13. The Payroll Grid change is awaiting the user's test.

> On Nov 9, Josie clocked in at 6:51 AM, left for a doctor's appointment and was auto clocked out at shift end
> (2:45 PM). She filed a full-day Sick Leave (8h, paid) that morning, and it was approved. PadPro's
> "Automatically Resolve Punch-vs-Leave Conflicts" (on) honored the punch. The day ended up as 1.25h worked plus
> 8h paid sick leave, with the punch rewritten to 6:45 → 8:00 AM.

## Cause
- `daycareCutoffStrategy.resolveConflict` isn't Driver/Aide-aware:
  - It snaps the whole TimeLog to one shift from `fetchScheduleForDate` (6:45 → 8:00) and overwrites `timeIn`/`timeOut`.
  - It stamps the same times on all 3 segments.
- Its leave lookup compares the leave's noon timestamp with the morning punch (the BB-073 bug). The lookup found nothing, so the leave was never cancelled.

## Decision
- Leave takes precedence: exclude the punch and keep the 8h sick leave.
- No change to `resolveConflict` for now. Its Driver/Aide handling and the BB-073 lookup remain known issues, to be discussed with the auto-resolve setting.

## Data fix (run by the user, 2026-11-13)
- `scripts/fix-bb124-josie-nov9-exclude-punch.js` (dry run / `--apply` / `--revert`). The cutoff `cmvlr4bl30i5tsm4z6faocsk4` was unlocked for it, then re-locked.
  - The TimeLog is back to the raw punch (6:51 AM → 2:45 PM), and its segment/net hours are 0.
  - The 3 segment approvals are `excluded`, with the note "BB-124: leave takes precedence (manual fix)".
  - The Leave and its ledger are unchanged.
- The backup `scripts/backup-bb124-josie-nov9.json` is git-ignored and kept locally.

## Payroll Grid: sick leave on days with only excluded punches
- **Before:** on locked cutoffs, SL counted only on leave days with *no* reviewed punch. A day whose punches were all excluded (e.g. "Honor Leave") still blocked it, so Josie's 8h SL was missing.
- **Now:** a day whose punches are all "Excluded" doesn't block SL. A day with an approved or pending punch still does.
- Josie's row shows **SL 8**. Total stays 72 (the grid's Total never includes SL).
- **Not changed:** the cutoff review page (`cutoffPeriodController.getCutoffApprovals`, standalone leave rows) still treats such a day as punched. Josie's summary there shows 72h. The payroll export counts LeaveDay directly and was already right.

## Files
- `src/services/Reports/punchLogPayrollGrid.js`: the `punched` set in `sickLeaveHours` skips rows with `cutoffStatus === "Excluded"`.
- `src/utils/generatePayrollGridXlsx.js`: the grid footnote mentions excluded punches.
- `scripts/fix-bb124-josie-nov9-exclude-punch.js`: the one-off data fix (kept).

## Related, not in this release
- **BB-125:** Marites Fernandez, Oct 30. The punch was auto-honored, but her 5.5h sick leave was never cancelled or refunded (BB-073).
  - `scripts/check-bb125-marites-oct30.js` (read-only) confirmed it.
  - `scripts/fix-bb125-marites-oct30-cancel-leave.js` is written. Its dry run passed, and `--apply` is held for PadPro's confirmation that she worked that day.
  - It must be settled before cutoff `cmvlr4bcu0i5psm4zuanq41xx` is set to processed.
