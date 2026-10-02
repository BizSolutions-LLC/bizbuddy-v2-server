# Changelog — v2.10.47

> **BB-093** — company admins can now see and edit an employee's address (address line, city,
> state, postal code) from the Employees page. The server returns the address in the employee list
> and saves it from Edit Employee. No schema change: `UserProfile` already had these columns.
>
> Cutoff generation for past dates now follows the department's configured cadence.
>
> This release also ships **BB-087** (Yearly Total Hours report: optional Leave column) and
> **BB-089** (fixed-hours employees) from commit `2d8467b`. See `changelog-v2.10.46.md` for details.
> Known gap in BB-087: leaves approved before 2026-07-15 have no `LeaveDay` rows, so they show
> 0 in the Leave column (and in `PayrollExport.ptoHours`).

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
