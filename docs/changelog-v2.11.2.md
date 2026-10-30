# Changelog — v2.11.2

**Branch:** `release/v2.11.2` (2026-10-30). No schema change, no data script.

> **BB-116** — An approved leave on the **last day of a cutoff** showed as **Absent** on the
> cutoff screen, with "0 leave records". The Leave Ledger now also shows which days each leave covers
> and who approved it.
>
> The client ledger change is in `docs/client-update-BB-116.md`. The server change is additive, so the
> current client keeps working.

---

## BB-116 — Last-day leave missing from the cutoff

**What happened:** Jovencio Jerico Espejo's approved Sick Leave for Tue, Oct 27 (5.5h paid) showed
as Absent in the Oct 14 – Oct 27 cutoff. The approval itself was fine: the per-day leave row,
balance deduction and ledger rows were all written.

**Why:**
- Leave dates are stored as **noon in the company timezone**, so Oct 27 is `2026-10-27T19:00Z`.
- A cutoff's `periodEnd` is stored as **UTC midnight of its last day**, `2026-10-27T00:00Z`.
- The cutoff screen fetched leaves with `startDate <= periodEnd`. That is false for any leave starting
  on the last day, so the leave was never loaded.

**Fix** (`cutoffPeriodController.js`, cutoff approvals view):
- The leave query now treats the period end as end of the last day in the company timezone. This is
  the same approach the punch sync already uses.
- The check for whether a leave day falls inside the cutoff compares calendar dates (`YYYY-MM-DD`)
  instead of timestamps, so the server's timezone no longer matters.
- Last-day leaves now appear as leave rows. They also get conflict flags, the pending-leave warning
  and the BB-051 auto-revert.

**Pay:** payroll export reads the per-day leave rows, which were never affected, so no pay was lost.

## BB-116 — Leave Ledger shows leave dates and approver

**Why:** a ledger row is dated when the action happened. The Oct 27 leave's deduction shows as
"Oct 15" (the approval date), with nothing saying which day it was for or who approved it.

**Change:** `GET /api/leave-balances/transactions` adds a `leave` field to each row. It is `null` for
adjustment, accrual and expired rows.

```jsonc
"leave": {
  "id": "…",
  "startDate": "2026-10-27",   // company-timezone calendar date
  "endDate":   "2026-10-27",
  "status":    "approved",
  "approver":  { "id": "…", "name": "…" },   // assigned approver
  "decidedBy": { "id": "…", "name": "…" }    // who actually approved/rejected
}
```

The leaves are loaded in one batched query, because `LeaveTransaction.leaveId` has no Prisma relation.

---

## Docs

- Added `docs/client-update-BB-116.md`.
- Removed the client hand-off docs for BB-089 to BB-113 that are complete: `client-handoff-BB-089-rework`,
  `-BB-098`, `-BB-098-reports`, `-BB-102`, `-BB-103`, `-BB-104`, `client-update-BB-098-complete`,
  `-BB-108-followup` and `-BB-112-BB-113`.

## Not covered

- `payrollController.js:202` compares leave dates the same way. It has not been checked yet.

## Deploy order

1. Merge and deploy the server. No schema change, no script.
2. Ship the client ledger change from `docs/client-update-BB-116.md` whenever it's ready.
