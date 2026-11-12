# Changelog — v2.11.7

**Branch:** `release/v2.11.7` (not created yet). **No schema change.** Everything is read-only: no report writes to the database.

**Status:** BB-119 — **closed 2026-11-11**. Every item was tested locally and confirmed by the user. The client side follows `docs/client-update-BB-119.md` (items 1–14).

> **BB-119: company time zone everywhere, and every report built on the server.**
> Reports used to be built in the browser (jsPDF, hand-made CSVs), each with its own look, and the punch log PDF printed
> the viewer's zone next to the company's ("Los Angeles / Manila (HQ)"). Now:
> - every report uses the **Company TimeZone** (Company Configurations), whoever views it — no "HQ" label, no second zone;
> - PDFs are built on the server with PDFKit on one shared layout (US Letter);
> - spreadsheets meant for people are **Excel** on one shared template, with a watermark; CSV stays available on the server as a plain data file.

---

## Report rules (all reports)
- **Requester** on every report: a real user prints name + email; B. Buddy prints **"B. Buddy (CODE)"** (`services/Reports/reportRequester.js`). The support email and system IDs are never printed.
- **Tag and footer:** Client reports say **"Confidential — {company}"**; the only Internal report (Performance) says "Internal — Confidential".
- **Dates:** MM-DD-YYYY in PDFs and Excel (real dates in Excel, so they sort and filter); YYYY-MM-DD in CSV. Times in the company zone.
- **Names:** "Last, First" in tables. Striped rows; fonts shrink rather than wrap.
- **Filters:** the real report filters (date range, status, department, cutoff) apply; the search box and column pickers don't.
- **Supervisors:** their department plus direct reports (BB-098 / BB-106 leave reports keep department only).
- **CSV:** one header row, no title rows, formula-injection guard (`utils/csv.js`: text starting with `= + - @ tab CR` gets a leading `'`).
- **Excel template** (`utils/xlsx/reportWorkbook.js`): logo, title, orange settings line, requester / generated time / time zone, provenance line ("This file is a copy: changes made here aren't saved to BizBuddy"), orange header row, filter buttons, frozen panes, watermark (`src/assets/report-watermark.png`, on screen only), Letter landscape print setup with "Confidential — {company}" and "Page X of Y".

## Reports

| Report | Endpoint | Formats | Hand-off |
|---|---|---|---|
| Performance (system admin, Internal) | `GET /api/system-admin/capacity/reports/:number/pdf` (unchanged) | PDF redesigned; adds figures the snapshot already saved (CPU avg / time at 80%+, memory peak, slow event loop, requests in progress, per-endpoint avg / slow / 5xx, daily series) | 1 |
| Employees | `GET /api/reports/employees` | pdf, xlsx, csv | 2, 9 |
| Departments | `GET /api/reports/departments` | pdf, xlsx, csv | 3, 10 |
| Leave Requests | `GET /api/reports/leave/requests?from&to&status` | pdf, xlsx, csv | 4, 11 |
| Leave Calendar | `GET /api/reports/leave/calendar?month&status` | pdf | 5 |
| Contest Time Logs | `GET /api/reports/contests?scope=mine\|team&from&to&status` | pdf, xlsx, csv | 6, 12 |
| Punch Logs (company + employee) | `GET /api/reports/punch-logs?scope=mine\|team&…` | pdf (both pages), xlsx (company "Detail"), csv | 7, 8, 13 |
| Payroll Grid (company Punch Logs) | `GET /api/reports/punch-logs?format=payroll` | xlsx; `format=payroll-csv` keeps the original CSV layout | 14 |
| Yearly Total Hours (BB-087) | `GET /api/reports/yearly-total-hours/:companyId` (unchanged) | xlsx, moved to the template | none |
| Leave Report (BB-106) | `GET /api/reports/leave/template` (unchanged) | xlsx, moved to the template | none |

### Punch Logs (one shared, read-only builder)
- `services/Reports/punchLogReportService.js` serves both pages, so the same punch shows the same hours for the employee and the admin. It **never calls `getCutoffApprovals`** (which writes).
- Locked / processed cutoffs use the **reviewed, payable hours** (one row per employee per day); open cutoffs and date ranges use live punches. Badge: **Final / Preliminary / Partly final**.
- Overtime follows the company's OT configuration: B&C daily OT blocks; cutoff basis one block per employee per cutoff (shown in "Overtime by cutoff", not per day; threshold `cutoffOtThresholdHours`); daily / weekly basis OT requests. Fixed-hours employees (BB-089) listed even with no punches.
- A clock time is marked adjusted only when review moved it by a minute or more.
- Employee page is **PDF only** (both CSVs removed on the client).
- Excel "Punches" + "Summary" sheets add gross hours, scheduled flag, lunch window, device, check-in/out location, location-required.

### Payroll Grid
- Same core idea as the client sheet: one column group per **date** with AM / Regular / PM hours, then Total Hours (Driver Aide AM, Regular, Driver Aide PM), Driving, TR, SL, OT, Total. Weekends tinted, two frozen header rows.
- **Differences from the old browser CSV (intended):** SL counts all approved paid sick leave in the range (the old page only saw the newest 50 leaves); OT comes from approved OT records (the old cutoff OT counted training hours); the ID column never falls back to the internal user id.

### Yearly Total Hours / Leave Report
- Figures unchanged. Two-row headers (period or month over its columns), settings in the subtitle (Year · Grouped by / Months included · Department · N employees), Total row, notes explaining how the numbers are worked out.
- Leave Report keeps the customer template's columns and wording; zeros still print as "-"; DOH is a real date.
- New filenames: `BizBuddy_YearlyTotalHours_{Company}_{Year}_{stamp}.xlsx`, `BizBuddy_LeaveReport_{Company}_{Year}[_months]_{stamp}.xlsx` (the client already uses the server's filename).

## Not in BB-119
- **Morning / Evening attendance emails:** moved to **BB-117** (notifications). Found: the cron runs at 10:00 / 18:00 server time instead of each company's `morningReportTime` / `eveningReportTime`; the morning job reads the shift date in UTC; names are "First Last"; the supervisor column is always "N/A".
- **Employee Deletion Requests report:** waits on the separate account-deletion ticket.
- **Payroll reports** (Payslip, Payroll Summary, payroll sheet, Check): out of scope.
- **Companies list** (superadmin Subscribers): dropped, the superadmin panel isn't used.

## Files
**New**
- `src/utils/pdf/reportLayout.js` — shared PDF layout
- `src/utils/xlsx/reportWorkbook.js` — shared Excel template (`createWorkbook`, `addTableSheet`, `addSummarySheet`, `addCustomSheet`, `style`, `keysLabel`)
- `src/utils/csv.js` — CSV writer with injection guard
- `src/assets/bizbuddy-logo-report.png`, `src/assets/report-watermark.png`, `src/assets/report-watermark.svg`
- `src/services/Reports/reportRequester.js`
- Services: `employeeReportService`, `departmentReportService`, `leaveRequestsReportService`, `leaveCalendarReportService`, `contestReportService`, `punchLogReportService`, `punchLogPayrollGrid`
- Controllers: `employeeReportController`, `departmentReportController`, `leaveRequestsReportController`, `leaveCalendarReportController`, `contestReportController`, `punchLogReportController`
- Routes: `employeeReportRoutes`, `departmentReportRoutes`, `contestReportRoutes`, `punchLogReportRoutes`
- Generators: `generateEmployeesReportPDF/Xlsx`, `generateDepartmentsReportPDF/Xlsx`, `generateLeaveRequestsReportPDF/Xlsx`, `generateLeaveCalendarReportPDF`, `generateContestReportPDF/Xlsx`, `generatePunchLogsReportPDF/Xlsx`, `generatePayrollGridXlsx`
- Docs: `docs/client-update-BB-119.md`

**Changed**
- `src/routes/index.js` — mounts the four new report routers under `/reports`
- `src/routes/Reports/leaveReportRoutes.js` — adds `/leave/requests` and `/leave/calendar`
- `src/services/Reports/leaveReportService.js` — `resolveScope(..., { team: true })` for department + direct reports
- `src/services/Reports/leaveTemplateReportService.js` — adds requester, department name, employee count (read-only)
- `src/controllers/Reports/leaveReportController.js`, `yearlyTotalHoursReportController.js` — requester, company zone, new filenames
- `src/utils/generateCapacityReportPDF.js`, `generateYearlyTotalHoursReportXlsx.js`, `generateLeaveReportXlsx.js` — moved to the shared layout / template
- `docs/CLAUDE.md` — route table

**Don't commit:** the two test PDFs in `docs/` (`BizBuddy_PunchLogs_Jhenelle_Villanueva_…pdf`).

---

# BB-117 — Optimize Notifications

**Status:** complete 2026-11-11 (user confirmed). Server only; no app change is needed. The mobile app routes only on `targetRoute`; the route table from the mobile developer lives in `src/services/notificationTargets.js`.

## Schema (applied 2026-11-11, then `npx prisma generate`)
```sql
ALTER TYPE "NotificationCode" ADD VALUE IF NOT EXISTS 'CLOCK_IN_REMINDER';
ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ(6);
ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "targetRoute" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationLog_dedupeKey_key" ON "NotificationLog" ("dedupeKey");
CREATE INDEX IF NOT EXISTS "NotificationLog_createdAt_idx" ON "NotificationLog" ("createdAt");
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "morningReportSentOn" DATE;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "eveningReportSentOn" DATE;
```
The script (`scripts/bb117-notifications.sql`) was applied and deleted. Retired companies are **not** switched off yet (`isActive = false` per company id, BB-107): a separate step when decided.

## What changed
- **Device tokens** (`POST|GET /api/account/device-token`): with a login header the signed-in user is used and a `userId` in the body is ignored (logged when it differs). Without the header the old call still works for now and is logged as `[BB-117] … without login header`; check the logs before closing it. A token registered again is removed from any other account, so a phone pushes only for the account signed in on it.
- **Dead tokens:** FCM "not registered / invalid token" errors remove the token.
- **One push format** for every type: `data { notificationId, type, companyId, targetRoute, payload }`, Android `channelId: "default"`. `targetRoute` follows the mobile table (`services/notificationTargets.js`); types they didn't list go to `/(tabs)/notifications`.
- **Inbox:** rows store `targetRoute`; `GET /api/notifications` returns it (older rows get the default for their type). Deleting (`DELETE /:id`, `DELETE /`) now hides the row (`deletedAt`); hidden rows are never returned or counted. Response shapes are unchanged.
- **No duplicates:** `dedupeKey` (unique) on missed clock-in (per shift), missed clock-out, clock-out warning and auto clock-out (per punch), the 30-minute shift reminder (per shift) and the daily reports (per manager per day). A missed clock-in/out is no longer repeated every 2 hours, and isn't re-sent after the employee deletes it. The matching email goes out only when the inbox row is new.
- **Shift notifications** (assigned, schedule created, replaced, import) now push to the phone and skip inactive accounts — they go through the shared sender.
- **Reminders:** "Shift starting soon" (30 min) is now an inbox entry (`CLOCK_IN_REMINDER`) with the shared push format; the app's `clockInReminder` socket event is kept. The 10-minute **"Shift ending soon" push is retired** (`clockOutReminderWorker.js` deleted); the company-set **"Clock-Out Reminder"** from auto clock-out stays.
- **Company prefix:** "[Company]" is added only when the recipient's email has an active account in another active company (cached 10 minutes per user).
- **Inactive companies** (`Company.isActive = false`): no inbox entries, socket events, pushes, emails, reminders, missed clock alerts or attendance reports.
- **Morning / Evening attendance emails:** checked every 5 minutes; each company gets its report at its own `morningReportTime` / `eveningReportTime` in its own zone, once per day (claimed in `Company.morningReportSentOn` / `eveningReportSentOn`; not sent more than 3 hours late). Fixed: shift dates and times were read in UTC / as JS dates (the morning report could pick up the wrong day, the evening report couldn't read shift end times); names "Last, First", sorted; the always-empty Supervisor column removed; report date in the company zone; footer "Confidential — {company}" with the time zone.
- **Retention** (`jobs/notificationRetentionJob.js`, nightly 03:30 server time): read > 90 days, any > 180 days, hidden > 30 days, old reminder markers > 7 days. **Report-only** until `NOTIFICATION_RETENTION=on`: it logs `[BB-117 retention] … would be deleted` counts.

## Not done (waiting for the mobile developer)
- Clearing the FCM token on sign-out (needs: does the app register the token again after a biometric sign-in or on app start?).
- Better routes for types not in their table; confirming the route form; whether old app versions send the login header.
- FCM batch sending: with one token per account, each send is already one call and fan-outs run in parallel; batching would save little, so it was left out.

## Files
- **New** `src/services/notificationTargets.js`, `src/services/attendanceReportSchedule.js`, `src/jobs/notificationRetentionJob.js`
- **Deleted** `src/workers/clockOutReminderWorker.js`
- `src/services/notificationService.js` — shared sender (dedupe, targetRoute, push format, dead tokens, prefix, inactive companies), missed clock / warning / auto clock-out once, reports once per day
- `src/services/shiftNotificationService.js` — uses the shared sender
- `src/workers/clockInReminderWorker.js` — inbox entry through the shared sender
- `src/jobs/checkMissedClockIns.js`, `checkMissedClockOuts.js`, `sendMorningReport.js`, `sendEveningReport.js`
- `src/utils/cronScheduler.js`, `server.js`
- `src/controllers/notificationController.js`, `src/controllers/Account/accountSigninController.js`, `src/routes/Account/accountRoutes.js`
- `src/templates/morningReport.hbs`, `eveningReport.hbs`
- `src/prisma/schema.prisma`

---

# BB-120 — B. Buddy: remove access to payroll

**Status:** built 2026-11-11, awaiting the user's test. No schema change. Client hand-off: `docs/client-update-BB-120.md`.

> B. Buddy (BB-110 support account) no longer works with payroll. Cutoff review (approve, lock, process) and the hours
> reports (Punch Logs incl. the Payroll Grid, Yearly Total Hours) stay available, as decided with the user.

- **Server guard** `blockSystemAgentArea` (`src/utils/systemAgent.js`), mounted in `src/routes/index.js` in front of `/payroll`, `/payroll-system`, `/company-information`, `/employee-payroll-details`, `/payroll-export` and `/disbursements`. A B. Buddy session gets 403 `SYSTEM_AGENT_NOT_ALLOWED`. It reads the `isSystemAgent` claim from the login token (no DB query); a missing or invalid token falls through to the route's own `authenticate`.
- **Setup guide:** the "Set up payroll details" step is left out of B. Buddy's checklist and progress, and B. Buddy can't skip it (`setupGuideService` `HIDDEN_FOR_SYSTEM_AGENT`).
- **Client** (hand-off): no Payroll group in B. Buddy's sidebar, `/dashboard/employee/payroll` no longer allowed for B. Buddy, "Preview Payroll Reports" hidden on Employee Cutoff.

**Separate finding, not changed:** `/api/payroll-system` and `/api/company-information` routes check only that the caller is signed in (no role at the route). Whether their controllers check roles inside hasn't been checked yet — candidate ticket.

## Files
- `src/utils/systemAgent.js`, `src/routes/index.js`
- `src/services/Company/setupGuideService.js`, `src/controllers/Company/setupGuideController.js`
- **New** `docs/client-update-BB-120.md`
