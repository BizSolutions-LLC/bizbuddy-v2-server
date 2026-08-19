# Changelog — v2.10.37

> **BB-069** — manual leave-balance adjustments now require a reason, and self-cancels can
> optionally carry one; both write to the existing (previously unused) `LeaveTransaction.note`
> column. **BB-072** — direct-supervisor approver resolution actually resolves the individually
> assigned supervisor (`EmploymentDetail.supervisorId`) instead of guessing from department, with
> a narrower company-admin fallback when none is assigned. Widening approver *selection* alone
> would have created leave requests a cross-department direct supervisor could be picked for but
> never act on — closed by widening the approval-authorization gate, the approver's pending-list
> visibility query, and the leave-day-breakdown visibility check to match, so the designated
> approver can always see and act on what they were assigned. Follows up on the deferral called
> out in v2.10.35's BB-055 changelog.

---

## Feature

### BB-069 — Required/Optional Reason on Leave-Balance Adjustment & Self-Cancel

**Why:** every other write path on the `LeaveTransaction` ledger (approve/reject/escalate via
`approverComments`, accrual, conflict-resolution credit) already records a reason. Manual balance
adjustments and self-cancels didn't — despite `LeaveTransaction.note` already existing
(nullable `String?`) and already being read back everywhere the ledger is displayed.

**`POST /api/leave-balance/adjust` (`adjustBalance`)** — `note` is now read from the request body
and **required**: missing or whitespace-only rejects with `400`
*"A reason is required for a manual balance adjustment."* Trimmed value is written to
`LeaveTransaction.note` on the resulting `adjustment` entry.

**`PUT /api/leaves/:id/cancel` (`cancelLeave`, self-cancel)** — `note` is now read from the
request body and **optional** (`null` if omitted), written to the resulting `cancelled` entry —
same pattern already used by `rejectLeave`'s `approverComments`.

**Client-side impact:** `POST /api/leave-balance/adjust` is a breaking contract change — any
caller not sending `note` now gets a `400`. The manual-adjustment UI needs a required reason field
before this ships. `PUT /api/leaves/:id/cancel` is additive/non-breaking — existing callers with no
body are unaffected.

---

### BB-072 — Real Direct-Supervisor Resolution, Narrowed Admin Fallback

**Why:** `getDirectSupervisors` (backing `GET /api/account/approver`) never actually looked at
`EmploymentDetail.supervisorId` — despite BB-055 (v2.10.35) adding it as a settable, validated
field. Instead it guessed a whole *department's* worth of supervisors via
`supervisedDepartments`/`supervisedEmployees`/`role: "supervisor"` matches, and separately,
`getEligibleApprovers` (backing `GET /api/leaves/approvers`) let any same-department
`role: "supervisor"` user act as a fallback approver regardless of an actual assignment. This is
exactly the gap v2.10.35's changelog flagged as deferred.

**`getDirectSupervisors`** (`src/services/Approvers/approverResolutionService.js`) — now looks up
the requester's `employmentDetail.supervisorId` first. If set and the assigned supervisor is
`status: "active"` in the same company, returns that one user as a single-element array. If unset,
or the assigned supervisor is no longer active/valid, falls back to the company admin/superadmin
list — the same query previously reserved for "no department." No more department-level guessing.

**`getEligibleApprovers`** (same file) — simplified to pure company-wide admin/superadmin. Dropped
the department-scoped `role: "supervisor"` condition; direct-supervisor selection is now
`getDirectSupervisors`'s job exclusively, so the two functions' responsibilities never overlap.

**`GET /api/leaves/approvers` (`getApprovers`)** — now calls both functions and returns
`{ data: { supervisors, approvers } }` (supervisors: 0-1 entry, `{ id, name, jobTitle, role }`;
approvers: admin/superadmin list, `{ id, name, email, role }`) — same split shape and field
trimming already used by `punchLogsBootstrapController`.

**`submitLeaveRequest`'s inline approver re-validation** — widened to also accept
`approverId === requester.employmentDetail.supervisorId`, alongside the existing admin/superadmin
and same-department-supervisor conditions. Nothing previously valid was removed — a legitimately
assigned direct supervisor in a *different* department, previously rejected with
`"Invalid approver selected."`, is now accepted.

**Confirmed no change needed:** `overtimeController.js`'s approver validation is already
role-based and company-wide with no department restriction — accepts any assigned direct
supervisor as-is. `requestPunchLogController.js` and `contestPolicyController.js` have no
server-side approver-eligibility validation today (pre-existing gap, out of scope here).
`punchLogsBootstrapController.js` needed no code change — it already calls both service functions
in parallel and returns them separately, so it inherits the fix automatically.

---

## Bug Fix (found while implementing BB-072 — same release)

### Cross-Department Direct Supervisor Could Be Assigned as Approver but Never Act On It

**The gap:** widening *selection* (`submitLeaveRequest`) without also widening
*authorization* would have created leave requests assigned to a supervisor who then couldn't
approve, reject, or preview them.

**`_isEligibleApprover`** (`leaveController.js`) — signature widened from
`(actingRole, actingDepartmentId, requesterDepartmentId)` to
`(actingUserId, actingRole, actingDepartmentId, requesterDepartmentId, requesterSupervisorId)`.
Now also returns `true` when the acting user is the requester's individually assigned direct
supervisor, regardless of department. Updated at every call site: `approveLeave`, `rejectLeave`,
`previewApproval` (the actual permission gate), `getPendingLeavesForApprover` /
`getLeavesForApprover` (the `canAct` flag), and the management-notification-pool filters in
`submitLeaveRequest`, `approveLeave`'s escalation branch, and `cancelLeave`.

### Cross-Department Direct Supervisor Couldn't See the Leave in Their Pending List at All

**The gap, one layer deeper:** even with `_isEligibleApprover` fixed, the leave would never
surface in the first place — `leaveVisibilityWhere` (`src/utils/leaveUtils.js`), the DB-query-level
visibility filter, only matched a `role: "supervisor"` acting user against requesters in their
*own* department. The leave was excluded from the query results before `canAct` was ever computed.

**Fixed:** `leaveVisibilityWhere` gained a new `actingUserId` parameter and now matches on
`{ OR: [{ employmentDetail: { supervisorId: actingUserId } }, { departmentId }] }` for a
supervisor — direct-report assignment OR same-department, either is sufficient. All 4 call sites
updated: `getPendingLeavesForApprover`, `getLeavesForApprover` (`leaveController.js`),
`getTransactions` (`leaveBalanceController.js`, the management leave-ledger feed), and the
pending-leave-count widget (`dashboardController.js`).

**`getLeaveDays`** (`leaveController.js`) had its own separate inline department check (not
routed through `leaveVisibilityWhere`) gating the post-decision day-level breakdown view — same
bug, same fix: now also allows the requester's assigned direct supervisor regardless of
department.

**Client-side impact:** none of this is a contract change — no request/response shape changed.
Behavioral only: a supervisor's pending-approvals list, leave-ledger feed, and dashboard pending
count may now include direct reports outside their own department, where before they wouldn't
have. Worth flagging to QA, not to the client dev.

---

## Files Changed

| File | Change |
|---|---|
| `src/controllers/Features/leaveBalanceController.js` | `adjustBalance`: `note` required, validated, written to the ledger entry. `getTransactions`: `leaveVisibilityWhere` call updated for the new `actingUserId` param |
| `src/controllers/Features/leaveController.js` | `cancelLeave`: optional `note`. `_isEligibleApprover`: widened signature + direct-supervisor check, all call sites updated. `_loadActionableLeave`: now selects `employmentDetail.supervisorId`. `submitLeaveRequest`: approver re-validation widened, notification-pool fetch/filter updated. `getPendingLeavesForApprover`/`getLeavesForApprover`: `User` select + `canAct` + `leaveVisibilityWhere` call updated. `getApprovers`: now returns `{ supervisors, approvers }`. `getLeaveDays`: inline visibility check widened |
| `src/services/Approvers/approverResolutionService.js` | `getEligibleApprovers`: simplified to pure admin/superadmin. `getDirectSupervisors`: rewritten to resolve the real assigned supervisor with admin fallback, department-guessing branch removed |
| `src/utils/leaveUtils.js` | `leaveVisibilityWhere`: new `actingUserId` param, OR-based direct-supervisor + same-department match |
| `src/controllers/Features/dashboardController.js` | `leaveVisibilityWhere` call updated for the new `actingUserId` param |
