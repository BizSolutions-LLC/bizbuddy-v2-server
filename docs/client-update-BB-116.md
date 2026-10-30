# Server reply — BB-116 Leave Ledger shows the leave's dates and approver

**From:** bizbuddy-v2-server (release/v2.11.1)
**For:** bizbuddy-v2-client-web (Leave Ledger modal, e.g. "Sick Leave Ledger")
**Ship:** server first, then client. The new field is **additive**, so the current client keeps working.

Also in BB-116, with **no client change needed:** the cutoff period screen now shows approved leaves
that fall on the **last day** of a cutoff. Before, they showed as Absent with "0 leave records".

---

## 1. Why

Each ledger row is dated by **when the action happened**. A row reading "Oct 15 · Deduction · −5.5h"
is the day it was approved, not the day of leave (Oct 27). Nothing on the row said which days the
leave covered or who approved it, so the hours looked missing.

## 2. `GET /api/leave-balances/transactions` — new `leave` field

Every row now carries `leave`. It is `null` for rows not tied to a leave request
(`adjustment`, `accrual`, `expired`).

```jsonc
{
  "id": "…",
  "type": "deduction",
  "hours": -5.5,
  "balanceBefore": 10,
  "balanceAfter": 4.5,
  "leaveId": "cmv2i7pmo0sp3td4u5lcn0a2f",
  "note": "Approve",
  "createdAt": "2026-10-15T…Z",
  "performedBy": { "id": "…", "name": "Jhenelle Villanueva" },   // already sent today, not rendered
  "leave": {                                                      // NEW
    "id": "cmv2i7pmo0sp3td4u5lcn0a2f",
    "startDate": "2026-10-27",     // calendar date in the company timezone, do not timezone-convert
    "endDate":   "2026-10-27",
    "status":    "approved",       // the leave's current status (may be "cancelled" later)
    "approver":  { "id": "…", "name": "Antonette Franco" },     // assigned approver, may be null
    "decidedBy": { "id": "…", "name": "Jhenelle Villanueva" }   // who actually approved/rejected, may be null
  }
}
```

## 3. Client changes needed

| # | Where | Change |
|---|---|---|
| 1 | Ledger modal: Date cell | Under the action date, add a muted line **"Leave: Oct 27"**, or **"Leave: Nov 9 – Nov 11"** for a range, when `leave` is not null. Format the `YYYY-MM-DD` strings as plain dates. Do not pass them through `new Date()` with a timezone, because that shifts the day. |
| 2 | Ledger modal: Note / new "By" column | Show who acted: `performedBy.name`. For `approved` / `rejected` / `deduction` rows, also show `leave.approver.name` as "Assigned: …" when it differs from `performedBy`. |
| 3 | Null safety | `leave`, `leave.approver` and `leave.decidedBy` can each be `null`. Render "—" or omit them. |
