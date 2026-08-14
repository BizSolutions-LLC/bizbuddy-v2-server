# Changelog — v2.10.35

> **BB-055** — every employee can now have an optional, single direct supervisor
> (`EmploymentDetail.supervisorId`) assigned or changed from the main employee-edit endpoint, which
> previously ignored the field entirely. Closes it with guardrails: only active
> supervisor/admin/superadmin users in the same company are assignable (plain `employee` role
> rejected, self-supervision rejected), and assignment is edit-only — it can no longer silently
> spin up a bare `EmploymentDetail` row for an employee who doesn't have one yet. Also closes an
> unrelated pre-existing gap found along the way: `PUT /employment-details/me` had zero validation,
> letting any employee assign literally anyone as their own "supervisor." Approver-list changes
> (making the assigned supervisor show up as a default approver for leave/OT/punch-log requests)
> are deliberately out of scope for this release — deferred pending further discussion.

---

## Feature

### BB-055 — Direct Supervisor Assignment via Employee-Edit Endpoint

**Why:** `EmploymentDetail.supervisorId` already existed in the schema and was settable at
employee creation, but `updateEmployee` (`PUT /api/employee/:id` — the main employee-edit
endpoint) never read or wrote it. Changing an employee's supervisor after creation required a
separate call to `/employment-details/:id`.

**Added:** `updateEmployee` now accepts `supervisorId` in the request body:
- a user id → sets/changes the supervisor (validated, see below)
- `null` or `"none"` → clears it
- omitted → left unchanged

**Edit-only constraint:** setting a supervisor now requires the employee to already have an
`EmploymentDetail` record. If they don't, the request is rejected with `400` — *"Set up this
employee's employment details before assigning a supervisor."* — instead of the previous `upsert`
behavior, which would have silently created a new, mostly-empty `EmploymentDetail` row (every
other field left `null`) as a side effect of a supervisor change. Clearing a supervisor on an
employee with no existing record is a harmless no-op (nothing to clear).

**Response shape:** `updateEmployee`'s `employmentDetail` payload now includes a nested
`supervisor` object (`id`, `email`, `profile.firstName/lastName`), matching the shape already
returned by `getAllEmployees`/`getEmployeeById`, so the client can confirm the assignment without
a follow-up fetch.

---

## Validation / Security Fix

### BB-055 — Supervisor Assignment Was Completely Unvalidated

**The gap:** every code path that wrote `supervisorId` (`createEmployee`, `bulkCreateEmployees`,
and both `employmentDetailController.js` upsert handlers) accepted any user id with no checks —
no company match, no active-status check, no role check, no self-reference check. Most notably,
`PUT /employment-details/me` has no role restriction on the route itself (any authenticated
employee can call it), so any employee could assign literally any other user — including a peer
with plain `employee` role — as their own "direct supervisor."

**Fixed:** new shared helper `src/utils/supervisorValidation.js`
(`validateSupervisorId({ supervisorId, companyId, targetUserId })`), applied at every write site.
Rejects unless the candidate is:
- an **active** user
- in the **same company**
- with role `supervisor`, `admin`, or `superadmin` (plain `employee` rejected)
- not the same user as the employee being assigned to (no self-supervision)

Returns `400` with a descriptive error (`"Supervisor must be an active supervisor, admin, or
superadmin in your company."` / `"An employee cannot be assigned as their own supervisor."`) on
failure; returns `null` (no-op) when `supervisorId` is empty, so clearing the field is unaffected.

**Client-side impact:** yes. The supervisor-picker dropdown/select should filter candidates to
`role IN (supervisor, admin, superadmin)` client-side to avoid submit-time rejections. Employee-edit
forms can now send `supervisorId` directly to `PUT /api/employee/:id` instead of a separate
`/employment-details/:id` call. Full write-up already shared with the client team separately
(BB-055 client notes).

---

## Not Included — Deferred

Direct supervisor is **not** yet factored into any default-approver selection list (leave
requests, punch-log/timelog edit requests, overtime). `GET /api/leaves/approvers`,
`GET /api/account/approver`, and the approvers/supervisors data in the punch-logs-bootstrap
payload are unchanged — still role + department based
(`src/services/Approvers/approverResolutionService.js`). Making the assigned supervisor
automatically eligible as an approver also requires updates to `leaveController.js`'s
`_isEligibleApprover` (approve/reject/escalate authorization) and `leaveUtils.js`'s
`leaveVisibilityWhere` (approver's request queue visibility) to stay consistent — scoped but
intentionally not started this release, pending further discussion.

---

## Files Changed

| File | Change |
|---|---|
| `src/utils/supervisorValidation.js` | New — shared `validateSupervisorId` guard used by every `supervisorId` write site |
| `src/controllers/Features/employeeController.js` | `updateEmployee`: added `supervisorId` handling (edit-only guard + validation + response shape update). `createEmployee` and `bulkCreateEmployees`: added the same validation to their existing `supervisorId` handling |
| `src/controllers/Features/employmentDetailController.js` | `upsertMyEmploymentDetails` and `upsertEmploymentDetailsById`: added the same validation before writing `supervisorId` |
