# Changelog — v2.11.24

**Branch:** `release/v2.11.24` (pushed 2026-11-25), from `origin/master` (after PR #138).

**Tickets:**
- BB-149 follow-up 1: Edit works on Training approvals. **Complete in dev (user, 2026-11-25: "seems to be fine now").**
- BB-149 follow-up 2: Reopen a processed cutoff + cutoff status history. **Awaiting test** (needs the SQL below first).
- BB-150: Payroll Grid Excel day labels (SL / VL / … / HOL / Absent / OFF). **Complete in dev (user: "the excel looks good").**
- BB-124 follow-up A: leave day times (shift + start–end) in leave details + preview, partial-day leave in the Payroll Grid, department name in leave lists. **Complete in dev (user: "seems to be fine already")**, client side in progress.
- BB-124 follow-up B: Driver/Aide Raw segment clock-out cap. **Awaiting test.**
- Data / check scripts: PadPro Nov 14 training-day fix (applied by the user), two read-only checks. **Kept for the record.**

**Schema change:** YES. New table `CutoffStatusEvent` (BB-149 follow-up 2). SQL `scripts/add-cutoff-status-events-bb149.sql` (not committed, the user runs it). Order: **merge → run the SQL → `prisma generate` → deploy.** Until the table exists, Reopen answers 503 `REOPEN_NOT_READY` and status changes simply record no history; nothing else is affected. The SQL matches Prisma's own naming, so the Render pre-deploy `prisma db push` finds nothing to change.
**Env:** none. **Data scripts to run after deploy:** none.
**Client impact:** yes. Hand-offs `docs/client-update-BB-149-reopen.md` (Reopen button, reason dialog, paid warning, history, outdated export) and `docs/client-update-BB-124-leave-times.md` (leave day times, department name). Not sent. BB-150 and the Raw segment cap need no client change.
**Mobile impact:** none required. The leave day `windows` can be used by the app if it shows leave details.

---

# BB-149 follow-up 1 — Edit works on Training approvals

- **What:** on the cutoff page, Edit → Save on a Training row did nothing: the Training approval ran before the edited times were read and always used the real punch times (the old capped code ignored edits the same way).
- **Now:** edited times replace the punch times before the hours are worked out (net hours, BB-149 rules), and the approval stores them as approvedClockIn/Out. The real punch is kept in `originalTimeIn/Out` (only if empty), so Reset brings it back, exactly like a Regular edit. Edit may pay more than punched (user OK'd, same as Regular).
- Refused with a message: clock-out not after clock-in, longer than 24 h, invalid time. An open punch can be approved if Edit supplies a clock-out. Bulk approve unchanged (no Edit).
- **Changes:** `src/services/Cutoff/daycareCutoffStrategy.js` (`approvedTrainingHours(timeLog, companyId, { editedClockIn, editedClockOut })` returns hours + the times used; single + bulk callers).
- **Endpoints:** none new (the existing approve call already sends `editedClockIn/Out`).

# BB-149 follow-up 2 — Reopen a processed cutoff + status history

- **What:** "processed" was final; a cutoff needing a correction after processing could only be reopened by a database script (PadPro Nov 11–24, 2026-11-25). User decisions: admins and B. Buddy may reopen, any time, with a clear warning once the payment date is reached; logged under BB-149.
- **Endpoint:** `POST /api/cutoff-periods/:id/reopen` `{ reason (5–500), confirmPaid? }`, admin / superadmin (B. Buddy included; the support staff id is stored).
  - processed → open only (a locked cutoff opens with `PATCH /:id/status`): 400 `REOPEN_NOT_PROCESSED`.
  - reason missing/short/long: 400 `REOPEN_REASON_REQUIRED`.
  - payment date reached (company zone; cutoff dates read as UTC calendar dates): 409 `REOPEN_CONFIRM_PAID` until `confirmPaid: true`.
  - status changed meanwhile: 409 `REOPEN_STATUS_CHANGED`. Table missing: 503 `REOPEN_NOT_READY`.
  - The status change and its history row are written in one transaction: no history row, no reopen.
  - Approvals keep their decisions; payroll export rows stay (shown as outdated) until processed again, which rebuilds them; no employee notification.
- **History:** every status change writes a `CutoffStatusEvent` row (who, when, B. Buddy staff id, reason for a reopen): `action` = `status` (Lock / Unlock / Mark Processed), `finalize` (Finalize Cutoff on the review page, gap spotted by the client session), `reopen`. Best effort for normal changes (never blocks). History starts with this release; periods the generator creates already "processed" have no row.
- **Responses:**
  - `GET /api/cutoff-periods`: each period adds `reopenCount`, `lastReopen`, and `payrollExport.outdated` / `outdatedDepartments`.
  - `GET /api/cutoff-periods/:id`: adds `statusHistory[]`, `reopenCount`, `lastReopen`.
  - `GET /api/payroll-export/by-cutoff-period/:id`: adds `outdated`, `outdatedDepartments`, `reopenedAt`.
  - Outdated = a department of that period was reopened and isn't processed again (not judged by `generatedAt`: processing another department rewrites the export but keeps the reopened department's old summary).
- **Notifications:** processing again after a reopen sends "Payroll Updated" (same code `CUTOFF_PROCESSED`, `payload.updated: true`) instead of a second "Payroll Processed". The period label in that notification is unchanged ("Cutoff #xxxxxx", parked until after BB-114 batch 1).
- **Changes:**
  - `src/prisma/schema.prisma`: model `CutoffStatusEvent` (+ `CutoffPeriod.statusEvents`).
  - `src/services/Cutoff/cutoffStatusEventService.js` (new, raw SQL): `recordStatusEvent`, `historyFor`, `historySummary`, `outdatedExports`, `wasReopened`, `paymentDateReached`.
  - `src/controllers/Features/cutoffPeriodController.js`: `reopenCutoffPeriod`; events in `updateCutoffStatus` and `finalizeCutoffPeriod`; history + outdated in the list and detail; "Payroll Updated".
  - `src/routes/Features/cutoffPeriodRoutes.js`: `POST /:id/reopen`.
  - `src/controllers/Payroll/payrollExportController.js`: `outdated` on the export.
- **Order:** merge → `scripts/add-cutoff-status-events-bb149.sql` → `prisma generate` → deploy.

# BB-150 — Payroll Grid Excel: day labels

- **What:** an empty day cell could mean day off, leave, holiday or a no-show. Excel only (`format=payroll`); the CSV (`payroll-csv`) keeps its blanks and columns.
- **Now:** on the dates someone punched (same columns as before; the user dropped "every date"), a day with no hours shows one label across AM / Regular / PM:
  - leave code from the leave type: SL sick, VL vacation, otherwise initials (reserved codes → LV); grey = unpaid; two leaves = "SL/VL";
  - **HOL** company holiday; **Absent** scheduled, no punch, no leave, day over (spelled out at the user's request; was "ABS"); **OFF** no shift.
  - Hours always win; labels add no hours; totals unchanged. Future days get only leave / holiday labels. Legend line lists the codes used.
  - Scheduled / absent reuse `attendanceAnalyticsService.buildAttendance` (BB-133 rules: shift assignments, company zone, clamped to today).
- **Changes:** `src/services/Reports/punchLogPayrollGrid.js` (`buildDayLabels`, `buildPayrollGrid(actor, query, { labels })`), `src/utils/generatePayrollGridXlsx.js`, `src/controllers/Reports/punchLogReportController.js` (labels for Excel only).
- **Not changed:** employees with no punch in the range are still not listed; very old leaves without per-day rows get no label. VL total column not added (VL unpaid at PadPro).

# BB-124 follow-up A — Leave day times, partial-day leave in the grid, department name

- **What:** a partial-day leave (sick on the Driver/Aide PM shift only, AM + Regular worked) looked wrong: the details showed only "1.25h Paid" next to a 6.75h punch day, and the Excel PM cell was blank. Read-only `scripts/check-leave-day-shifts.js` (PadPro Nov 11–24): 11 leave days, 10 full, 1 partial, 0 overlaps / mismatches.
- **Now:**
  - New `leaveUtils.leaveDayWindows`: the windows a leave charges per day (shifts not deselected, in the shift's zone, with names; else the entered times; else the whole day). The single source for the BB-124 overlap block (behaviour unchanged), the leave details and the grid. Read live from shift assignments (a leave day stores no shift).
  - `GET /api/leaves/:id/days` and `GET /api/leaves/:id/preview`: each day adds `windows[] = { kind, shiftName, start, end, timeZone, zoneLabel, hours }`. Additive.
  - `GET /api/leaves` + `/pending`: `User.department = { id, name }` (details showed "Department: Not specified").
  - Payroll Grid Excel: on a day with hours, the leave code goes in the empty AM / Regular / PM cell of the shift it covers; every leave code has a hover note (type, hours, paid, shift + times).
- **Changes:** `src/utils/leaveUtils.js`, `src/controllers/Features/leaveController.js`, `src/services/Reports/punchLogPayrollGrid.js`, `src/utils/generatePayrollGridXlsx.js`.
- **Known gap (not built, possible ticket):** leave on PART of a single long shift (e.g. 1:00–5:00 of an 8:00–5:00 shift) isn't supported: typed times are only used on no-shift days, and the overlap block refuses it.

# BB-124 follow-up B — Driver/Aide Raw segment clock-out cap

- **Rule (user, 2026-11-25):** Schedule = the company accepts the fixed segment window (unchanged); Raw = what actually happened.
- **Before:** Raw used the real clock-out only on the LAST segment; AM / Regular always ended at the segment end, so Raw paid past an early clock-out (clock-out 11:59 AM, Regular 8:00–1:30 paid 5.50h instead of 4.0h).
- **Now:** in Raw a segment ends at the earlier of its end and the real clock-out; a segment starting after the clock-out pays 0. Late clock-in rule and the 20-minute PM-end snap unchanged; no extra early-out grace. Single approve (also BB-125 Honor Punch) and bulk approve.
- **Changes:** `src/services/Cutoff/daycareCutoffStrategy.js` (`capRawSegmentOut`).
- **Check:** read-only `scripts/check-da-segments-paid-past-clockout.js` (approvals don't store the button; a last segment paid past the clock-out = Schedule). PadPro Nov: 53 rows, 49 PM = Schedule (correct by the rule; pattern of ~2:20 PM clock-outs just outside the 20-minute snap, ~23h in November, a policy call for PadPro); 3 Regular rows in the open Nov 11–24 cutoff may need Reset + Raw if Raw was meant (user to ask the approver).
- Past approvals unchanged until Reset + approve again.

# Scripts

- `scripts/fix-padpro-nov14-training-hours.js` (applied by the user 2026-11-25): PadPro training day Nov 14, 37 attendees' Training punches set to 8:00 AM–4:30 PM = 8.50h and approved (real times kept in originalTimeIn/Out; backup git-ignored, `--revert`). Two employees already updated by hand were skipped with `--skip` (no names stored in the file).
- `scripts/check-leave-day-shifts.js` (read-only): leave days with the shifts they charge, punches that day, FULL / PARTIAL / OVERLAP / MISMATCH / NO SHIFT.
- `scripts/check-da-segments-paid-past-clockout.js` (read-only): Driver/Aide segments paid past the clock-out, with a button guess.
