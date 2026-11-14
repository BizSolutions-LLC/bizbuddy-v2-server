# Changelog — v2.11.11

**Branch:** `release/v2.11.11` (2026-11-14). **Tickets:** BB-125 follow-up (code fix + audit correction scripts). **Schema change:** none. **Client:** no change.

---

# BB-125 — Honor Punch exported 0h for regular daycare punches

## Cause
- The payroll export (`payrollExportService.js`, built when a cutoff is set to processed) pays each approved punch by `TimeLogApproval.actualHours`.
- `daycareCutoffStrategy.resolveConflict`'s honor-punch path for **regular** punches set `approvedClockIn/Out` and `scheduledHours` but never `actualHours`.
- Every punch honored over a leave, by the setting or by Honor Punch, therefore exported **0h**, while Cutoff Review and the Payroll Grid (which work hours out from the approved times) showed the right hours.
- Before v2.11.10, Driver/Aide punches went through the same path. v2.11.10 moved them to the segment approval, which sets `actualHours`.
- B&C's honor-punch path already sets `actualHours`.

## Fix
- `src/services/Cutoff/daycareCutoffStrategy.js`: the regular honor-punch path sets `actualHours` to the hours of the approved window, the same rule as the normal Approve (`approveSingle` REGULAR), and calls `syncApprovedRegularToTimeLog` so `TimeLog.netWorkedHours` matches.

## Past records
Found by the read-only audit `scripts/check-bb125-punch-wins-history.js` (+ `.sql`). User decisions (2026-11-14):
- **Already-paid dates stay as paid.** Their empty `actualHours` is not backfilled.
- **Albert Dalere** 7-27 and 7-28: the excluded segments are trusted, no change.
- **Evelyn Garnace:** leaves already `reverted` by the v2.11.10 relabel; nothing to return.

Audit corrections run by the user:
- `scripts/fix-bb125-elizabeth-aug07-revert-leave.js`: Elizabeth Pabilona 8-07 leave day reverted, +5.5h. Ledger wording fixed with `scripts/fix-bb125-ledger-note-wording.js`.
- `scripts/fix-bb125-elizabeth-aug25-revert-leave.js`: Elizabeth Pabilona 8-25 leave day reverted, +5.5h (paid 4.51h worked; the leave was filed the day after).
- `scripts/fix-bb125-robert-sep04-segments.js`: Robert Ramirez 9-04 was paid 11h through the shared-window bug. Corrected to Driver AM 1.25h + Regular 5.5h, Driver PM excluded, clock-in back to 6:38. His unpaid Sick Leave stays Approved (user: fine).
- `scripts/fix-bb124-josie-nov9-delete-punch.js`: Josie Soriano's excluded Nov 9 punch deleted, so Nov 9 is a plain 8h Sick Leave day. The backup holds every deleted row; `--restore` puts them back.

## Not changed / next
- **Proposed feature (ticket label TBD):** refuse a leave request on a day that already has a punch, unless the leave hours fall outside the punched hours, with several shifts per day supported like B&C. Elizabeth's 8-07 and 8-25 leaves were both filed after she had punched.
