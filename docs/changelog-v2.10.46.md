# Changelog — v2.10.46

> **BB-087 (follow-up)** — the Yearly Total Hours report gets an optional **Leave Hrs** column. Paid
> leave was already counted in Total Hrs; this column just shows it separately.
>
> **BB-089** — fixed-hours employees. Some SV staff are paid a fixed rate, so they now get a flat
> number of hours per cutoff (default **80**) whatever their clock-ins are. It's controlled by a
> department master switch plus a per-employee switch, and both have to be on.

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

`scripts/add-bb089-fixed-hours-department.sql` adds two `Department` columns and the `CutoffFixedHours`
table. `scripts/add-bb089-user-fixed-hours-flag.sql` adds `User.fixedHoursEnabled`. Run both manually,
then `npx prisma generate`.

**Files Changed:**

| File | Change |
|---|---|
| `src/prisma/schema.prisma` | `Department.fixedHoursEnabled` / `fixedHoursPerCutoff`; `User.fixedHoursEnabled`; new `CutoffFixedHours` model + relations |
| `scripts/add-bb089-fixed-hours-department.sql` | Raw SQL: department columns + `CutoffFixedHours` |
| `scripts/add-bb089-user-fixed-hours-flag.sql` | Raw SQL: `User.fixedHoursEnabled` |
| `src/services/Cutoff/fixedHoursService.js` | **New.** Reconcile, list with leave split, admin edit |
| `src/controllers/Features/cutoffPeriodController.js` | Reconcile on review/lock/finalize; `fixedHours` + flags in the response; summary override; `updateFixedHoursRecord` |
| `src/routes/Features/cutoffPeriodRoutes.js` | `PATCH /:id/fixed-hours/:fixedHoursId` |
| `src/controllers/Account/departmentController.js` | Accept and validate the two new settings; `getFixedHoursMembers` / `updateFixedHoursMembers` |
| `src/routes/Account/departmentRoutes.js` | `GET` / `PUT /:id/fixed-hours-members` |
| `src/services/Payroll/payrollExportService.js` | Fixed-hours override when processing |
| `docs/client-handoff-BB-089.md` | **New.** Full UI handoff text for the client repo |

**Client-side impact:** everything in the API changes table above. The full UI handoff (settings card
with employee list, review page rows and flags, Edit endpoint, summary fields, test checklist) is in
`docs/client-handoff-BB-089.md`.

**Note:** the department member switch (`PUT /:id/fixed-hours-members`) is open to supervisors for the
initial setup. It may be restricted to admin/superadmin again later.
