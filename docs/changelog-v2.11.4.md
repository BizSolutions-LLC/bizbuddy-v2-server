# Changelog — v2.11.4

**Branch:** `release/v2.11.4` (2026-11-04). **Schema change (BB-115):** already applied (column added + `npx prisma generate`, 2026-11-04). BB-106 has no schema change.

**Status:** BB-106 — complete (signed off 2026-11-04). The client side is still pending: see `docs/client-update-BB-106.md`.

> **BB-106 Leave Report redo.** The Leave Report button now downloads a server-built `.xlsx` in the
> `docs/LeaveReport_Template.csv` layout. The client sends only the filters (year, quarters or months,
> leave types, department).
>
> The client changes are in `docs/client-update-BB-106.md`. The change is additive: `GET /api/reports/leave?type=…`
> (BB-098 JSON reports) is unchanged.

---

## New endpoint
`GET /api/reports/leave/template?year=&quarters=|months=&policyIds=&departmentId=&userIds=&includeInactive=`
- Roles: admin and superadmin see the whole company. Supervisors see only their own department (same scope as `/api/reports/leave`).
- Returns the workbook, or JSON `{ message }` with status 400/403/404/500.

## Workbook layout (one sheet per leave type)
`# | NAME | DOH | Beg Bal Y-1 | Total Used Y-1 | Balance Y-1 | Credits Y | Beg Bal Y | pay-date columns (month header + day) | Total Used Y | Balance Y | Beg Bal Y+1`, plus a TOTAL HOURS row. Zeros print as "-".

## How the numbers are worked out
- **Pay-date columns:** cutoffs whose `paymentDate` falls in Y. The filtered department's own cutoffs are used first, then company-wide cutoffs, then any; there is one column per pay date. If no cutoffs were paid in Y, calendar months are used instead and the sheet title says so.
- **Used:** approved, paid `LeaveDay` hours, placed in the cutoff whose start–end contains the day. Unpaid days are excluded.
- **Credits:** ledger accruals + admin adjustments not tied to a leave − expirations, dated inside the year window.
- **Beg Bal Y-1:** the ledger balance just before Y-1's window. **Balance = Beg + Credits − Used.** **Beg Bal Y = Balance Y-1.**
- **Beg Bal Y+1** = Balance Y + `leaveGrantHours` when grants are on, credits are initialised, the policy isn't archived, and the employee is active and eligible. Regularization grants are not projected.
- **Quarter/month filter:** only the selected pay dates are shown. Total Used Y is the sum of those columns. Balance Y is the balance as of the last selected cutoff's end, so earlier unselected usage is still deducted.
- Year windows run back to back: Y-1 runs from its first cutoff's start to the day before Y's first cutoff starts.

## Known differences
- A late-December leave day can show under the next year's first pay date. This is intended, because columns follow pay dates.
- Balance is calculated from usage by leave date. It can differ from the live `LeaveBalance` when a leave was approved before the window but falls inside it, or the other way round.

## Files
- **New** `src/services/Reports/leaveTemplateReportService.js`: `buildLeaveTemplateReport()`
- **New** `src/utils/generateLeaveReportXlsx.js`: renders the workbook (exceljs)
- `src/services/Reports/leaveReportService.js`: exports its shared helpers (`resolveScope`, `balancesAt`, `bucketOf`, …). No behaviour change.
- `src/controllers/Reports/leaveReportController.js`: adds `getLeaveTemplateReport`
- `src/routes/Reports/leaveReportRoutes.js`: adds the `GET /leave/template` route
- **New** `docs/client-update-BB-106.md`

---

# BB-115 — "Set up your business" guide

**Status:** BB-115: complete (signed off 2026-11-04). The client side is still pending: see `docs/client-update-BB-115.md`.

> A new company starts empty (no departments, employees, shifts or schedules). BB-115 adds a setup
> checklist for the admin panel's left side, so owners and HR are guided through setup in the right order.
> Most steps tick themselves off from live data.

## Deploy order (schema change)
1. ✅ Applied 2026-11-04: `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "setupGuide" JSONB;` (nullable, no backfill). The script has been deleted.
2. ✅ `npx prisma generate` (`schema.prisma` has `setupGuide Json?`).
3. Deploy.

## Endpoints (`/api/company-setup`, admin + superadmin, caller's own company)
- `GET /checklist` returns the steps, progress, `isComplete`, `allFinished`, `nextStepKey` and `dismissed`.
- `POST|DELETE /checklist/steps/:key/skip` skips or unskips an optional step that completes automatically.
- `POST|DELETE /checklist/steps/:key/review` marks or unmarks a review step.
- `POST /checklist/dismiss`, `POST /checklist/reopen`.

The action routes sit under `/steps/:key/…` so that a step key can never clash with `dismiss` or `reopen`.

## Steps (in order)
| key | Done when | Required |
|---|---|---|
| `company_profile` | address line 1, city, state, business email, phone and time zone are set | ✔ |
| `departments` | at least 1 department | ✔ |
| `locations` | at least 1 location | |
| `employees` | at least 1 active human employee besides the owner (`HUMAN_ONLY`, excludes `Company.userId`) | ✔ |
| `employee_details` | every such employee has a department and a hire date | ✔ |
| `supervisors` | every department has a `supervisorId` | |
| `shifts` | at least 1 shift | ✔ |
| `schedules` | an active `ShiftSchedule`, or a `UserShift` from today onwards | ✔ |
| `cutoff` (only when `otBasis` is `"cutoff"`) | `CompanyCutoffSettings` exists | ✔ |
| `department_cutoffs` | every department has active `DepartmentCutoffSettings` and at least 1 `CutoffPeriod` | ✔ |
| `attendance_rules` | admin marks it reviewed (defaults already exist) | |
| `leave_policies` | at least 1 non-archived leave policy | |
| `leave_settings` | admin marks it reviewed | |
| `holidays` | at least 1 holiday in the current year (company timezone) | |
| `payroll` | `PayrollConfiguration` exists and every employee has `EmployeePayrollDetails` | |

The checks run as 14 `count` queries in parallel per request. Existing companies see the guide too. For a fully set-up company, every automatic step shows as done right away, and they can dismiss it.

**Added 2026-11-06:** the `department_cutoffs` step, which links to `/dashboard/company/cutoff-periods` (`page: cutoff_periods`, new client mapping needed). It requires a generated period because the nightly job only extends existing periods. `cutoff` no longer ticks off from department settings, and it's left out of the guide unless `otBasis` is `"cutoff"`, because company cutoff settings are only used for cutoff-based overtime. Daily and weekly companies get 14 steps (8 required); cutoff companies get 15 (9 required). `progress.current` is capped at `target`, so a count of 46 on an "at least 1" step shows 1/1 instead of 46/1. The company-wide "No Department" setting doesn't count towards `department_cutoffs`.

## Files
- **New** `src/services/Company/setupGuideService.js`: step definitions, live checks, skip/review/dismiss state
- **New** `src/controllers/Company/setupGuideController.js`
- **New** `src/routes/Company/setupGuideRoutes.js`
- `src/routes/index.js`: mounts `/company-setup`
- `src/prisma/schema.prisma`: `Company.setupGuide Json?`
- `scripts/bb115-add-company-setup-guide.sql`: one-off, applied and deleted
- **New** `docs/client-update-BB-115.md`

---

# BB-106 — report check (2026-11-06)

**No code change.** A Sick Leave cell of 13.00 under Aug 7 looked wrong against a -5h ledger row. It was correct: the Jul 22 – Aug 4 cutoff holds two paid leaves (8h on Jul 22, 5h on Jul 30). The sheet's columns are cutoff pay dates, so Aug 7 is the pay date for that cutoff.

- The `.xlsx` stores negatives correctly (`-19`). Numbers shows them as `--19.00`, so that's a display issue in Numbers. The format was left as it is.
- **New** `scripts/check-bb106-evelyn-sick-leave.js`: read-only diagnostic, kept with the other check scripts.

---

# BB-118 — "Running since" on the System Admin Dashboard

**Status:** server side needs no code change. The client side is pending: see `docs/client-update-BB-118.md`.

> Shows when the live server started and which commit it's running, for reference only. The values already come from
> `GET /api/system-admin/server/health` (`data.process.startedAt`, `data.instance.commit`, `data.instance.branch`), behind the system admin login.

The label says "Running since", not "Deployed on", because a crash or manual restart also resets the date.
