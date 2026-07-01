# Changelog — v2.10.22

> DRIVER_AIDE timelog display fix: phantom Overtime row suppressed after approval; Jun 10–23 cutoff backfilled for all 21 employees.

---

## Bug Fixes

### DRIVER_AIDE Approved Punches: Phantom Overtime Row Suppressed

**File:** `src/services/Cutoff/daycareCutoffStrategy.js` → `syncApprovedSegmentsToTimeLog`

**Problem:** After all 3 DRIVER_AIDE segments were approved, the Employer Timelog view still displayed an "Overtime" row (e.g. "02:45 PM → 03:30 PM 0.48h") derived from `TimeLog.rawOtMinutes`. This value is computed at clock-out time and reflects pre-approval logic — for raw-mode PM approvals, the post-window time is absorbed into the PM segment's `actualHours` and is no longer meaningful post-approval. Displaying it as a separate OT row was misleading and contradicted the cutoff page.

**Fix:** `syncApprovedSegmentsToTimeLog` now also writes `rawOtMinutes: 0` when syncing approved segment hours back to the `TimeLog`. Since this function only fires when all 3 segments are `approved` (pendingCount === 0), the zero only applies to fully-approved punches — partial approvals are unaffected.

For DayCare/80h companies, per-punch OT is meaningless. OT is a period-level calculation (`CutoffOtBlock`) already surfaced via the `otStatus` field added in v2.10.19. The `rawOtMinutes` row in the UI is now correctly absent for approved punches.

---

## Data Backfill

### Jun 10–23 Cutoff: Segment Fields and rawOtMinutes Backfilled for All Employees

**Cutoff Period:** `cmp7p84rw05u0u44vj4b4obfg` (Piedmont Adult Day Program, Jun 10–Jun 23 2026)

All DRIVER_AIDE timelogs with fully-approved segments (all 3 segments = `approved`) were updated to reflect `TimeLogApproval.actualHours` values and have `rawOtMinutes` zeroed. Records with any excluded or pending segment were left untouched.

| Outcome | Count |
|---|---|
| Updated | 109 |
| Already in sync | 67 |
| Skipped (segments not all approved) | 37 |

The 37 skipped records include: Jun 13 (all-excluded — training day), and individual punches where one segment was excluded or pending (e.g. Josefina Chavez Jun 10 `driver_pm:excluded`, Evelyn Garnace several days with excluded segments).

**Test run:** Daynee Cuaresma Jun 10 was applied first in isolation to validate correctness before the full cutoff run.

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/backfill-daynee-syncback.js` | Daynee Jun 10 test backfill (dry-run safe; `--apply` to commit) |
| `scripts/backup-revert-daynee-jun10.js` | Snapshot/revert helper for Daynee Jun 10 test (`--save`, `--revert`) |
| `scripts/backfill-syncback-cutoff-jun10-23.js` | Full cutoff backfill for all employees (`--apply` to run; `--revert` to restore from JSON) |
| `scripts/backup-daynee-jun10.json` | Snapshot of Daynee Jun 10 pre-backfill values |
| `scripts/backup-syncback-cutoff-jun10-23.json` | Snapshot of all 109 pre-backfill values (revert source) |

---

## Files Changed

| File | Change |
|---|---|
| `src/services/Cutoff/daycareCutoffStrategy.js` | `syncApprovedSegmentsToTimeLog` also zeroes `rawOtMinutes` on full approval |
| `scripts/backfill-daynee-syncback.js` | Scoped to Jun 10 only; added `rawOtMinutes: 0` to update |
| `scripts/backup-revert-daynee-jun10.js` | New — snapshot/revert helper for Jun 10 test run |
| `scripts/backfill-syncback-cutoff-jun10-23.js` | New — full cutoff backfill with backup/revert support |
