# Changelog — v2.11.10

**Branch:** `release/v2.11.10` (2026-11-14). **Tickets:** BB-125 (built 2026-11-14, awaiting the user's test). **Schema change:** yes, `scripts/bb125-leave-revert.sql` (the user runs it, then `npx prisma generate`). **Client:** `docs/client-update-BB-125.md`. **Mobile:** questions at the end of that file.

**Deploy order:**
1. Run the SQL.
2. Run `prisma generate`.
3. Deploy the server.
4. Ship the client update.
5. Run `scripts/fix-bb125-marites-oct30-revert-leave.js` (dry run, then `--apply`).
6. Run `scripts/fix-bb125-relabel-reverted-leaves.js` (list, review, then `--apply`).

---

# BB-125 — Punch-vs-leave: revert the punched leave day ("Reverted")

> Marites Fernandez (Piedmont Adult Day Program) worked her full shift on Oct 30, a day she had an approved
> 5.5h Sick Leave. "Automatically Resolve Punch-vs-Leave Conflicts" (on) approved the punch on Nov 11, but the
> leave stayed Approved and Paid, and her balance stayed 5.5h short. PadPro confirmed she worked and asked why
> the leave wasn't reverted.

## Cause
- **The leave lookup compared timestamps.** In both strategies' `resolveConflict` (daycare and B&C): `startDate <= timeIn`. Leave dates are stored at noon (company zone), so any punch before noon never found its leave. This is the old BB-073 finding.
- **The failure was silent.** The leave step is best-effort, and Cutoff Review's auto-resolve sweep marked the leave "cancelled" in its response without checking.
- **The auto-resolve only runs when the cutoff's approvals are loaded** (Cutoff Review).
- **When the lookup did work, it cancelled the whole request**, multi-day ones included.
- **Driver/Aide punches went down the regular path:** the TimeLog was snapped to one shift window and the same times were stamped on all 3 segments (see BB-124, Josie).

## Decision (PadPro, 2026-11-14)
- Honor the punch and give the leave back, with the status **Reverted**.
- Revert **only the punched day**.
- Driver/Aide is fixed too, in Raw mode.
- Past whole-leave cancels from this path are relabelled to Reverted.

## What changed
- **Schema** (`scripts/bb125-leave-revert.sql`):
  - `leaveStatus` gains `reverted`.
  - `LeaveTransactionType` gains `reverted`.
  - `LeaveDay` gains `revertedAt` and `revertedTimeLogId`.
- **`src/services/Cutoff/leaveConflictCredit.js`**, rewritten:
  - `revertLeaveDayOnConflict` reverts one day:
    - stamps that day's LeaveDay rows;
    - returns their paid hours to the balance and to the same fiscal-year lots;
    - lowers `actualPaidHours`/`actualUnpaidHours`;
    - writes ledger `reverted` + `adjustment` rows;
    - sets the leave to `reverted` once every day is.
  - A legacy leave with no LeaveDay rows is reverted whole.
  - `findApprovedLeaveForDay` matches by calendar date.
  - `revertLeaveForPunch` and `honorPunchResult` are shared by both strategies.
- **`src/services/Leave/leaveCreditService.js`**: `restoreToLots` returns part of a leave. Usage rows are reduced, and deleted only when fully returned.
- **`src/services/Cutoff/daycareCutoffStrategy.js`**:
  - The Driver/Aide approval was moved out into `approveDriverSegment`, which both `approveSingle` and `resolveConflict` use.
  - Honor Punch on a Driver/Aide punch approves that segment in Raw mode, with no TimeLog rewrite.
  - Regular punches keep their existing honor-punch handling.
- **`src/services/Cutoff/bncCutoffStrategy.js`**: Honor Punch uses the per-day revert.
- **`src/controllers/Features/cutoffPeriodController.js`** (getCutoffApprovals):
  - Reverted days don't raise conflicts or leave rows.
  - The auto-resolve sweep reflects only what really happened.
  - Leave type names show on conflict rows instead of policy ids.
- **Reverted days stop counting everywhere** (`revertedAt: null`):
  - `payrollExportService.js`
  - `fixedHoursService.js`
  - `punchLogPayrollGrid.js`
  - `leaveReportService.js` (×2)
  - `leaveTemplateReportService.js`
  - `leaveCalendarReportService.js`
  - Cutoff Review's leave rows
- **`src/controllers/Features/leaveController.js`**:
  - `reverted` is allowed as a list filter.
  - List responses gain `reversion`.
  - `GET /:id/days` gains `reverted` / `revertedAt`.
- **Leave Requests report** (`leaveRequestsReportService.js`, PDF, Excel):
  - "Reverted" status and "Partly reverted" label.
  - Reverted count; no Pay pill for reverted leaves.
  - Explanation note on the PDF.

## Scripts (the user runs them)
- `scripts/bb125-leave-revert.sql`: the schema change. Delete it once applied.
- `scripts/check-bb125-marites-oct30.js`: read-only. It already confirmed the BB-073 pattern.
- `scripts/fix-bb125-marites-oct30-revert-leave.js`: dry run / `--apply`. It reverts her 10-30 day, sets the leave to Reverted and her balance from 13 to 18.5h. It must run before cutoff `cmvlr4bcu0i5psm4zuanq41xx` is processed.
- `scripts/fix-bb125-relabel-reverted-leaves.js`: lists every leave cancelled by this path, all companies. `--apply` relabels them to Reverted and stamps their days; `--revert` undoes it. No balance changes, since the refunds already happened.

## Release note (2026-11-14)
The SQL and the two data scripts ran **before** this server was deployed. v2.11.9's Prisma client doesn't know the `reverted` status, so live leave lists that contained one of the 6 reverted leaves failed to load until v2.11.10 was deployed. **Next time a schema change adds an enum value, deploy the server before any script writes it.**

## Not changed
- Honor Leave.
- Regular (non-Driver/Aide) daycare Honor Punch timing (schedule snap).
- The auto-resolve still runs when Cutoff Review loads the cutoff (no background job).
- The cutoff review page's rule from BB-124 (a day with only excluded punches doesn't show its leave row) is still open.
