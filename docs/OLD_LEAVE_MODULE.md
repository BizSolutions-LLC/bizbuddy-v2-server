# Old Leave Module — Reference (pre-redo snapshot)

> Captures the Leave feature **as it exists today**, before the planned redo/formalization. Purpose: a single reference so we don't have to re-derive this by re-reading the codebase every time. Not a spec — see "Known Gaps" for things the redo should decide on.

---

## 1. Data Model (`src/prisma/schema.prisma`)

### `Leave` (~line 1102)
The leave request itself.

| Field | Notes |
|---|---|
| `userId`, `approverId` | Requester and primary approver |
| `leaveType` | **Free-text string**, not an FK to `LeavePolicy` — matched by name (`policy.leaveType === leaveType`) at submit time |
| `startDate`, `endDate` | `Timestamptz`. Stored as **noon in company timezone** to avoid UTC day-drift (see §7 date-storage note) |
| `status` | `leaveStatus` enum |
| `isPaid` | Gates whether approval deducts balance |
| `leaveReason`, `approverComments` | |
| `secondaryApproverId`, `secondaryApproverComments` | Set **per-request** at escalation time, not defaulted from any company setting |
| `affectedShifts` | JSON snapshot of `UserShift`s the leave covers, captured at submit time |

```
enum leaveStatus { pending, pending_secondary, approved, rejected, cancelled }
```
`cancelled` is dead — appears only in a status-filter allowlist, no code path ever sets it.

### `LeavePolicy` (~line 315)
Per-company leave type configuration.

- `companyId`, `leaveType` (unique per company)
- `annualAllocation` (Decimal)
- `accrualFrequency`: `monthly | yearly | none`
- `accrualUnit`: `hours | days`
- `carryOverAllowed`, `carryOverLimit`
- `negativeAllowed` — whether balance can go below 0

### `LeaveBalance` (~line 334)
One row per `userId` + `policyId`: `balanceHours`, `lastAccrualAt`. Unique on `[userId, policyId]`.

### `LeaveTransaction` (~line 348)
Ledger. `type`: `accrual | deduction | adjustment`. Records `hours`, `balanceBefore`, `balanceAfter`, optional `leaveId`/`performedById`/`note`. Added via `scripts/add-leave-transaction-ledger.sql` (changelog v2.10.18), predates/parallels the Prisma schema entry.

### `Company` leave-related fields (~line 556)
- `accrualEnabled` (Boolean) — master switch for the accrual worker
- `leaveYearStartMonth` (Int, default 1) — month yearly accrual/reset fires
- `newEmployeeCatchUp` (Boolean) — see accrual worker below
- `multiApprovalEnabled` (Boolean) — gates whether escalation to a secondary approver is allowed
- `secondaryApproverId` — **exists in schema and is settable via company settings, but is dead code** (see §Gaps)

### Other schema touchpoints
- `AttendanceSummary.leavePaidHours` / `leaveUnpaidHours` (~line 300-301) — **defined but completely unused**, no controller/service reads or writes `AttendanceSummary` anywhere in `src/`.
- `NotificationCode` enum: `LEAVE_REQUEST_SUBMITTED`, `LEAVE_REQUEST_APPROVED`, `LEAVE_REQUEST_REJECTED` (plus `LEAVE_PENDING_SECONDARY_APPROVAL`, `LEAVE_REQUEST_FIRST_APPROVED` used in code — confirm these are in the enum).

---

## 2. Routes

Mounted in `src/routes/index.js`:
```
/api/leaves          → src/routes/Features/leaveRoutes.js
/api/leave-policies   → src/routes/Features/leavePolicyRoutes.js
/api/leave-balances   → src/routes/Features/leaveBalanceRoutes.js
```
`leaves` is also a subscription-plan feature flag (`features.leaves` in `src/prisma/seed.js:22`), but no plan-gating middleware was found wired to these routes specifically.

| Method | Path | Handler | Roles |
|---|---|---|---|
| GET | `/api/leaves/policies` | `getAvailablePolicies` | any authenticated |
| POST | `/api/leaves/submit` | `submitLeaveRequest` | any authenticated |
| GET | `/api/leaves/my` | `getUserLeaves` | any authenticated |
| GET | `/api/leaves/pending` | `getPendingLeavesForApprover` | admin/supervisor/superadmin |
| GET | `/api/leaves/` | `getLeavesForApprover` | admin/supervisor/superadmin |
| PUT | `/api/leaves/:id/approve` | `approveLeave` | admin/supervisor/superadmin |
| PUT | `/api/leaves/:id/reject` | `rejectLeave` | admin/supervisor/superadmin |
| GET | `/api/leaves/approvers` | `getApprovers` | any authenticated |
| DELETE | `/api/leaves/:id` | `deleteLeave` | approver only |
| GET | `/api/leaves/affected-schedules` | `getAffectedSchedules` | any authenticated |
| GET | `/api/leaves/balance` | `getBalance` | any authenticated |
| GET | `/api/leaves/balances` | `listBalances` | any authenticated |
| POST | `/api/leave-balances/adjust` | `adjustBalance` | admin/supervisor/superadmin |
| GET | `/api/leave-balances/matrix` | `listMatrix` | admin/supervisor/superadmin |
| GET | `/api/leave-balances/transactions` | `getTransactions` | any authenticated |
| GET | `/api/leave-policies/` | `getPolicies` | admin/supervisor/superadmin |
| POST | `/api/leave-policies/` | `createPolicy` | admin/supervisor/superadmin |
| PUT | `/api/leave-policies/:id` | `updatePolicy` | admin/supervisor/superadmin |
| DELETE | `/api/leave-policies/:id` | `deletePolicy` | admin/supervisor/superadmin |
| PATCH | `/api/cutoff-periods/:id/approvals/:approvalId/conflict` | `resolveConflict` | punch-vs-leave, cutoff-scoped |

---

## 3. Request Lifecycle (`src/controllers/Features/leaveController.js`)

- **`submitLeaveRequest`** (line 154) — Any role submits for themselves. `approverId` must be an active admin/supervisor/superadmin in the same company, not self. Resolves `LeavePolicy` by matching `type` name. Dates stored as noon-in-company-tz. Optional `affectedShiftIds` → snapshots into `Leave.affectedShifts`. Creates with `status: "pending"`. Fires `LEAVE_REQUEST_SUBMITTED` to all management users.
- **`getUserLeaves`** (498) — `/my`, own leaves enriched with policy name, `requestedHours`, linked deduction transaction.
- **`getApprovers`** (688) — eligible approvers list (admin/supervisor/superadmin, excluding self).
- **`getAffectedSchedules`** (829) — `?startDate&endDate`, returns caller's non-cancelled `UserShift`s with computed `scheduledHours`, used by client to build `affectedShiftIds` before submit (added v2.10.16).
- **`deleteLeave`** (711) — only the record's `approverId` can delete. **No status restriction** — approved leaves can be hard-deleted with no balance/transaction reversal.

## 4. Approval Flow

- **`approveLeave`** (272) — caller must be `approverId` (status `pending`) or `secondaryApproverId` (status `pending_secondary`).
  - First approver, no escalation → `_deductBalance`, `status: "approved"`, notify employee (`LEAVE_REQUEST_APPROVED`), socket `leaveBalanceUpdated`.
  - First approver, escalating (`escalateTo` in body) → requires `company.multiApprovalEnabled === true` (fetched fresh); target can't be self/requester, must be active admin/supervisor/superadmin. Sets `status: "pending_secondary"`, `secondaryApproverId: escalateTo` on the **Leave row itself**. Notifies secondary approver (`LEAVE_PENDING_SECONDARY_APPROVAL`) and employee (`LEAVE_REQUEST_FIRST_APPROVED`).
  - Secondary approver → `_deductBalance` again, `status: "approved"`, sets `secondaryApproverComments`.
- **`rejectLeave`** (445) — same dual-approver lookup, sets `status: "rejected"` with stage-appropriate comments field.
- **`_deductBalance`** (103, shared helper) — no-op if `!leave.isPaid`. Otherwise: `calcRequestedHours`, upserts zero-balance `LeaveBalance` if missing, blocks (400) if insufficient balance and `policy.negativeAllowed` is false, decrements balance, writes `deduction` `LeaveTransaction`.
- **`getPendingLeavesForApprover`** (535) / **`getLeavesForApprover`** (605) — management roles see company-wide pending/pending_secondary leaves (`canAct` flag scopes who can actually act); non-management see only leaves directed at them.

---

## 5. Balance & Accrual

### `src/utils/leaveUtils.js`
- **`calcRequestedHours(userId, startISO, endISO)`** (26) — canonical hour-cost calculator. Walks each calendar day (company tz), excludes weekends and `Holiday` rows. For "shift workers" (has any non-cancelled `UserShift` ever), only counts days with an actual scheduled shift, summing real shift duration. For salaried/unscheduled employees, falls back to `company.defaultShiftHours` per eligible day. Used by `_attachRequestedHours`, `_deductBalance`.
- **`monthlyIncrement(policy, defaultShiftHours)`** (125) — `annualAllocation / 12`, converts days→hours via `defaultShiftHours` when `accrualUnit === "days"`.

### `src/workers/leaveAccrualWorker.js`
Registered in `server.js:36`. `node-cron` `"0 2 * * *"` (daily 2am) but **short-circuits unless `today.date() === 1`** — real work only happens on the 1st of the month. Iterates companies with `accrualEnabled: true`:
- **Monthly** policies — existing balances get `+monthlyIncrement`, capped at `annualHours`. New employees (no `LeaveBalance` row): `newEmployeeCatchUp: true` → credited for all elapsed months of the current leave year (capped); `false` → credited for current month only. Writes `accrual` transaction per employee/policy.
- **Yearly** policies (only runs when `currentMonth === company.leaveYearStartMonth`) — carry-over computed (`carryOverAllowed && carryOverLimit`, capped, else full annual as cap) + full `annualAllocation` granted on top. Writes `accrual` transaction with note `"Yearly reset — carry-over Xh + annual grant Yh"`.
- `none` frequency — skipped.

### `src/controllers/Features/leaveBalanceController.js`
- **`adjustBalance`** (4) — `POST /leave-balances/adjust`, admin/supervisor/superadmin. Manual +/- across one or more `leaveTypes` for `targetUserId`. Writes `adjustment` transaction per policy. Balance floored at 0 only on negative adjustments — **positive adjustments are unbounded**, no cap vs `annualAllocation`.
- **`listMatrix`** (72) — `GET /leave-balances/matrix`. Company-wide grid: every active user × every leave policy balance.

---

## 6. LeaveTransaction Ledger

**Writers**: `_deductBalance` (`deduction`, on approval), `leaveAccrualWorker` (`accrual`, cron), `adjustBalance` (`adjustment`, manual). All write `balanceBefore`/`balanceAfter` snapshots.

**Readers**:
- `_attachTransactions` (52) — attaches linked `deduction` transaction to leave rows in `/my`, `/pending`, `/`.
- `listBalances` (754) — `GET /leaves/balances`. Per-policy balance + `usedHours` (sum of deductions) + last 100 transactions, scoped to self or (management) any company member via `?userId=`.
- `getTransactions` (117) — `GET /leave-balances/transactions`. Paginated, filterable by `userId` (management only)/`policyId`/`type`.

---

## 7. Leave-Policy Management (`src/controllers/Features/leavePolicyController.js`)

- **`getPolicies`** (4) — all policies for company.
- **`createPolicy`** (11) — hardcoded defaults `annualAllocation: 0, accrualFrequency: "none", accrualUnit: "hours"`; accrual config must be set via a later update.
- **`updatePolicy`** (31) — **only updates `leaveType`** (the name). Cannot change `annualAllocation`, `accrualFrequency`, `carryOverAllowed`, `negativeAllowed`, etc. despite the endpoint existing.
- **`deletePolicy`** (40) — hard delete, no check for existing balances/transactions/leaves referencing the policy.
- **`getAvailablePolicies`** (48, mounted under `/leaves/policies`) — employee-facing policy config + `balanceHours` for caller.
- Router gates entire `leavePolicyRoutes.js` to `admin|superadmin|supervisor` (supervisors included, not just admins).

---

## 8. Integration Points

### Payroll (`src/controllers/Features/payrollController.js`, ~line 201-244, 461-463)
Separate, ad hoc leave-pay calc inside payroll-run computation: fetches approved `Leave` overlapping the pay period, computes `days * defaultDailyHours` (crude calendar-day count — **does not use `calcRequestedHours`**, ignores weekends/holidays/actual shift hours). Sums into a local `leavePaidHours` var (unrelated to the unused `AttendanceSummary` field of the same name), adds `leavePay = hourlyRate * leavePaidHours` to gross pay plus a `"LEAVE"` payroll line entry.

### Cutoff Periods (`src/controllers/Features/cutoffPeriodController.js`, `getCutoffApprovals`, ~line 972-1102)
Fetches approved+pending `Leave` overlapping the cutoff period:
- Tags each punch (`TimeLogApproval`) with `hasLeaveConflict`/`leaveRecord`/`pendingLeave` metadata (display only).
- Builds `standaloneLeaves` rows (`_type: "leave"`) for approved-leave days with no matching punch.
- **`docs/CUTOFF_PERIOD_MODULE.md` describes a "Leave Always Wins" auto-exclusion rule (auto-set conflicting punches to `excluded`, block approval on conflict days) and a `leaveHours`-driven payable formula — neither is implemented.** `docs/TIMEKEEPING_GLOSSARY.md` independently flags this same gap as an open item.
- **`resolveConflict`** (`PATCH /cutoff-periods/:id/approvals/:approvalId/conflict`, line 1408) — the actual (manual, admin-triggered) mechanism today, dispatched per company type to `bncCutoffStrategy.resolveConflict` / `daycareCutoffStrategy.resolveConflict`:
  - `choice: "leave"` — marks punch excluded, note `"Conflict resolved — leave takes precedence"`.
  - `choice: "punch"` — approves the raw punch, best-effort cancels the leave (`status: "rejected"`), returns deducted hours to `LeaveBalance` directly — **no reversing `LeaveTransaction` is written**, so the ledger goes out of sync with the balance.

### Missed clock-in checks (`src/jobs/checkMissedClockIns.js`, ~line 108-117)
Skips flagging a missed clock-in if the employee has an `approved` leave covering "today."

### OT basis
Leave never produces a `TimeLogApproval` row, so OT computation naturally excludes it by omission — there's no explicit "SL" (paid sick leave) term implemented, per `docs/TIMEKEEPING_GLOSSARY.md`.

### `affectedShifts` field
Written once at submit time (`submitLeaveRequest`, line 192-218) from client-supplied `affectedShiftIds` → snapshots `{userShiftId, assignedDate, shiftName, scheduledHours}`. **Never read back anywhere** — no approval-time or schedule-adjustment logic consumes it. Schema added via `scripts/migrate-leave-affected-shifts.sql` (changelog v2.10.16).

### Dashboard (`src/controllers/Features/dashboardController.js:53`, `getSidebarStats`)
Only counts `status: "pending"` leaves for `approverId: req.user.id` — **never counts `pending_secondary`**, so secondary approvers' sidebar badge undercounts.

### Notifications
`LEAVE_REQUEST_SUBMITTED`, `LEAVE_PENDING_SECONDARY_APPROVAL`, `LEAVE_REQUEST_FIRST_APPROVED`, `LEAVE_REQUEST_APPROVED`, `LEAVE_REQUEST_REJECTED` — all fired ad hoc inline from `leaveController.js` via `createNotification()` (`src/services/notificationService.js:9`). No dedicated leave notification helper functions (unlike timekeeping's `notifyMissedClockIn`/`notifyAutoClockOut`). All wrapped in try/catch so notification failures never fail the request.

---

## 9. Known Gaps / Inconsistencies (decide on these in the redo)

1. **`Company.secondaryApproverId` is dead code** — schema field + settings UI exist, but `leaveController.js` never reads it; secondary approver is chosen ad hoc via `escalateTo` at approval time.
2. **Two sources of truth for leave-hour cost** — `payrollController.js`'s leave-pay calc uses a crude calendar-day count instead of `calcRequestedHours`, so it can diverge from what the leave module itself charged against the balance.
3. **"Leave Always Wins" auto-exclusion is documented, not built** — `CUTOFF_PERIOD_MODULE.md`'s auto-exclusion rule and `leaveHours` payable formula don't exist in code; only manual `resolveConflict` + display metadata (`hasLeaveConflict`) exist. Confirmed as an open item in `TIMEKEEPING_GLOSSARY.md` too.
4. **Ledger integrity gap** — `resolveConflict` with `choice: "punch"` reverses a balance deduction directly without writing a reversing `LeaveTransaction`; ledger and balance go out of sync.
5. **`deleteLeave` has no guardrails** — any status (including `approved`) can be hard-deleted by the approver, no balance/transaction reversal, no restriction to non-approved states.
6. **`affectedShifts` is write-only** — captured at submit, never consumed by approval or schedule logic. Unclear if it's meant to drive schedule adjustments eventually or is purely a UI audit snapshot.
7. **Dashboard sidebar undercounts** — `pending_secondary` leaves aren't included in the pending-count badge.
8. **`leaveType` is free text, not an FK** — matched by name string between `Leave` and `LeavePolicy`; fragile against renames/typos/duplicates.
9. **`updatePolicy` can't actually update policy config** — only renames `leaveType`; no way to edit `annualAllocation`/`accrualFrequency`/etc. after creation via this endpoint.
10. **Unbounded positive balance adjustments** — `adjustBalance` floors at 0 for negative adjustments but has no ceiling (e.g. vs `annualAllocation`) for positive ones.
11. **`AttendanceSummary.leavePaidHours`/`leaveUnpaidHours` are dead schema** — never read or written anywhere in `src/`.
12. **`leaveStatus.cancelled` is unused** — no code path sets it; the closest analog is `resolveConflict` setting `status: "rejected"`.
13. **Date-storage fragility is a recurring real-world failure mode** — the "store as noon in company timezone" strategy exists specifically to dodge UTC day-drift, but `scripts/fix-leave-date-jhenelle-jul8-to-jul3.js` shows a real case where a leave was still saved on the wrong calendar day, and the fix explicitly left the ledger unreconciled.
14. **No plan-gating middleware found** for the `leaves` subscription feature flag (`seed.js:22`) despite it being defined as a plan feature — worth confirming this is enforced somewhere not found in this pass.

---

## 10. Real-World Support Cases (context for what breaks today)

- **`scripts/check-leave-balance-johna.js`, `scripts/check-leave-johna-rey.js`** — diagnostics for a case where a user's sick-leave balance didn't match expectations (16h deducted for 2 absent days), requiring manual reconciliation against `LeaveTransaction`/`TimeLog`/`TimeLogApproval`.
- **`scripts/find-jhenelle-leave.js`** — a leave ID shown in the client UI didn't match any row in the DB by that ID; had to look up by user instead. Suggests a possible stale-ID/caching/resolution bug between leave list and detail views.
- **`scripts/fix-leave-date-jhenelle-jul8-to-jul3.js`** — an approved Sick Leave was stored on the wrong calendar day (Jul 8 instead of Jul 3). Fixed dates only; `LeaveTransaction`/`LeaveBalance` were explicitly left untouched, so the ledger may still reflect the wrong date's deduction.

---

## 11. File Index

| File | Role |
|---|---|
| `src/prisma/schema.prisma` | `Leave`, `LeavePolicy`, `LeaveBalance`, `LeaveTransaction` models; `leaveStatus`, `LeaveTransactionType`, `AccrualFrequency`, `AccrualUnit` enums; `Company` leave config fields |
| `src/routes/Features/leaveRoutes.js` | `/api/leaves/*` |
| `src/routes/Features/leavePolicyRoutes.js` | `/api/leave-policies/*` |
| `src/routes/Features/leaveBalanceRoutes.js` | `/api/leave-balances/*` |
| `src/controllers/Features/leaveController.js` | submit/approve/reject/list/delete/approvers/affected-schedules/balances |
| `src/controllers/Features/leavePolicyController.js` | policy CRUD |
| `src/controllers/Features/leaveBalanceController.js` | manual adjust, matrix, transactions |
| `src/utils/leaveUtils.js` | `calcRequestedHours`, `monthlyIncrement` |
| `src/workers/leaveAccrualWorker.js` | monthly/yearly accrual cron |
| `src/controllers/Features/payrollController.js` | leave-pay in payroll run (separate calc) |
| `src/controllers/Features/cutoffPeriodController.js` | leave-vs-punch conflict metadata + `resolveConflict` |
| `src/jobs/checkMissedClockIns.js` | suppresses false alerts during approved leave |
| `src/services/notificationService.js` | generic `createNotification()` used inline for leave notifications |
| `scripts/add-leave-transaction-ledger.sql` | DDL for `LeaveTransaction` (v2.10.18) |
| `scripts/migrate-leave-affected-shifts.sql` | DDL adding `affectedShifts` (v2.10.16) |
| `docs/sql/check-leave-requests.sql` | reusable read-only ops/support query set |
| `docs/CUTOFF_PERIOD_MODULE.md` | documents intended (partly unbuilt) leave/cutoff integration |
| `docs/TIMEKEEPING_GLOSSARY.md` | canonical terminology; flags SL/leaveHours as open items |
| `docs/changelog-v2.10.15.md`, `v2.10.16.md`, `v2.10.18.md` | leave-relevant feature history |

---

## Related docs
- `docs/CUTOFF_PERIOD_MODULE.md`
- `docs/TIMEKEEPING_GLOSSARY.md`
- `docs/PAYROLL_SYSTEM.md`
