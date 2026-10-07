# Changelog — v2.10.48

> **BB-092** — Driver/Aide punches now deduct the punched lunch. Before, the lunch was recorded and
> shown as "Lunch Break", but never subtracted from the hours. The lunch now comes out of whichever
> segment it falls in (AM, Regular or PM), both on the punch log and when cutoff segments are
> approved. Jasbleidi Mendoza's existing punches (Piedmont Adult Day Program) were corrected with a
> staged one-off script.

---

## BB-092 — Driver/Aide lunch deduction by segment ✅ Server complete

**Why:** Jasbleidi Mendoza, 09/30/2026, Driver/Aide punch 07:04 AM → 02:18 PM, lunch 08:17 → 08:46 AM.
The breakdown showed **Lunch Break 0.47h**, but Total Clock Hours was **7.23h** = AM 0.93 + Regular 5.50
+ PM 0.80. Nothing was deducted.

Root cause: in `computeTimeLogSummary`, only the REGULAR path subtracted `lunchDeductionMinutes`. For
DRIVER_AIDE, `netWorkedHours` was the plain sum of segment hours, and the lunch value was only stored
and displayed. Segment approval in the DayCare cutoff strategy also calculated `actualHours` from the
approved window, ignoring lunch, so even a fixed punch log would have lost the deduction on approval.

### The rule

- A lunch is subtracted from the segment window it falls in. If it crosses a boundary (e.g. 01:15 →
  01:45 PM), each segment loses its own overlap.
- Only an actual lunch punch counts, or an auto-injected lunch marked deductible. Auto lunches marked
  `deductible: false` are ignored (same rule as coffee breaks).
- The company `minimumLunchMinutes` floor does **not** apply to Driver/Aide punches. No lunch punch
  means no deduction.
- It applies to both **Approve Schedule** and **Approve Raw**.
- REGULAR punches are unchanged; they already deducted lunch.
- B&C punches are unaffected (separate strategy, `bncStrategy.js`).

Example (09/30): Regular 5.50 → **5.03h**, total 7.23 → **6.76h**.

### `timeLogComputeUtils.js`

- New `lunchOverlapMs(lunchBreak, windowStart, windowEnd)`: the ms of a completed, deductible lunch
  inside a window. The compute service and the cutoff strategy share it, so both apply the same rule.

### `timeLogComputeService.js` (punch logs + pending approvals)

- `computeSegmentHours` takes an optional `lunchBreak` and subtracts its overlap with the window, after
  the window is clamped to clock-in/out.
- The Driver/Aide path passes `log.lunchBreak` for all three segments, so `netWorkedHours` (the segment
  sum) now excludes lunch.
- For Driver/Aide, `lunchDeductionMinutes` now stores the minutes **actually deducted** (overlap with
  the segment windows). Before, it held `max(lunch, minimumLunchMinutes)` even though nothing was
  deducted. "Lunch Break" now matches the hours removed.

### `daycareCutoffStrategy.js` (segment approval)

- `approveSingle` and `approveBulk`: segment `actualHours` = credited window − lunch overlap with that
  window. The Regular `defaultShiftHours` cap is still applied afterwards.
- The existing sync-back (`syncApprovedSegmentsToTimeLog`) then writes the reduced hours to the punch
  log, so Punch Logs and Cutoff Approval stay in agreement.

### What existing records do

| Record state | Effect of this release alone |
|---|---|
| New punches | Deducted at clock-out |
| Pending, open cutoff | Deducted when the cutoff is **Synced**, a segment is approved, or the punch is edited |
| Fully approved | Not changed: Sync recomputes, then the sync-back restores the approved hours (BB-040 behavior) |
| Locked / processed cutoff | Not changed |

### Data correction — Jasbleidi Mendoza (one-off)

Scope check (`check-bb-padpro-da-lunch-not-deducted.js`): Piedmont had 16 completed Driver/Aide punches
with any lunch recorded. 15 were not deducted, totaling 25.27h. 9 of those are Jasbleidi's (09/21 → 10/02).

`fix-bb092-jasbleidi-lunch-deduction.js` is staged. It runs as a dry run by default, `--apply` writes,
and `--revert` restores from the backup JSON. It updates `TimeLog` segment hours, `netWorkedHours` and
`lunchDeductionMinutes`, and, for approved segments, `TimeLogApproval.actualHours` / `scheduledHours`.
It skips any segment already deducted, and any punch whose hours match neither the deducted nor the
undeducted value.

| Date | State | Regular | Total |
|---|---|---|---|
| 09/30 (stage 1) | pending | 5.50 → 5.03 | 7.23 → 6.76 ✅ applied and verified in Punch Logs |
| 09/21 (stage 2) | **approved** | 5.50 → 4.99 | 7.58 → 7.07 |
| 09/22 (stage 2) | pending | 5.50 → 5.07 | 7.11 → 6.68 |
| 09/23 (stage 2) | pending | 5.50 → 4.90 | 7.21 → 6.61 |
| 09/24 (stage 2) | pending | 5.18 → 4.48 | 5.99 → 5.29 |
| 09/28 (stage 2) | pending | 5.50 → 5.20 | 7.60 → 7.30 |
| 10/01 (stage 2) | pending | 5.50 → 4.87 | 7.44 → 6.81 |
| 10/02 (stage 2) | pending | 5.50 → 5.06 | 7.10 → 6.66 |

All of these punches are in open cutoffs (09/15–09/28, 09/29–10/12).

### ⚠️ Open item — 09/25 left untouched on purpose

TimeLog `cmuh1d8ix039jsj50p3a6zzpr` (Jasbleidi, 09/25): the lunch runs 08:32 AM → 02:21 PM (348.7 min),
so it was clearly never ended. It was excluded from the fix script; the lunch is to be corrected through
an admin edit. **That edit must happen before cutoff 09/15–09/28 is synced or approved.** Otherwise
the new rule deducts 5.81h and leaves 1.41h for the day.

Other employees' Driver/Aide punches with a lunch (Amgao ×4, Brazil, Chavez: May–Aug 2026) were left as
they are. Several have implausible lunches (188–442 min) or ~1-minute accidental taps.

### API contract

No endpoint or payload shape changes. Values change only:
- For Driver/Aide punches, `regularSegmentHours` / `driverAmSegmentHours` / `driverPmSegmentHours` and
  `netWorkedHours` are now net of lunch.
- For Driver/Aide punches, `lunchDeductionMinutes` = minutes actually deducted.

**Client-side impact:** none required. The breakdown shows the corrected hours as is.
Follow-up (BB-092 follow-up, client only, `EmployeesPunchLogs.jsx` → `DriverAideBreakdown`): an ⓘ tooltip
on Lunch Break (lunch start → end, which segment it was deducted from), a "−0.47h lunch" note on the
affected segment row, and the AM time range on its row. To tell deducted from not-deducted (older)
records, the client compares stored segment hours against the clamped window hours. It does **not** use
`lunchDeductionMinutes`, because records calculated before this release still hold the full lunch there.

**Files Changed:**

| File | Change |
|---|---|
| `src/services/timeLogComputeUtils.js` | New `lunchOverlapMs` helper |
| `src/services/timeLogComputeService.js` | Driver/Aide segments subtract lunch overlap; `lunchDeductionMinutes` = actual deduction |
| `src/services/Cutoff/daycareCutoffStrategy.js` | Single and bulk segment approval subtract lunch overlap from the credited window |

**One-off scripts (kept in `scripts/`, untracked):**
- `check-bb-padpro-da-lunch-not-deducted.js`
- `check-bb092-jasbleidi-lunch-recalc-preview.js`
- `fix-bb092-jasbleidi-lunch-deduction.js`
- `backup-bb092-jasbleidi-lunch-*.json`
