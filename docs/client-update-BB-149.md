# Client update — BB-149 Training days: 8-hour cap removed

**Server:** next push (version chosen at `/push`). **Web:** wording only (no new fields, no endpoint changes). **Mobile:** none. **Status:** built 2026-11-25. **Database change:** none.

## What changed (DayCare companies, `punchType = "TRAINING"`)
| | Before | Now |
|---|---|---|
| Punch log hours (before approval) | Flat `defaultShiftHours` (8h) whatever the punch length — a 3h training showed 8h | Real **net hours**: clock span − coffee breaks − lunch deduction (company minimum lunch applies, same as a regular punch). No shift snap. |
| Cutoff approval `actualHours` | `min(clock span, 8h)`, nothing deducted | The same net hours as the punch log, **no cap**. A 10h training day pays 10h (minus lunch). |
| OT (80h-per-period basis) | Training left out of the OT count | Training **counts toward OT** like any other worked hour. |
| Open training punch (no clock-out) | Approved as 8h | Approval refused: *"This training punch has no clock-out yet. Approve it after the employee clocks out."* (bulk approve counts it as failed) |

Daily-OT companies already counted training — no change there.

## Web — what to check
1. **Any "8h" / "capped" / "flat" wording** next to Training (punch type picker, cutoff review, tooltips, help text): remove it. Suggested help text: *"Training is paid for the time worked, like a regular punch (breaks and lunch deducted). It counts toward overtime."*
2. **OT breakdown** (`GET /api/cutoff-periods/:id/approvals` → `otBlocks[].breakdown`): `days[]` rows with `isTraining: true` are still returned separately, but **`breakdown.totalHours` now includes them**. If the page greys them out or labels them "not counted"/"excluded", change that to a plain "Training" label. If the page adds up `days` itself and skips training rows, stop skipping them.
3. **Training hours shown from the punch** (`netWorkedHours` / `display`): now the real hours, so a short training shows less than 8h. No code change unless the page hard-codes 8.
4. **Approve on an open training punch** now returns 400 with the message above; show it as-is.

## Past records
Only new approvals and recomputes use the new rule. Training already approved in an open cutoff keeps its old (capped) value until it's Reset and approved again. Locked/processed cutoffs are not changed.
