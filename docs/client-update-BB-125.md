# Client update — BB-125: leave "Reverted" when a punch is honored

**For:** the client-web session (bizbuddy-v2-client-web). The server side is done in the server repo; **don't touch the server repo.** Mobile: see the questions at the end.

BB-125 started with Marites Fernandez (Piedmont Adult Day Program), Oct 30. She worked her full shift on a day she had an approved Sick Leave. With "Automatically Resolve Punch-vs-Leave Conflicts" on, the punch was approved, but the leave was never given back. It stayed Approved and Paid, with 5.5h taken from her balance.

**What was wrong on the server:**
- The leave lookup compared timestamps. Leave dates are stored at noon (company zone), so any punch before noon never found its leave. The revert failed silently, and Cutoff Review still showed the leave as cancelled.
- When it did work, it cancelled the **whole** leave request, even on a multi-day leave where only one day was worked.
- Driver/Aide punches were handled like regular punches: the day was cut to one shift window.

**New behaviour (agreed with PadPro):** honor the punch, give back **only that day** of the leave, and show the leave as **Reverted**. "Reverted" means approved, but the employee punched in on that day, so the punch is paid and the leave hours are returned.

---

## Server contract changes (live with the BB-125 server release)

### 1. New leave status `reverted`
- `Leave.status` can now be `"reverted"`: every day of the leave was worked, nothing is paid as leave, and all its hours went back to the balance.
- A leave can also stay **`"approved"` with some days reverted**. Show it as **"Partly reverted"**; the other days still count and pay.
- `GET /api/leaves?status=reverted` (the approver/management list filter) now accepts `reverted`.
- Pay outcome: a `reverted` leave has **no** paid/unpaid outcome. `actualPaidHours` and `actualUnpaidHours` drop by each reverted day, so a fully reverted leave has 0/0.

### 2. New `reversion` field on every leave in the list endpoints
The same endpoints that already return `transaction`, `cancelledAt` and `cancellation` (`_attachTransactions`) now also return:
```json
"reversion": null
```
or, when at least one day was reverted:
```json
"reversion": {
  "dates": ["2026-10-30"],
  "returnedHours": 5.5,
  "revertedAt": "2026-11-14T03:12:45.000Z",
  "automatic": true,
  "performedBy": null,
  "note": "Auto-reverted: punch honored over leave — 2026-10-30: 5.5h paid returned (all days reverted)"
}
```
- `automatic: true` means the company setting did it. Otherwise `performedBy` is the admin who clicked **Honor Punch**.
- **Partly reverted** = `status === "approved" && reversion != null`.

### 3. `GET /api/leaves/:id/days`: two new fields per day
```json
{ "date": "2026-10-30", "isPaid": true, "hours": 5.5, "reverted": true, "revertedAt": "2026-11-14T03:12:45.000Z" }
```
Reverted days are still listed so the history stays visible. They don't count toward hours anywhere (payroll, reports, cutoff review).

### 4. `PATCH /api/cutoff-periods/:id/approvals/:approvalId/conflict` (Honor Punch / Honor Leave)
- **Honor Punch** response `data` now has:
  - `leaveReverted` (boolean);
  - `revertedHours` (number);
  - `leaveStatus`: `"reverted"` when it was the leave's last day, `"approved"` when other days remain, `null` when nothing was reverted.
- `leaveCancelled` is kept as an alias of `leaveReverted`, so nothing breaks.
- The `message` text changed, for example: "Punch honored. Leave day reverted — 5.5h returned to the employee's balance."
- **Driver/Aide:** Honor Punch now approves **that segment** in Raw mode (actual punch times, grace credited). It no longer rewrites the punch to one shift window. The leave day is reverted once, the first time; the other segments return "The leave day was already reverted."
- **Honor Leave** is unchanged.

### 5. `GET /api/cutoff-periods/:id/approvals`
- Conflict rows: `leaveRecord.leaveType` and `pendingLeave.leaveType` are now the **leave type name** ("Sick Leave"), not the policy id.
- After an automatic revert, `leaveRecord.status` is `"reverted"` only when it really happened. The old code always said `"cancelled"`.
- A reverted day no longer raises a conflict and no longer appears as a leave row.

---

## Client changes

### A. Leave status: badge, filters, counts
Add `reverted` everywhere `cancelled` is handled, with its own style. Suggested: neutral grey-blue, different from Cancelled.

| File | Where | Change |
|---|---|---|
| `components/Dashboard/DashboardContent/EmployeePanel/Leaves/LeaveLogs.jsx` | `STATUS_CFG` (~l.91) | Add `reverted: { label: "Reverted", Icon: RotateCcw, … }` |
| same | stats + filter tabs (~l.303, ~l.316) | Count `reverted` and add a **"Reverted"** tab |
| `components/Dashboard/DashboardContent/CompanyPanel/Punchlogs&Overtimes&Leaves/EmployeesLeaveRequests.jsx` | stats (~l.175), filter tabs (~l.235), legend (~l.1657) | Same as above |
| same | status pill colours (~l.1035–1036) | Add a `reverted` colour pair |
| `lib/leaveBalanceUtils.js` | `resolveLeavePayOutcome` | Return `null` for `status === "reverted"` (no Paid/Unpaid pill) |

**Partly reverted:** when `status === "approved" && reversion`, show the Approved badge plus a small **"Partly reverted"** tag.

### B. Request details (both detail panels)
- `LeaveLogs.jsx` (~l.1022, next to the `Cancelled` row) and `EmployeesLeaveRequests.jsx` (~l.725). When `reversion` is set, add:
  - **Reverted:** `{date/time of reversion.revertedAt}`. Then "Automatically (company setting)" when `automatic`, else "by {performedBy.name}".
  - **Days reverted:** `{reversion.dates}` (company-zone calendar dates; show as-is, don't convert).
  - **Hours returned:** `{reversion.returnedHours}h`
- Explanation line (exact copy):
  > **Approved, but the employee punched in on this day. The punch was paid and the leave hours were returned to their balance.**

### C. Actual day-by-day outcome
`LeaveLogs.jsx` (~l.932) and `EmployeesLeaveRequests.jsx` (~l.686), from `GET /:id/days`:
- A day with `reverted: true` shows a **"Reverted"** chip instead of Paid/Unpaid.
- Strike through or grey out its hours.
- Tooltip: the same explanation line as B.

### D. Cutoff Review
`CutoffReview.jsx`:
- Conflict detail (~l.2134): `Leave: ${leaveRecord.leaveType} (Approved)` now shows the name, with no change needed. If `leaveRecord.status === "reverted"`, show **"(Reverted)"** instead of "(Approved)".
- After **Honor Punch** (`onConflict`, PATCH at ~l.2662): show the server's `message` in the toast. It now says how many hours were returned, or asks for a manual review if the revert failed.

### E. Settings text: "Punch-vs-Leave Conflicts"
`components/Dashboard/DashboardContent/CompanyPanel/Settings/LeaveSettings.jsx`, ~l.687–713. The current text is wrong.

**Description under the toggle** (replace):
> When on, a punch on a day with an approved leave automatically honors the punch and reverts that day of the leave — its hours go back to the employee's balance. When off (default), an admin reviews and chooses in Cutoff Review.

**"What This Does — and Doesn't — Change"** (replace the three bullets):
> • Only changes who resolves the conflict — an admin clicking Honor Punch / Honor Leave, or the system doing it automatically when the cutoff is opened in Cutoff Review
> • Only the day that was punched is reverted. The rest of a multi-day leave stays approved and paid. A leave whose every day was punched shows as **Reverted**
> • The employee gets back exactly the hours that day took from their balance
> • A punch on a shift the employee explicitly excluded from their leave never counts as a conflict, regardless of this setting

Also update the code comment at ~l.661, which still says "cancellation, flat default-shift-length refund, no ledger entry".

---

## Deploy order
1. The SQL script (`scripts/bb125-leave-revert.sql`) and `prisma generate`, then the server.
2. This client update.

Until the client ships, a reverted leave shows its raw status `reverted`, or falls back to whatever the status maps do with an unknown value. Nothing breaks on the server side.

## Mobile: questions for the mobile developer (on leave)
1. The leave list can now return `status: "reverted"`. How does the app show a status it doesn't know? Does it crash, hide the row, or show the raw text?
2. Can the app show "Reverted" with the explanation line from B, and "Partly reverted" when `status === "approved"` and `reversion` is set?
3. Does the app show the day-by-day outcome (`/api/leaves/:id/days`)? If so, it needs the `reverted` flag per day.
4. Does the app compute Paid/Unpaid from `isPaid` or from `actualPaidHours`? A reverted leave should show neither.
