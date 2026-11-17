# Changelog — v2.11.16

**Branch:** `release/v2.11.16` (pushed 2026-11-18), from `origin/master` (after PR #127).

**Tickets:**
- BB-129 phases 1 + 2 Custom forms (builder, assignment, answering, PDF): **built, user OK'd in dev 2026-11-18**.
- BB-133 Overview page corrected numbers + `/super-dashboard` route lock: **complete 2026-11-18** (user accepted; any bug found later gets a follow-up fix).
- BB-136 patient-based company: **answered** (no code; setup notes in CLAUDE.md).

**Schema change:** yes, additive only. Run in order:
1. `scripts/add-task-report-forms.sql`
2. `scripts/add-task-report-form-answers.sql`
3. `prisma generate`
4. deploy

Both scripts are already run in dev. BB-133 has no schema change.

**Client hand-offs:**
- `docs/client-update-BB-129-forms.md` (phase 1)
- `docs/client-update-BB-129-forms-phase2.md` (phase 2 + PDF, with a mobile section)
- `docs/client-update-BB-133.md`

**Mobile:**
- Clock-out (`POST /api/timelogs/time-out`) gains a top-level `taskReportForm` field. It's added only, so older builds ignore it.
- The questionnaire screens are for the mobile developer (hand-off phase 2, "Mobile").
- `/api/analytics/employee`: same URL, old fields kept. `patterns.usualClockIn/Out` are now `"HH:mm"`; the old text is in `…Label`.

---

# BB-129 — Clock-out documentation: custom forms (phases 1 + 2)

## What
Clock-out documentation gets a second kind next to the free-form Daily Task Report: questionnaires the admin builds (Google Forms style), answered per punch after clock-out. It started from BB-136: a care company names shifts after patients, so a form per shift is a form per patient.
- **Mode:** `Company.taskReportMode` = `freeform` (default) | `forms`. The modes are **exclusive**:
  - In `forms` mode, writing a free-form report is refused.
  - In `freeform` mode, questionnaires can't be answered.
  - Everything submitted stays visible on Employee Report.
- **Builder (admin only):**
  - Nine question types (short answer, paragraph, single choice, checkboxes, dropdown, yes/no, number, date, time), each with a required switch and help text.
  - Create, edit, duplicate, archive, restore, and delete only while the form has no answers.
- **Assignment:** to all, a department, an employee or a shift. One form per target. The most specific wins: shift → employee → department → all. Archived forms are skipped.
- **Answering:**
  - One answer set per punch. The form is snapshotted on the first save.
  - Draft, then submit; submit locks.
  - The answer window is `Company.taskReportFormWindowHours` after clock-out (default 336 h = 14 days). After it, a draft reads as **incomplete** and is locked as it is (computed on read, no job).
- **Clock-out pop-up and icon:**
  - The clock-out response says which form the punch has.
  - `/me/pending` lists open questionnaires for the "Answer questionnaire" icon. Auto clock-outs appear there too.
- **Review:**
  - Supervisors (department + direct reports) and admins see submitted and incomplete questionnaires, view only.
  - Employee Report merges them with free-form reports via `?include=forms`.
- **PDF:** submitted questionnaires only, same layout as the Daily Task Report PDF. View inline or download.

## Changes
**New files:**
- `scripts/add-task-report-forms.sql` and `scripts/add-task-report-form-answers.sql`: not committed, run by hand.
- `src/services/Features/taskReportFormService.js`: the builder rules and validation. Delete is blocked once a form has answers. Opening a form shows its assignments and answer count.
- `src/services/Features/taskReportFormAssignmentService.js`:
  - Assignment CRUD.
  - Resolving a punch's form: shift matched by `matchShiftToWindow`, with shift dates read as UTC calendar dates and the recurring-schedule fallback. Two queries per batch.
- `src/services/Features/taskReportFormResponseService.js`:
  - pending, open, save/submit
  - per-type answer validation; required questions checked on submit
  - history, view one with scope checks
  - PDF loader, team rows, clock-out prompt
- `src/controllers/Features/taskReportFormController.js` and `src/routes/Features/taskReportFormRoutes.js`: the `/api/task-report-forms` routes (admin builder + assignments; `/me…` with B. Buddy blocked; `/responses/:id[/pdf]`).
- `src/utils/generateTaskReportFormPDF.js`: the questionnaire PDF.

**Changed files:**
- `src/prisma/schema.prisma`:
  - New models `TaskReportForm`, `TaskReportFormAssignment`, `TaskReportFormResponse`.
  - New columns `Company.taskReportMode` and `Company.taskReportFormWindowHours`.
  - Back-relations on Company, User and TimeLog.
- `src/controllers/Account/companySettingsController.js`: `taskReportMode` (unknown value → 400) and `taskReportFormWindowHours` (whole hours 1–2160), admin only.
- `src/services/Features/dailyTaskReportService.js`:
  - In forms mode, free-form saves are refused with `403 TASK_REPORT_MODE_FORMS` and `canEdit` is false.
  - `/team` rows carry `kind`, and `?include=forms` merges questionnaire rows.
- `src/controllers/Features/timeLogController.js`: the clock-out response adds `taskReportForm`. It never fails the clock-out.
- `src/utils/generateDailyTaskReportPDF.js`: exports `drawSignature` for reuse. The daily report PDF itself is unchanged.
- `src/routes/index.js`: mounts `/api/task-report-forms`.

## Endpoints
**Settings** (`GET`/`PATCH /api/company-settings`): `taskReportMode`, `taskReportFormWindowHours`.

**`/api/task-report-forms`:**
- Admin builder: `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/duplicate`, `POST /:id/archive`, `POST /:id/restore`.
- Admin assignments: `GET /assignments`, `PUT /assignments`, `DELETE /assignments/:id`.
- Employee: `GET /me/pending`, `GET /me/responses`, `GET /me/punch/:timeLogId`, `PUT /me/punch/:timeLogId`.
- Owner, supervisor or admin: `GET /responses/:id`, `GET /responses/:id/pdf[?disposition=inline]`.

**Changed existing endpoints:**
- `POST /api/timelogs/time-out`: adds `taskReportForm`.
- `GET /api/task-reports/team`: adds `kind` and `?include=forms`.
- `PUT /api/task-reports/me/:date`: refused in forms mode.

## Open questions
- An optional "required questionnaire" mode (deferred by the user).
- The mobile build (mobile developer).
- Found, not fixed: `resolveShiftForTimeLog` uses a company-zone day range against `@db.Date`, so for zones west of UTC it picks the next day's shift. It affects the daily report's shift label and auto-breaks. The forms code doesn't use it.

---

# BB-133 — Overview page: corrected numbers

## What
The Overview pages showed wrong numbers. The client's draft listed 11 problems, all confirmed; six more were found:
- the range used the server clock
- cancelled shifts counted
- admin late/early were counted per punch
- hours ignored breaks
- leaves spanning the whole range were missed
- supervisors got company-wide data

**`/super-dashboard` route:**
- It allowed admin and supervisor, but the handler already refused non-superadmins, so it was **not actually exposed**.
- The route is now superadmin-only as well.

**Rules now** (one shared service):
- Company time zone; range ends today.
- Net worked hours (as Punch Logs).
- Cancelled shifts ignored; overnight shifts end the next day.
- Late = first clock-in after shift start + `gracePeriodMinutes`.
- Early out = last clock-out before shift end − `earlyClockOutGraceMinutes`.
- Absent = a scheduled day that's over, with no punch, not an approved leave day (`LeaveDay`, not reverted) and not a `Holiday`.
- Approved OT = `CutoffOtBlock` approved; hours beyond schedule shown separately.
- Averages per day worked.
- OT cost and the fake uptime/response time removed.
- Supervisors get a team scope on `/admin-dashboard`.
- Superadmin buckets days in UTC.

## Changes
- `src/services/Analytics/attendanceAnalyticsService.js` (new):
  - `resolveRange` (periods, company zone, clamp to today, custom limits).
  - `buildAttendance` (per person, per day: hours, scheduled hours, late, early out, absent, leave, holiday, approved OT, status, first in / last out).
  - It runs five queries per call, with no N+1.
- `src/controllers/Features/employeeAnalyticsController.js`: rebuilt on the service.
  - New: `totals.*`, `series.daily`, `patterns.*Label`, `averages.*PerDayWorked`, `timeZone`, `dateRange.periodEnd`.
  - Old names kept with corrected values.
  - The ×7 / ×30 averages removed.
- `src/controllers/Features/adminAnalyticsController.js`: `getAdminAnalyticsDashboard` rebuilt on the service.
  - Supervisor team scope.
  - New: `summary.approvedOvertimeHours`, `hoursBeyondSchedule`, `absences`, `scheduledShifts`, `charts.attendanceDaily`, `approvedHours` and `beyondScheduleHours` on the OT charts, `scope`, `timeZone`.
  - `cost` removed.
  - Leave days by type from `LeaveDay`.
  - `getAdminAnalytics` (`/admin`) unchanged.
- `src/controllers/Features/superAdminAnalyticsController.js`:
  - `/super-dashboard` uses the shared range in UTC, net worked hours and an overlap-based leave count.
  - `serverUptime` and `avgResponseTime` are `null` (were hard-coded); `/super` `serverUptime` is `null` too.
  - Adds `timeZone`, `dateRange.periodEnd`.
- `src/routes/Features/analyticsRoutes.js`: `/super-dashboard` uses `authorizeRoles("superadmin")`.

## Endpoints
Same URLs and query: `GET /api/analytics/employee`, `GET /api/analytics/admin-dashboard`, `GET /api/analytics/super-dashboard`. The response fields are listed in `docs/client-update-BB-133.md`.

## Open questions
- Approved OT exists only after cutoff review, so the current period may show 0. The client labels it.
- `patterns.usualClockIn/Out` format changed to `"HH:mm"`; the old text is in `…Label`.

---

# BB-136 — Patient-based company (question, no code)

Department-as-patient only works for one employee → one patient (`User.departmentId` is single). Agreed setup: name each shift after the patient; an employee can have several shifts a day and clocks out between visits; punches match their shift as in B&C.

**For that company:**
- Set the minimum lunch to 0. Otherwise 60 minutes is deducted from every short visit.
- Auto clock-out uses the day's latest shift end. An optional fix was not requested.

This led to BB-129's per-shift forms.
