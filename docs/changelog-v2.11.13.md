# Changelog — v2.11.13

**Branch:** not created yet (uncommitted). **Tickets:** BB-129 (clock-out documentation, trial): **COMPLETE 2026-11-16** (user confirmed). **Schema change:** yes, one column (`Company.taskReportEnabled`) and one new table (`DailyTaskReport`). **Client:** web only, see `docs/client-update-BB-129.md` (not sent yet: server first). Mobile: no change.

---

# BB-129 — Clock-out documentation (Daily Task Report), trial mode

## What
When the company setting is on, an employee can write down the work they did that day as a list of tasks. Each task has a title and an optional note. Reference layout: `docs/BizBuddy_DailyTaskReport_John_Doe_2026-11-16.pdf`.

Agreed rules (2026-11-16):
- **One report per employee per day.** The day is the company-zone date of the clock-in, so a day with several punches (Driver/Aide AM, Regular, PM) still has one report.
- **Optional.** Clock-out is never blocked.
- **Trial mode: no deadline.** No grace field. The employee can document any past day that has a punch and edit it at any time.
- **Form first, PDF after.** A report starts as a `draft` that only the employee sees. Once it is `submitted`, the PDF can be downloaded; it is built on request from the latest submitted tasks. A submitted report stays submitted, and every later save re-submits it (`submittedAt` = now).
- **Web only for now.** The mobile app doesn't call these endpoints. The server can't tell web from mobile, so this isn't enforced in code.
- **Supervisors and admins can view only.** They see submitted reports only. Supervisors see their department and direct reports; admins see the whole company.

## Changes
- `scripts/add-daily-task-report.sql` (new): adds `Company.taskReportEnabled BOOLEAN NOT NULL DEFAULT false` and creates the `DailyTaskReport` table with a unique (userId, reportDate) and an index on (companyId, reportDate). Additive and `IF NOT EXISTS` throughout, so it is safe to run twice.
- `src/prisma/schema.prisma`: new `DailyTaskReport` model, `Company.taskReportEnabled`, and back-relations on `Company` and `User`.
- `src/controllers/Account/companySettingsController.js`: `GET`/`PATCH /api/company-settings` read and save `taskReportEnabled` (admin/superadmin, same as the other settings).
- `src/services/Features/dailyTaskReportService.js` (new): rules, validation, access scope, and attendance (first raw clock-in, last raw clock-out, shift label from `resolveShiftForTimeLog` on the first punch).
- `src/utils/generateDailyTaskReportPDF.js` (new): the PDF on the shared layout (`utils/pdf/reportLayout.js`), US Letter portrait, tagged "Internal" like the template, with company-zone times.
- `src/controllers/Features/dailyTaskReportController.js`, `src/routes/Features/dailyTaskReportRoutes.js` (new), mounted at `/api/task-reports` in `src/routes/index.js`.

## Endpoints (`/api/task-reports`)
| Method | Path | Who | What |
|---|---|---|---|
| GET | `/me?from=&to=` | the employee (B. Buddy blocked) | Own reports in a range (default the last 30 days, max 93): date, status, task count, `enabled` |
| GET | `/me/:date` | the employee | One day: `report` (or null), `attendance`, `enabled`, `canEdit` |
| PUT | `/me/:date` | the employee | Body `{ tasks: [{ title, note? }], submit?: boolean }`. Save a draft, or submit |
| GET | `/me/:date/pdf` | the employee | PDF, submitted only (409 `NOT_SUBMITTED` otherwise) |
| GET | `/team?from=&to=&userId=&departmentId=` | supervisor, admin | Submitted reports in scope (employees get 403) |
| GET | `/:id` | owner, or supervisor/admin in scope | One report with tasks + attendance. Drafts and out-of-scope reports → 404 |
| GET | `/:id/pdf` | same | PDF |

Validation: date `YYYY-MM-DD` and not in the future (company zone); at most 50 tasks; title 1–200 characters; note up to 1000 characters; submitting needs at least 1 task; the day must have a punch (400 `NO_PUNCH`); the setting must be on (403 `TASK_REPORT_DISABLED`). Reading still works with the setting off, so existing reports stay viewable.

## Run order
1. The user runs `scripts/add-daily-task-report.sql`.
2. The user runs `prisma generate`.
3. Deploy. The SQL must come first, because company settings now select the new column.
4. Turn the setting on for a test company (`PATCH /api/company-settings { "taskReportEnabled": true }`).
5. Later: the web client builds the UI from `docs/client-update-BB-129.md`.

## Test (user)
- `GET /api/company-settings` returns `taskReportEnabled: false` for every company. PATCH it to `true` as admin, and it is saved. PATCH as supervisor or employee → 403.
- With the setting off: `PUT /me/<date>` → 403 `TASK_REPORT_DISABLED`.
- With it on:
  - PUT a draft for a day with a punch → saved, `status: "draft"`, `submittedAt: null`.
  - The same day's PDF → 409 `NOT_SUBMITTED`.
  - PUT `{ submit: true }` → `submitted`; the PDF downloads and matches the template.
- PUT for a day with no punch → 400 `NO_PUNCH`. A future date → 400. `submit: true` with no tasks → 400. A task with no title → 400.
- Edit a submitted report → it stays submitted and `submittedAt` moves.
- `/team` as supervisor: only their department and direct reports, submitted only. As an employee → 403. `/:id` on someone else's draft → 404.
- A day with 2+ punches (Driver/Aide): one report; the PDF shows the first clock-in and the last clock-out, with a note about the punch count.
- A day with a punch still open: the PDF says "Still clocked in".
- B. Buddy on `/me…` → blocked.

## Not in this version (later)
- An edit deadline (shift end / clock-out + grace) and the setting for it.
- Mobile support.
- A prompt at web clock-out (client only; can be added without server changes).
- The PDF shift label comes from the first punch's shift only. On a Driver/Aide day it shows that one shift.
