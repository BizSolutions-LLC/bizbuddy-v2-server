# Leave Module — Client Gap Assessment & Phased Plan

> Snapshot taken 2026-07-09, against `docs/CLIENT_LEAVE_CONTRACT.md` (Phases 1–5, all shipped server-side) and the current state of this repo's Leave UI. Purpose: avoid re-deriving this by re-reading the codebase every time. Read `docs/OLD_LEAVE_MODULE.md`, `docs/LEAVE_MODULE.md`, and `docs/CLIENT_LEAVE_CONTRACT.md` first for backend context — this doc is the client-side delta on top of those.

---

## File map (as of this snapshot)

Repo has no `lib/` API-wrapper layer for Leave — every call is a raw `fetch()` inline in the component. No axios usage anywhere in leave code.

**Employee leave request form + history:**
```
app/dashboard/employee/(D_Leaves)/leave-logs/page.jsx   — thin wrapper
  └── components/Dashboard/DashboardContent/EmployeePanel/Leaves/LeaveLogs.jsx  (1008 lines, all logic)
```

**Company leave-requests admin screen (single table + calendar, client-side status tab filter):**
```
app/dashboard/company/(PunchLogs&Overtimes&Leaves)/leave-requests/page.jsx   — thin wrapper
  └── components/Dashboard/DashboardContent/CompanyPanel/Punchlogs&Overtimes&Leaves/EmployeesLeaveRequests.jsx  (1301 lines, all logic)
```

**Leave Type/Policy admin CRUD + balance matrix + adjust credits (folded into general Company Configurations, not a standalone Leave admin page):**
```
app/dashboard/company/(Settings)/configurations/page.jsx
  └── components/Dashboard/DashboardContent/CompanyPanel/Settings/CompanyConfigurations.jsx  (2766 lines)
        ├── LeaveTypesCard()               L1602–1776  — Leave Type CRUD table (name only)
        ├── AdjustCreditsModal()           L1779–2079  — POST /api/leave-balances/adjust
        ├── LeaveCreditsAccordionCard()    L2090–2278  — the balance "matrix" screen
        ├── LeaveAccrualCard()             L1381–1490  — accrual settings (out of scope)
        └── LeaveApprovalCard()            L1493–1599  — two-step approval + final-approver dropdown
```

No dedicated leave-balance/credits page outside Configurations for admins; the only employee-facing balance UI is the "Leave balances" card inside `LeaveLogs.jsx` (L454–484).

---

## Gap Assessment by Phase

### Phase 1 — Leave Type admin
**Screen:** `CompanyConfigurations.jsx` → `LeaveTypesCard` (L1602–1776).

- **Needs new UI entirely.** Create/Edit form has one field: leave type name. No `isPaid`/`isNotPaid` toggles, no assignment picker, no employee multi-select. Request bodies only ever send `{ leaveType }`.
- List reads (`p.leaveType`, `p.id`) never destructure `isPaid`/`isNotPaid`/`assignedToAll`/`assignedUserIds` — need to add to the table display too.

### Phase 2 — Employee leave request form
**Screen:** `LeaveLogs.jsx`.

- **Type dropdown** — works as-is, already renders whatever `GET /api/leaves/policies` returns with no client filtering; assignment-scoping is transparent. Small tweak: also read `isNotPaid` (currently only `isPaid` is read).
- **Paid/Unpaid toggle — needs new UI.** `derivedIsPaid` (L162) is a read-only mirror of the policy's `isPaid` flag, shown as an info banner. No actual toggle exists — an employee can never choose Unpaid even when a type permits both.
- **`type` sent as free text** (`leaveType` string) in the submit body (L396–404), never `policyId`. Matches the contract's expected body shape, but the backend resolves policy by id-first/name-fallback and the client never sends an id — worth noting, not necessarily a bug.
- **Approver dropdown** — already correct posture, no client-side filtering.
- **New error states — small tweak.** New `400`s (bad pay-mode, not-assigned, invalid approver) all fall through to a generic `data.message` toast today. Acceptable per contract but a UX decision point (generic toast vs. field-level error).

### Phase 3 — List screens
**Screens:** `EmployeesLeaveRequests.jsx`, `LeaveLogs.jsx`.

- **Mostly transparent, confirmed.** No client-side role/department filtering in list-fetch paths.
- **Sidebar badge — needs a small fix, not a no-op.** Client never calls `GET /api/dashboard/sidebar-stats` (zero hits, confirmed). `sidebar.jsx` L590–603 independently fetches `GET /api/leaves` and counts `status === "pending"` client-side, missing `pending_secondary`. The backend's `sidebar-stats` fix doesn't reach this client — needs either a direct patch to the client-side count or migration to the dedicated endpoint.
- `GET /api/leaves/pending` is never called (client always uses the full list + client-side filter) — no migration needed there.

### Phase 4 — Approval screen
**Screens:** `EmployeesLeaveRequests.jsx` Approve/Reject dialog (L1093–1264), Detail Dialog (L874–1090).

- **Needs new UI entirely.** No preview call, no day-by-day paid/unpaid breakdown anywhere. Today's dialog shows an aggregate `requestedHours` (client-computed `days*8` fallback) plus a single-type balance summary from `/api/leaves/balances`. `GET /:id/preview` is net-new wiring.
- **`409` handling — needs new UI (small, contained).** `handleAction()` (L326–340) only special-cases the insufficient-balance `debug.available` shape; a `409` today falls through to a generic error toast with no auto-refresh.
- **`canAct` gating — already correct, no change needed.** Used consistently in all 3 places buttons can render (L825, L842, L1069); client trusts server's `canAct` rather than recomputing eligibility, so the broadened Phase 4 approver pool "just works" once the server sends broader `canAct: true` results.

### Phase 5 — Balance screens
**Screens:** `EmployeesLeaveRequests.jsx` Detail Dialog credits panel, `CompanyConfigurations.jsx` → `LeaveCreditsAccordionCard` + `AdjustCreditsModal`.

- **`GET /api/leaves/balances` — small tweak.** Only `leaveType`/`usedHours`/`balanceHours` are read today. `credits`/`used`/`available`/`isPaid`/`isNotPaid` are additive, non-breaking, just unread.
- **`GET /api/leave-balances/matrix` — hard breaking-change collision, needs a real fix.** Both independent implementations (`EmployeesLeaveRequests.jsx:264–291`, `CompanyConfigurations.jsx:2509–2540`, plus `AdjustCreditsModal`'s live-preview calc at L1951/1972–1974) assume a flat-number cell (`row.balances[t]`) plus a *separate* `row.usedBalances[t]` map, manually computing `available = credits - used`. Once the server ships `balances[t] = {credits, used, available}`, `Number({...})` → `NaN` and `row.usedBalances` won't exist — **breaks silently in three separate places** that don't share a helper.
- **`GET /api/leaves/:id/days` — needs new UI (optional per contract).** Not called anywhere; no "actual outcome" view exists.
- **`GET /api/leave-balances/transactions`** — never called, no ledger view exists. Not required by the contract beyond `balances`/`days` — likely out of scope.

---

## Proposed Phased Plan

**Phase 1 — Leave Type admin screen**
Extend `LeaveTypesCard`: Paid/Unpaid toggles, "All employees / Select employees" picker (reuse `MultiSelect.jsx`), send `isPaid`/`isNotPaid`/`assignedToAll`/`employeeIds` on create/update, surface the two new validation errors as form errors. Display new fields in the CRUD table.

**Phase 2 — Employee leave request form**
Replace the read-only `derivedIsPaid` banner with a real Paid/Unpaid toggle, conditional on `isPaid`/`isNotPaid`. Read `isNotPaid` from the policies response. Decide generic-toast vs. field-level errors for new `400`s.

**Phase 3 — List/visibility + sidebar badge**
Regression-check list screens render correctly with fewer rows (likely no code change). Fix sidebar badge in `sidebar.jsx` to include `pending_secondary`.

**Phase 4 — Approver review screen**
Add `GET /:id/preview` call on dialog open; render day-by-day paid/unpaid breakdown (new component). Add distinct `409` handling in `handleAction()` — friendly toast + auto refresh.

**Phase 5 — Balance screens (highest regression risk)**
1. Fix the matrix shape break first (silent breakage, not additive) — update both call sites + `AdjustCreditsModal`'s preview calc to read `row.balances[t].{credits,used,available}` directly; extract a shared helper since duplication is what let this drift.
2. Switch balance-summary UI to `credits`/`used`/`available` three-column display.
3. Optional: `GET /:id/days` view on leave detail panel.
4. `GET /api/leave-balances/transactions` — out of scope unless wanted.

**Sequencing note:** The Phase 5 matrix fix has no dependency on Phases 1–4 and could ship early/independently — it's a defensive fix against a known breaking change. Kept at position 5 to match backend rollout order unless the matrix endpoint is *already* returning the new shape in production, in which case the client is currently broken and this should jump the queue. Worth confirming before starting.

---

## Related docs
- `docs/OLD_LEAVE_MODULE.md`
- `docs/LEAVE_MODULE.md`
- `docs/CLIENT_LEAVE_CONTRACT.md`
