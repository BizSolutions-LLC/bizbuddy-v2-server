# Client Leave Contract — Phase 1, 2, 3, 4, 5 & Archive

> What the client (web/mobile) needs to change to consume the Leave Module redo, phase by phase. See `docs/UPDATED_LEAVE_MODULE.md` for the full design/rationale. Update this doc as each phase ships.

---

## Phase 1 — Leave Type management (admin settings)

**Endpoints:** `GET/POST/PUT/DELETE /api/leave-policies` (unchanged paths, extended payloads)

New fields on a Leave Type, all present in `GET /api/leave-policies` responses:

| Field | Type | Notes |
|---|---|---|
| `isPaid` | boolean | Whether employees may request this type as paid. Default `true`. |
| `isNotPaid` | boolean | Whether employees may request this type as unpaid. Default `true`. |
| `assignedToAll` | boolean | `true` = every employee can use this type. `false` = restricted to `assignedUserIds`. |
| `assignedUserIds` | string[] \| undefined | Only present when `assignedToAll: false`. |

**Create/Update body** (`POST`/`PUT`) now accepts: `isPaid`, `isNotPaid`, `assignedToAll`, `employeeIds` (array, only read when `assignedToAll: false`).

**Validation to handle:**
- `400` if both `isPaid` and `isNotPaid` are `false` — "At least one of isPaid or isNotPaid must be enabled."
- `400` if any `employeeIds` entry doesn't belong to the caller's company.

**UI work:** Leave Type CRUD form — name, two toggles (Paid / Unpaid), an assignment picker ("All employees" vs. "Select employees" + multi-select against the existing employee list endpoint). No employee-facing screens change in this phase.

---

## Phase 2 — Request submission

**Endpoint:** `POST /api/leaves/submit` (same path, same required fields — `type`, `fromDate`, `toDate`, `approverId`; `leaveReason`, `isPaid`, `affectedShiftIds` still optional)

### 1. Leave-type dropdown must reflect assignment

`GET /api/leaves/policies` (`getAvailablePolicies`) now **only returns leave types the caller is actually assigned to** (previously returned every company policy). No client filtering needed — just render what comes back. This response also now includes `isPaid`/`isNotPaid` per policy (needed for #2).

### 2. Paid/Unpaid toggle — conditional, not always shown

For the selected leave type, use its `isPaid`/`isNotPaid` flags to decide the UI:

| `isPaid` | `isNotPaid` | UI |
|---|---|---|
| `true` | `true` | Show a Paid/Unpaid toggle — employee's free choice, honored as-is (not just an insufficient-balance fallback). |
| `true` | `false` | No toggle — always submitted as paid. |
| `false` | `true` | No toggle — always submitted as unpaid. |

Submit `isPaid: true/false` in the request body per the resolved choice (omit → defaults to `true` server-side).

**New error to handle:** `400` — `"This leave type cannot be requested as paid."` / `"...as unpaid."` (defensive server-side check; shouldn't trigger if the client respects the flags above, but handle it as a generic form error just in case).

### 3. Approver dropdown is now department-scoped

`GET /api/leaves/approvers` (`getApprovers`) now returns **only**: all admins/superadmins (company-wide) + supervisors in the **caller's own department**. If the caller has no department, only admins/superadmins are returned. No client-side filtering needed, but if the previous UI showed a department label/grouping for approvers, it can be dropped since the list is now pre-scoped.

**New error to handle:** submitting with an `approverId` outside this scope now returns `400 — "Invalid approver selected."` (previously any admin/supervisor/superadmin company-wide was valid — a request built with a stale/cached approver list from before this change could now fail this check).

### 4. New possible error — assignment gate

`403 — "You are not assigned to this leave type."` — shouldn't be reachable if the client only offers types from `GET /api/leaves/policies` (which is already assignment-filtered per #1), but handle it defensively (e.g. stale client cache, leave type re-scoped after the form was opened).

---

## Phase 3 — Viewing (department-scoped)

**Endpoints:** `GET /api/leaves/pending`, `GET /api/leaves` (list), `GET /api/dashboard/sidebar-stats` — all unchanged paths/response shapes.

**Behavior change, no shape change:** supervisors now only receive leaves from employees in their **own department** (previously company-wide for every management role). Admins/superadmins are unaffected — still company-wide. A supervisor with no department assigned will now see an empty list where they previously saw everything.

**UI work:** none required — this is a server-side filter, the client just renders fewer rows for supervisor accounts. Worth a heads-up to support/QA so a smaller list isn't mistaken for a bug during rollout.

**Sidebar badge fix:** `pendingLeaveRequests` in `GET /api/dashboard/sidebar-stats` now also counts `pending_secondary` leaves (previously only `pending`), and uses the same department scoping as the list endpoints above — so the badge count and the list a user opens from it will now always match.

**Still using the existing `canAct` flag:** on `getPendingLeavesForApprover`/`getLeavesForApprover` rows, `canAct: true` still only means "you are the specific approver/secondary approver named on this request" — a supervisor may now see department colleagues' leaves in the list with `canAct: false`, meaning visible but not yet actionable by them (that broadens in Phase 4). Keep any "Approve" button gated on `canAct`, not just row presence.

---

## Phase 4 — Approval / Decline + Ledger

**New endpoint:** `GET /api/leaves/:id/preview` — read-only, no side effects. Call this when the approver opens a leave request, **before** they click Approve/Reject, to render the computed breakdown.

Response shape:
```json
{
  "data": {
    "isPaid": true,
    "availableBalance": 24,
    "paidHours": 16,
    "unpaidHours": 8,
    "days": [
      { "date": "2026-07-06", "hours": 8, "isPaid": true },
      { "date": "2026-07-07", "hours": 8, "isPaid": true },
      { "date": "2026-07-08", "hours": 8, "isPaid": false }
    ]
  }
}
```
- `isPaid: false` at the top level means the employee deliberately requested unpaid — `availableBalance` is `null` and every day is `isPaid: false`, balance was never checked.
- `isPaid: true` means the employee wants paid; `days` shows exactly which days will be paid vs. auto-fall to unpaid given their *current* balance. **Render this breakdown to the approver before they confirm** — this is the "final computation on the approver's dashboard" from the original design discussion.
- This is a preview only — the actual split is (re)computed at the moment `PUT /:id/approve` is called, so if balance changes between preview and confirm (e.g. another leave gets approved first), the final result can differ slightly. No action needed client-side for this — just don't cache the preview indefinitely.

**`PUT /api/leaves/:id/approve` and `PUT /api/leaves/:id/reject`** — same paths/bodies, two behavior changes:

1. **Broadened approver pool.** Previously only the specifically named `approverId` (or `secondaryApproverId`, once escalated) could act. Now **any admin/superadmin, or any supervisor in the leave requester's department**, can approve/reject/escalate — being the "assigned" approver is no longer exclusive. Any list/queue screen showing "leaves I can act on" should use this same rule, not just filter by `approverId === me`.
2. **New `409` response** — `"This leave request was already actioned by someone else."` This is expected and not a bug: it means someone else in the eligible pool acted on the request between when the client loaded it and when the approve/reject button was pressed. Handle it as a friendly "someone already handled this" state — refresh the list, don't show it as a generic error.

**Approved leave response now reflects the real outcome**, not just the submitted intent — a request the employee marked "paid" can come back partially unpaid if their balance ran out partway through the date range (see the preview endpoint above; the same split is what actually got applied).

**UI work:**
- Approver detail/review screen: call the preview endpoint on load, render the day-by-day paid/unpaid breakdown before the Approve button.
- Approve/reject actions: handle `409` distinctly from other errors.
- Any "pending approvals" list gated by "is this assigned to me" should switch to "am I an eligible approver" (admin, or supervisor of this employee's department) — otherwise supervisors will see requests in the list (Phase 3) they can't actually act on for the wrong reason.

---

## Phase 5 — Ledger read-side (Credits / Used / Available)

**`GET /api/leaves/balances`** — same path, response extended, nothing removed. Each entry now includes:

```json
{
  "policyId": "...",
  "leaveType": "Sick Leave",
  "isPaid": true,
  "isNotPaid": true,
  "credits": 40,
  "used": 16,
  "available": 24,
  "balanceHours": 24,
  "usedHours": 16,
  "shiftHours": 8,
  "transactions": [ /* unchanged shape */ ]
}
```
Use `credits`/`used`/`available` for the new three-column balance UI. `balanceHours`/`usedHours` are kept as-is (equal to `available`/`used`) purely for any code not yet migrated — no need to read both, they're always identical.

**`GET /leave-balances/matrix` — BREAKING shape change.** Previously each cell in `data[].balances` was a flat number (hours available). It is now an object:
```json
// before
"balances": { "Sick Leave": 24 }
// after
"balances": { "Sick Leave": { "credits": 40, "used": 16, "available": 24 } }
```
This is a genuine breaking change — update any code reading this endpoint. Given the admin balance matrix screen likely hasn't been built against the old shape yet, this should be low-impact, but flagging clearly since it's not additive like every other change so far.

**New endpoint: `GET /api/leaves/:id/days`** — returns the day-by-day paid/unpaid breakdown for a leave *after* a decision has been made (companion to Phase 4's `GET /api/leaves/:id/preview`, which is the *before*-decision version). Same response shape as the preview's `days` array:
```json
{ "data": [ { "date": "2026-07-06", "isPaid": true, "hours": 8 }, ... ] }
```
Visible to the leave's own requester, or management under the same department-scoped visibility as the Phase 3 list endpoints. Useful for a leave detail view to show exactly what happened, not just the submitted intent.

**UI work:**
- Balance screens: switch to `credits`/`used`/`available` three-column display.
- Admin balance matrix table: update to the new per-cell object shape.
- Leave detail view (optional): call `GET /:id/days` for approved/rejected leaves to show the actual day-by-day outcome.

---

## Delete Leave Type — message improved, new `code` field

**`DELETE /api/leave-policies/:id`** — same path, no shape removed, one field added.

Previously, a `409` (policy still has attached leave requests/balances/history) always returned the same generic message regardless of what was actually blocking it. It now names the real blockers:
```json
{
  "message": "Can't delete this leave type — it still has 3 leave requests, 1 balance record attached. Disable it instead (unassign all employees) to stop future use while keeping history intact.",
  "code": "LEAVE_POLICY_IN_USE"
}
```
`message` alone is safe to just keep showing in a toast as before — no required change. The new `code` field is optional to use, but if you want a specific UI treatment here (e.g. a "Disable instead" button/link rather than a plain error toast), branch on `code === "LEAVE_POLICY_IN_USE"` rather than parsing `message` text, since the wording can change.

This is the seed of a broader app-wide error-code convention, not a one-off — see **`docs/ERROR_CODES.md`** (new doc, copy it into this repo alongside the other three; it's not Leave-specific, it'll grow as more endpoints adopt `{ message, code }` over time).

---

## Archive Leave Type (post-Phase-5 addition)

The right way to retire a leave type that has real history — `deletePolicy` will keep refusing those (see above), archiving is the actual answer to "make this go away."

**`GET /api/leave-policies/`** — each policy now includes `isArchived` (boolean) and `archivedAt` (ISO string or `null`). **Excludes archived types by default** — pass `?includeArchived=true` to see them (e.g. for an "show archived" toggle in the admin list).

**`PUT /api/leave-policies/:id`** — accepts `isArchived: true/false` in the body, same endpoint as everything else in Phase 1, no new route.

**`GET /api/leaves/policies`** (employee-facing dropdown) — archived types are **always** excluded now, regardless of assignment. No client filtering needed, same as the Phase 2 assignment-filtering behavior.

**New `400`** on submit — `"This leave type has been archived and can no longer be used."` Shouldn't be reachable if the client only offers types from the policies endpoint above, but handle it defensively (stale cache, type archived after the form was opened) — same pattern as the Phase 2 assignment-gate error.

**UI work:**
- Leave Type admin list: add an Archive/Unarchive action (calls `PUT` with `isArchived`), hide archived types by default with a toggle to show them.
- `deletePolicy`'s `409` message now says "Archive it instead" — if you built any UI around the old wording pointing at unassigning employees, update it to surface the Archive action instead.

---

## Ledger view — no longer out of scope

Your own gap assessment (`DISCREPANCY_LEAVE_MODULE.md`, Phase 5) marked `GET /api/leave-balances/transactions` as *"never called, no ledger view exists... likely out of scope."* Reversing that — an admin added credit via `AdjustCreditsModal`, the transaction was written correctly server-side, but there was nowhere on screen to see it, which read as "the ledger is empty."

**Where it goes:** Settings side, attached to the Balance Matrix / `AdjustCreditsModal` area — that's where credits change, so that's where an admin needs to audit them. A cell/row drill-down calling `GET /leave-balances/transactions?userId=X&policyId=Y` (existing endpoint, already paginated/filterable by `policyId`/`type`).

**Not** the Approver side (`EmployeesLeaveRequests.jsx`) — that already gets the specific transaction tied to whichever leave request is being reviewed, inline in the leave data (no separate ledger UI needed there). See `docs/UPDATED_LEAVE_MODULE.md` §14g for the full reasoning.

---

## Not yet changed (still on old behavior)

- Cancel Leave — doesn't exist yet, Phase 6. Also Phase 6's job: the punch-vs-leave "Leave Always Wins" → "Punch Wins" auto-exclusion rule, which is the one remaining case where `available` can still (rarely) disagree with a pure ledger reconstruction — see `docs/UPDATED_LEAVE_MODULE.md` §14e.
