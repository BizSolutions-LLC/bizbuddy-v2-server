# Changelog — v2.10.47

> **BB-093** — company admins can now see and edit an employee's address (address line, city,
> state, postal code) from the Employees page. The server returns the address in the employee list
> and saves it from Edit Employee. No schema change: `UserProfile` already had these columns.
>
> **BB-087 (follow-up)** — the Yearly Total Hours report gets an optional **Leave Hrs** column. Paid
> leave was already counted in Total Hrs; this column just shows it separately.
>
> **BB-089** — fixed-hours employees. Some SV staff are paid a fixed rate, so they now get a flat
> number of hours per cutoff (default **80**) whatever their clock-ins are. It's controlled by a
> department master switch plus a per-employee switch, and both have to be on.
>
> Cutoff generation for past dates now follows the department's configured cadence.

---

## BB-093 — Employee address: view and edit (company admin) ✅ Complete

**Why:** before this, the address could only be set by the employee on their own Profile page
(`PUT /api/account/profile`). Admins couldn't see it in Employee Details or change it from Edit
Employee.

### `employeeController.js`

**`getAllEmployees` (`GET /api/employee`)**
- The employee's own `profile.select` now includes `addressLine`, `city`, `state`, `postalCode`.
- Supervisor and department profile selects are unchanged.

**`updateEmployee` (`PUT /api/employee/:id`)**
- Accepts `addressLine`, `city`, `state`, `postalCode` in the body and writes them to `UserProfile`.
- Each field follows the same rule as `phone`:
  - non-empty string → trimmed and saved;
  - `null` or empty string → saved as `null` (field is cleared);
  - key missing → field left unchanged (safe for older clients and other callers).
- The response `profile.select` also returns the four fields, matching the GET.

### Notes

- **No postal code validation.** The self-service endpoint (`PUT /api/account/profile`) doesn't
  validate it either (it only trims), so admin and self-service behave the same.
- The employee's Profile page writes the same columns. Whichever save happens last wins.
- Known pre-existing edge case, unchanged here: `updateEmployee` uses a nested `profile.update`,
  which fails if the employee has no `UserProfile` row. `createEmployee` always creates one, so only
  very old or seeded accounts could hit this.

### API contract

| Endpoint | Change |
|---|---|
| `GET /api/employee` | `profile` now includes `addressLine`, `city`, `state`, `postalCode` |
| `PUT /api/employee/:id` | Accepts the same four keys. `null` clears, a missing key leaves the field unchanged |

**Client-side impact:** client counterpart is `Employees.jsx` (bizbuddy-v2-client-web,
`release/v2.14.29`). It shows the address in Employee Details and always sends all four keys from
Edit Employee. No further client changes needed.

**Files Changed:**

| File | Change |
|---|---|
| `src/controllers/Features/employeeController.js` | Return address fields in `getAllEmployees`; accept, save and return them in `updateEmployee` |

---

## BB-087 (follow-up) — Yearly Total Hours Report: optional Leave column

Paid leave (`PayrollExport.ptoHours`, i.e. approved, paid `LeaveDay` hours) was already included in
every `Total Hrs` figure (regular + driver + training + pto), but it wasn't visible anywhere. It can now
be shown as its own column. **Totals don't change.**

- `columns` now accepts `driver,regular,leave,ot,average`.
- **Monthly / Quarterly:** `{Period} Leave Hrs` in each period group, after Regular.
- **Yearly (compact):** a single `Leave Hrs` column. Unlike `ot`, it doesn't repeat a fixed column.
- It uses the same month rule as the rest of the report: leave counts in the month where the cutoff's
  `periodEnd` falls, and only processed cutoffs are included. Unpaid leave is still left out.

```
?year=2026&groupBy=month&periods=Jan,Feb,Mar&columns=regular,leave
?year=2026&groupBy=year&columns=leave
```

**Known gap:** leaves approved before 2026-07-15 have no `LeaveDay` rows, so the payroll export
(`payrollExportService.js`) counts them as 0. They show 0 in the Leave column and in
`PayrollExport.ptoHours`, even though the cutoff approval screen shows them as paid (it has a fallback
for older leaves). `scripts/backfill-leave-days-legacy.js` can create the missing rows, and the
affected cutoffs then need to be processed again. Not fixed in this release.

**Client-side impact:** the column picker needs a **"Leave"** checkbox that sends `leave` in `columns`.
It only adds a column: without `leave`, the output is the same as v2.10.45.

**Files Changed:**

| File | Change |
|---|---|
| `src/services/Reports/yearlyTotalHoursReportService.js` | `leave` added to `OPTIONAL_COLUMNS`; per-period `leaveHours` from `ptoHours` |
| `src/utils/generateYearlyTotalHoursReportXlsx.js` | `Leave Hrs` column definition (monthly, quarterly and yearly layouts) |
| `src/controllers/Reports/yearlyTotalHoursReportController.js` | Doc comment lists `leave` (validation comes from `OPTIONAL_COLUMNS`) |

---

## BB-089 — Fixed-hours employees (e.g. SV at 80h per cutoff)

Some SV staff are paid a fixed rate, so their clock-ins shouldn't drive payroll. In company settings,
a department's **fixed hours** master switch sets the hours (default **80**). Inside it, the admin turns
fixed hours on **per employee**. An active employee is on fixed hours only when **both** switches are on.
Everyone else in the department stays punch-based.

### How it works

- **Department settings:** `fixedHoursEnabled` (the master switch, default off) and `fixedHoursPerCutoff`
  (default 80.00), saved through the existing department update. Turning the master switch off keeps each
  employee's switch, so turning it back on restores the same people.
- **Employee switch:** `User.fixedHoursEnabled` (default off, so nobody is included automatically). The
  hours always come from the department. There's no per-employee hours value; one-off differences are
  edited on the review page.
- **Review page** (`GET /api/cutoff-periods/:id/approvals`, open cutoffs):
  - One `CutoffFixedHours` row per member, created already **approved**.
  - Admins can edit the hours (e.g. someone hired partway through a cutoff); `editedBy` / `editedAt` are recorded.
  - Members' **pending** punches are auto-set to `excluded` with the note
    "Fixed-hours department (BB-089) — not counted for pay". They stay visible for attendance, never
    block lock/finalize, and generate no OT. Already-approved punches are left as they are, but don't count for pay.
- **Includes paid leave:** regular = max(0, fixed hours − paid leave). With 8h paid leave, it's
  72 regular + 8 leave = 80. Leave balances are still used up as normal.
- **Turning either switch off** (or moving someone out of the department) only affects **open** cutoffs.
  It removes their fixed rows and puts the auto-excluded punches back to pending. Locked and processed cutoffs never change.
- **Processing** (`payrollExportService.js`): members get regular = fixed − leave, leave as usual,
  OT/driver/training = 0. Payroll and the BB-087 yearly report pick this up automatically.
- The same reconcile runs on review load, lock, and finalize, so punch records created elsewhere
  (sync, cutoff generation, request punches) are covered.
- Membership is the user's **current** department. There's no department history.

### API changes

| Endpoint | Change |
|---|---|
| `PUT /api/departments/update/:id` | Accepts `fixedHoursEnabled` (bool) and `fixedHoursPerCutoff` (0 < n ≤ 999). Department GETs return both. |
| `GET /api/departments/:id/fixed-hours-members` | **New.** `{ department, members[] }`. Each member has `userId, firstName, lastName, email, employeeId, role, status, fixedHoursEnabled, isOnFixedHours`. Deleted users are left out. |
| `PUT /api/departments/:id/fixed-hours-members` | **New.** Body `{ userIds: string[], enabled: boolean }`, for bulk on/off. Admin/superadmin/supervisor, same as the department update. Every user has to belong to this department. |
| `GET /api/cutoff-periods/:id/approvals` | New top-level `fixedHours[]`: `{ id, userId, user, status, hours, leaveHours, regularHours, editedBy, editedAt, notes }`. Every row in `data[]` and `otBlocks[]` has `isFixedHoursEmployee`. |
| `PATCH /api/cutoff-periods/:id/fixed-hours/:fixedHoursId` | **New.** Body `{ hours, notes? }`, 0–999, open cutoffs only. Returns the row with the recalculated split. |
| `GET /api/cutoff-periods/:id/summary` | Fixed-hours employees show `totalHours` = fixed hours, `regularHours` = fixed − leave, `overtimeHours` 0, plus `isFixedHours: true` and `leaveHours`. |

### Database

Added `Department.fixedHoursEnabled` / `fixedHoursPerCutoff`, `User.fixedHoursEnabled`, and the
`CutoffFixedHours` table. Already applied manually on every environment. The raw SQL scripts were
removed after being applied. If needed, get them back from git history:
`git show 2d8467b:scripts/add-bb089-fixed-hours-department.sql` and
`git show 2d8467b:scripts/add-bb089-user-fixed-hours-flag.sql`.

**Files Changed:**

| File | Change |
|---|---|
| `src/prisma/schema.prisma` | `Department.fixedHoursEnabled` / `fixedHoursPerCutoff`; `User.fixedHoursEnabled`; new `CutoffFixedHours` model + relations |
| `src/services/Cutoff/fixedHoursService.js` | **New.** Reconcile, list with leave split, admin edit |
| `src/controllers/Features/cutoffPeriodController.js` | Reconcile on review/lock/finalize; `fixedHours` + flags in the response; summary override; `updateFixedHoursRecord` |
| `src/routes/Features/cutoffPeriodRoutes.js` | `PATCH /:id/fixed-hours/:fixedHoursId` |
| `src/controllers/Account/departmentController.js` | Accept and validate the two new settings; `getFixedHoursMembers` / `updateFixedHoursMembers` |
| `src/routes/Account/departmentRoutes.js` | `GET` / `PUT /:id/fixed-hours-members` |
| `src/services/Payroll/payrollExportService.js` | Fixed-hours override when processing |

**Client-side impact:** everything in the API changes table above: a settings card with the employee
list, review page rows and flags, the edit endpoint, and the new summary fields.

**Note:** the department member switch (`PUT /:id/fixed-hours-members`) is open to supervisors for the
initial setup. It may be restricted to admin/superadmin again later.

---

## Cutoff generation — historical periods follow the department's cadence

**Why:** when generating cutoff periods for a past date range, `generatePeriodsBetweenDates`
started the first period on whatever `fromDate` the caller passed in. The generated periods could
then fall off the department's normal cycle, which forward generation derives from
`DepartmentCutoffSettings.startDate`.

### `cutoffGenerationService.js`

- `generatePeriodsBetweenDates` takes a new `anchorStartDate` (the department's
  `settings.startDate`). It walks forward from that anchor, capped at 500 steps, to the first
  period whose end is on or after the requested start. It then generates periods from there
  through the requested end.
- `fromDate` / `toDate` now only limit the range. They no longer decide where each period starts
  and ends.
- Both callers pass `settings.startDate`: `generateCutoffPeriods` and `generateAllDepartmentCutoffs`.
- Note: the first generated period may start before `fromDate` if `fromDate` falls in the middle
  of a cycle.

**Client-side impact:** none. The request and response format is unchanged.

**Files Changed:**

| File | Change |
|---|---|
| `src/services/Cutoff/cutoffGenerationService.js` | Historical generation anchors to `DepartmentCutoffSettings.startDate` |
