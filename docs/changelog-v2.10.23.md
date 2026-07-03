# Changelog — v2.10.23

> Bug 6 superseded: Training hours excluded from the OT basis again (kept in TOTAL PAYABLE); new shared timekeeping glossary; Piedmont cutoff periods backfilled.

---

## Formula Change

### Training No Longer Counts Toward the OT Threshold (Supersedes Bug 6)

**Files:** `src/services/Cutoff/cutoffOtService.js` → `computeOtForCutoffBasis`;
`src/controllers/Features/cutoffPeriodController.js` → `getCutoffApprovals` OT breakdown

**Problem:** Bug 6 (v2.10.18) folded Training `actualHours` into the OT basis so it wouldn't be
invisible to the period threshold. This was incomplete: Training is a flat, capped,
non-OT-eligible credit, but leaving it inside the total compared against the fixed 80h
threshold didn't just pay its own flat amount — it also pushed other, already-worked hours
across the OT line, manufacturing OT premium the employee never worked for. Concrete example:
10 real work days (87.38h) + 1 training day (8h, capped) produced 15.38h OT under Bug 6, when
only 7.38h was actually earned by worked hours beyond the 80h/10-day baseline.

**Fix:** `computeOtForCutoffBasis` again excludes `TRAINING`-punchType records from the OT-basis
sum, while continuing to count them in `TOTAL PAYABLE` (payable and OT basis now deliberately
diverge). The `getCutoffApprovals` OT breakdown (`otBlocks[].breakdown.totalHours`) was updated
to match — training rows still render in the breakdown for visibility but no longer count
toward the threshold comparison.

**Why this isn't a straight revert:** Bug 6 correctly identified that Training needed to be
*visible* somewhere (TOTAL PAYABLE) — it just shouldn't have entered the OT threshold
comparison. The full reasoning and the canonical formula now live in the new glossary doc
below.

---

## New Doc: Shared Timekeeping Glossary

**File:** `docs/TIMEKEEPING_GLOSSARY.md`

Canonical term definitions (Raw/Effective Clock-In/Out, Worked Duration, Net Worked Hours,
Training Hours, Sick Leave Hours, Overtime Hours, Raw/Approved Overtime, Time Zone, Cutoff
Status) and the core formulas, intended to be copied into the client-side app so server and
client share one definition. Also documents the OT formula reasoning, open items (leave-module
semantics not yet implemented, `Leave.isPaid` currently unused for payroll), and a note on a
considered-and-dropped "Punch Type" concept (name collision with the existing `PunchType`
enum).

`docs/CUTOFF_PERIOD_MODULE.md` and `docs/TIMELOG_MODULE.md` now link to it instead of
redefining terms locally.

---

## Data Backfill

### Piedmont Adult Day Program — Two Cutoff Periods Recomputed

**Periods:** May 27 – Jun 09, 2026 and Jun 10 – Jun 23, 2026 (plus duplicate-period rows with
no approved data, skipped automatically)

All `CutoffOtBlock` rows for these periods were recomputed with the corrected formula. 13 of 19
affected (period, user) pairs changed:

| Outcome | Count |
|---|---|
| Corrected downward, flipped `approved → pending` (re-review required) | 8 |
| Corrected downward, already `pending` | 4 |
| Removed entirely (new OT = 0, block deleted) | 6 |
| Already correct going in (live server had already recomputed during dev) | 1 |

Example: Daynee Cuaresma, Jun 10–23 — `95.38h total / 15.38h OT (approved)` →
`87.38h total / 7.38h OT (pending)`.

**Verification:** a post-backfill sweep recomputed the expected OT for every `CutoffOtBlock` row
across all cutoff-basis companies directly from `TimeLogApproval` records and compared against
the stored value — 0 mismatches.

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/verify-ot-formula-daynee.js` | Read-only: old vs. new formula comparison for one employee/period |
| `scripts/backfill-ot-dryrun.js` | Read-only: scopes every (period, user) pair company-wide where old vs. new OT differ |
| `scripts/backup-and-backfill-ot.js` | Backs up all `CutoffOtBlock` rows for affected periods to JSON, then calls the real `recomputeAllOtForCutoff` service to apply the fix |
| `scripts/backups/cutoffOtBlock-backup-2026-07-03T03-49-56-287Z.json` | Pre-backfill snapshot (17 rows) — restore source if needed |

---

## Files Changed

| File | Change |
|---|---|
| `src/services/Cutoff/cutoffOtService.js` | `computeOtForCutoffBasis` excludes Training from OT basis |
| `src/controllers/Features/cutoffPeriodController.js` | OT breakdown `totalHours` excludes training rows from the sum |
| `docs/TIMEKEEPING_GLOSSARY.md` | New — canonical term/formula reference shared with client |
| `docs/CUTOFF_PERIOD_MODULE.md` | Bug 6 marked superseded; OT Configuration and client-side display rules rewritten |
| `docs/TIMELOG_MODULE.md` | Cross-link to new glossary |

---

## Open Items (Not in This Release)

- Leave-module semantics (`Leave.isPaid` gating, `leaveHours` computation, SL vs. VL) — scoped
  separately, tracked in `docs/TIMEKEEPING_GLOSSARY.md` Open Items.
- Client-side verification that `otBlocks.breakdown` / `TOTAL PAYABLE` render correctly against
  the corrected server response — pending.
