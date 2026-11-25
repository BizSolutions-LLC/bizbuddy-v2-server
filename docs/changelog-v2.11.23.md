# Changelog — v2.11.23

**Branch:** `release/v2.11.23` (pushed 2026-11-25), from `origin/master` (after PR #137).

**Tickets:**
- BB-149: Training days paid as real net hours, 8-hour cap removed, Training counts toward OT. **Awaiting test** (user tests after deploy, starting with a PadPro employee's Nov 14 training punch, 7:30 AM → 6:00 PM).
- Cutoff data scripts (no ticket): PadPro Nov 11–24 reopen (applied by the user 2026-11-25), BizSolutions LLC cutoff check / clean-up / reopen (2026-11-24), BB-128 breadcrumb interval check. **Kept for the record** (data-fix scripts stay in `scripts/`).

**Schema change:** none. **Deploy:** needed (server code). No SQL, no `prisma generate`, no env change. No data scripts to run for this version.
**Client impact:** wording only for BB-149 (no endpoint or field changes). Hand-off `docs/client-update-BB-149.md` (not sent).
**Mobile impact:** none.

---

# BB-149 — Remove the 8-hour cap for Training days

- **What:** a Training punch (`punchType = TRAINING`, DayCare companies) was credited at most `Company.defaultShiftHours` (8h): a 10.5h training day paid 8h. Scoped first: valid, and in California required training is hours worked.
- **Before:**
  - punch log (TimeLog): a flat `defaultShiftHours` whatever the punch length (a 3h training showed 8h);
  - cutoff approval: `min(clock span, 8h)`, no break or lunch deduction;
  - OT (cutoff basis, 80h/period): Training left out (v2.10.18), because it was a "flat, capped credit".
- **Now (user decisions 2026-11-25):**
  - Training = **net hours like a regular punch**: clock span − coffee breaks − lunch deduction (deductible auto lunch → its value; punched lunch → max(punched, company minimum); none → company minimum). No shift snap, **no cap**. Same number on the punch log and the approval.
  - Training **counts toward OT** on the cutoff basis. Daily-OT companies already counted it.
  - All companies, no setting.
  - Approving an open Training punch (no clock-out) is refused: "This training punch has no clock-out yet. Approve it after the employee clocks out." (bulk approve counts it as failed). It used to be approved as 8h.
- **Changes:**
  - `src/services/timeLogComputeService.js`: new pure `computeTrainingHours(log, company)` (exported). The lunch rule moved into `lunchDeductionFor`, shared by REGULAR and TRAINING; the regular path computes exactly as before.
  - `src/utils/punchTypeUtils.js`: `applyTrainingFlatHours` → `applyTrainingHours`: writes `netWorkedHours`, `scheduledHours` (= net), `grossHours`, `lunchDeductionMinutes`, `totalBreakMinutes`, `calculatedAt`. An open punch is returned unchanged.
  - `src/controllers/Features/requestPunchLogController.js`: rename only.
  - `src/controllers/Features/timeLogController.js` (punch-type change): its own flat-8h copy removed; TRAINING now goes through `computeTimeLogSummary` like every other type.
  - `src/services/Cutoff/daycareCutoffStrategy.js`: new `approvedTrainingHours` (recomputes the TimeLog, then uses its net hours) for single and bulk approve. The Driver/Aide regular-segment cap at `defaultShiftHours` is a separate rule and is unchanged (its variable is now `maxRegularSegHours`).
  - `src/services/Cutoff/cutoffOtService.js` (`computeOtForCutoffBasis`): Training no longer subtracted from the OT basis.
  - `src/controllers/Features/cutoffPeriodController.js` (`getCutoffApprovals` OT breakdown): `breakdown.totalHours` includes training rows; rows keep `isTraining: true` for the label.
  - `docs/TIMEKEEPING_GLOSSARY.md`: Training definition and OT formula updated, with history.
- **Endpoints:** no new endpoints, no new fields. Changed values: Training `netWorkedHours` / `scheduledHours`, approval `actualHours`, `otBlocks[].breakdown.totalHours`, cutoff OT blocks.
- **Past records:** only new approvals and recomputes. Training already approved in an open cutoff keeps its capped value until Reset + approve again. Locked/processed cutoffs untouched.
- **Note:** a short training now loses the company minimum lunch like a regular punch (3h with a 60-minute minimum → 2h). One-line change if short training should skip the minimum.
- **Order of steps:** merge → deploy → approve (or Reset + approve) the Training punches in the open PadPro Nov 11–24 cutoff → lock + process again (rebuilds the payroll export) before the Nov 27 pay date.
- **Client:** `docs/client-update-BB-149.md`: drop "8h"/"capped" wording; OT breakdown training rows count toward the total (no "not counted" styling); show the new open-punch message.

---

# Cutoff data scripts (no ticket)

Data-fix and check scripts kept in `scripts/` (backups `scripts/backup-*.json` are git-ignored and stay local).

- `scripts/fix-padpro-reopen-nov11-24-cutoff.js` (2026-11-25): reopens PadPro's 2026-11-11 → 11-24 cutoffs (Staff, Staff Supervisor, Driver/Aide; processed by a person 2026-11-24 2:36 PM / 3:33 PM LA, not by the generator). Changes only `CutoffPeriod.status`; approvals and payroll export rows kept (export rebuilt when processed again). Dry run default, `--department`, `--apply` (backup), `--revert`. **Applied by the user.**
- `scripts/check-bizsolutions-dev-team-cutoff-status.js` (2026-11-24, read-only): which BizSolutions LLC Development Team cutoffs are processed / open / locked, with payroll export rows.
- `scripts/fix-bizsolutions-delete-pre-november-cutoffs.js` (2026-11-24): deletes the pre-November 2026 BizSolutions LLC periods that "Generate cutoff periods" created and auto-marked processed; only periods with no approvals, OT blocks, fixed hours, payroll export or punches.
- `scripts/fix-bizsolutions-reopen-sales-nov1-15-cutoff.js` (2026-11-24): reopens BizSolutions LLC Sales & Marketing 2026-11-01 → 11-15.
- `scripts/check-bb128-breadcrumb-intervals.js` (2026-11-24, read-only): BB-128 expected vs saved GPS points per punch, gaps, foreground/background, upload delay. Progress rerun planned 2026-11-27 (`--from 2026-11-24 --to 2026-11-27`).
- Root cause seen, not fixed (own ticket if wanted): `services/Cutoff/cutoffGenerationService.js` creates a period that already ended as "processed".

---

# Found during BB-121 testing, on hold (not in this version)

BizSolutions LLC (company zone LA, Development Team shifts in Manila): `timeLogComputeService` reads every shift in the company zone (late / past-shift / undertime flags wrong, e.g. "Late 476m" for an on-time Manila punch), and DayCare "Approve Schedule" looks the shift up by the punch's LA date but places its times in Manila on that date, so the schedule can end before the clock-in and store **negative hours** (a Development Team punch on Nov 1 was approved at −15h). The Calendar's "Schedule" preview (client) also reads the shift in LA. Proposed fix (about a day): shift zone in `timeLogComputeService` + approval date in the shift's zone + never store negative hours; then Reset Nov 1 and Sync the cutoff (no script). Waiting for the user (ticket label, scope).
