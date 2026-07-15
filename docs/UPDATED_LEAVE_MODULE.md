# Updated Leave Module — Target Design (Draft)

> Status: **Draft — Phase 1 (core fundamentals agreed)**. Captures the redo concept as discussed and locked in so far. This is a behavioral/conceptual spec, not final schema — data shapes below are illustrative. Diff this against `docs/OLD_LEAVE_MODULE.md` to see what's changing and why. Sections marked **Deferred** are intentionally parked for a later discussion pass, not forgotten.

---

## 1. Scope of this phase

Agreed as in-scope now: Leave Type creation, assignment, balance model (Credits/Used/Available), submission pay-mode intent, approval scope + escalation, visibility scope, ledger, and punch-vs-leave conflict handling.

Explicitly **deferred** to a later pass (see §9): credits/accrual mechanics (current leave-year already has accrued values mid-year, so migration needs its own discussion), Cancel-Leave button UX / automatic-vs-manual punch reversal, `affectedShifts`/schedule-impact handling, payroll/cutoff integration specifics beyond the punch-wins rule, and `LeaveType.defaultValue` details.

---

## 2. Leave Type

Per-company, admin-configured entity — replaces today's free-text `Leave.leaveType` string matched against `LeavePolicy.leaveType` by name (see `OLD_LEAVE_MODULE.md` §9.8).

| Field | Purpose |
|---|---|
| `name` | e.g. "Sick Leave", "Vacation Leave" |
| `isPaid` | Permission gate — whether employees may request this type as **paid** (deduct from balance) |
| `isNotPaid` | Permission gate — whether employees may request this type as **unpaid** (no deduction) |
| `defaultValue` | Default credit allocation — **deferred**, not detailed yet |

A type can permit paid only, unpaid only, or both. If both are allowed, the employee chooses intent per request (§5). If a type is paid-only, the unpaid opt-out isn't offered to the employee for that type.

---

## 3. Assignment

A Leave Type is explicitly **assigned** to employees — either "all employees" or a selected subset — rather than implicitly available to everyone the moment a balance row gets lazily created (today's behavior: `_deductBalance` upserts a zero balance on first use with no gate at all).

This is what makes restricted leave types (maternity, tenure-based, license-required) possible for the first time — today literally any employee can accrue/use any leave type.

---

## 4. Balance Model — Credits / Used / Available

Three visible columns per employee per assigned Leave Type:

- **Credits** — total granted (mechanics of how this grows deferred to §9)
- **Used** — hours consumed by **approved, paid (or paid-portion)** leave
- **Available** — derived as `Credits − Used` (not stored independently, to avoid the drift/tally bug noted in §7)

Unpaid leave (whether by deliberate choice or auto-fallback) does **not** touch `Used`/`Available` — it's tracked in the ledger for audit purposes but doesn't move the balance.

---

## 5. Submission — Pay-Mode Intent

At submission, the employee picks:
1. The Leave Type (must be one they're assigned to)
2. Date range
3. **Pay-mode intent**: Paid or Unpaid — only options permitted by the type's `isPaid`/`isNotPaid` flags are offered

This intent is **not** just a fallback for insufficient balance — an employee with plenty of balance can still deliberately choose Unpaid to preserve their credits. That choice is honored as-is, no balance check needed.

No deduction happens at submission time regardless of intent — see §6.

---

## 6. Balance Deduction Timing & Per-Day Proration

Deduction happens **at approval**, not submission — this matches today's timing model, but fixes the hard-block behavior.

- **Employee requested Unpaid** → nothing is checked or deducted. Full request is unpaid by choice.
- **Employee requested Paid** → at approval time, the system computes required hours **per day** across the range and checks against `Available`:
  - Days covered by available balance → deducted as paid, `Used` increases accordingly.
  - Days beyond what's available → automatically fall back to unpaid for just those days.
  - Result: a single Leave request can end up **mixed** — part paid, part unpaid — rather than the whole request being all-or-nothing. This replaces today's hard 400-error block on insufficient balance (`_deductBalance` in `leaveController.js`).
- The approver's dashboard is where this computation surfaces before final approval — the approver sees the paid/unpaid breakdown, not just a single boolean.

**Data shape decision:** the per-day breakdown is stored as a **child table** (`LeaveDay` — one row per calendar date in the request's range, each carrying its own paid/unpaid flag + hours), not summary fields on `Leave`. This is what makes per-day proration *and* single-day reversal (§11, Cancel Leave) possible without touching the rest of a multi-day request.

---

## 7. Known bug carried into the redo

Today, `Used` does not reliably tally against approved leave hours (confirmed against real support cases — see `OLD_LEAVE_MODULE.md` §10, Johna Rey balance-mismatch scripts). This isn't being patched separately; it gets fixed as part of building the new deduction/ledger logic in this redo, since `Available` is now explicitly derived (`Credits − Used`) rather than tracked as an independent field that can drift.

---

## 8. Approval Scope

**Eligible approver pool** (company-wide config, not per-request):
- **All admins** — unrestricted, company-wide, regardless of department
- **All Supervisors of the employee's assigned department** — department-scoped

**"Assigned approver"** is still chosen by the employee at submission time, via a dropdown — but that dropdown is now restricted to admins + SVs of the employee's own department (today it's any admin/supervisor/superadmin company-wide, see `OLD_LEAVE_MODULE.md` §3). Being "assigned" is a default/notification target, **not exclusive** — any other qualifying admin or that department's SV can still act on the request even if not the one named.

**Two-step escalation** — preserved conceptually from today's `escalateTo` mechanism, just re-scoped to the admin + dept-SV pool instead of the currently-dead `Company.secondaryApproverId` default:
- The first approver, at the moment of approval, decides via a dropdown whether the request needs a second approval, or none.
- If none is chosen, that first approval is sufficient — final `approved` status.
- If a second approver is chosen, request moves to a secondary-pending state until that person acts.

**Concurrency note (carried from earlier discussion):** since multiple people (all admins + all dept SVs) now have live approve rights on the same request, the approval write must guard against double-processing (e.g., an atomic status check as part of the update) — two people approving near-simultaneously must not double-deduct.

---

## 9. Visibility Scope

Same department logic as approval:
- **Admins** — see all leave requests (pending, approved, cancelled, declined) company-wide.
- **Supervisors** — see only requests from employees in their own assigned department.
- Employees continue to only see their own requests (unchanged from today).

---

## 10. Ledger

Formal, first-class audit trail — historical record of every balance movement: grants/credits, paid deductions on approval, adjustments, and reversals. This is a superset of today's `LeaveTransaction` model, with one required fix: every balance-affecting action (including reversals, see §11) must write a ledger entry — today's `resolveConflict` "punch wins" path bumps the balance directly with no ledger entry, which is exactly the kind of gap this ledger is meant to close (`OLD_LEAVE_MODULE.md` §9.4).

---

## 11. Punch-vs-Leave Conflict — "Punch Wins" (replaces "Leave Always Wins")

Today's documented-but-unimplemented rule was "Leave Always Wins" (auto-exclude the punch). This is being flipped:

- If a leave was approved (and paid hours deducted) for a day, but the employee actually punched in/out that day, the **leave loses** — it gets cancelled/reverted for that day.
- Reversal returns the deducted hours from `Used` back to `Available` via a proper ledger entry (not a raw balance increment like today's bug).
- Trigger mechanism (automatic on punch detection vs. a manual "Cancel Leave" button) — **deferred**, to be decided in a later discussion pass.

---

## 12. How this addresses the Old Module's gaps

Cross-reference to `OLD_LEAVE_MODULE.md` §9:

| Old gap | Resolved by this design |
|---|---|
| §9.1 `Company.secondaryApproverId` dead code | Replaced — secondary approver is chosen live via escalation dropdown, scoped to admin+dept-SV pool (§8) |
| §9.4 Ledger integrity gap on conflict reversal | Fixed — all reversals must write a ledger entry (§10, §11) |
| §9.5 `deleteLeave` no guardrails | Not yet addressed — needs a decision in a later pass |
| §9.8 `leaveType` free text, not FK | Fixed — Leave Type is now a first-class entity (§2) |
| §9.9 `updatePolicy` can't edit config | Not yet addressed — Leave Type management endpoints TBD |
| §9.10 Unbounded positive balance adjustments | Not yet addressed |
| §9.13 Date-storage fragility | Not yet addressed — noon-in-company-tz convention likely carries forward, to confirm |
| §9.3 "Leave Always Wins" unimplemented | Superseded — replaced by "Punch Wins" (§11), still needs trigger-mechanism decision |
| Real bug: `Used` not tallying | Fixed by design — `Available` is derived, not independently stored (§4, §7) |

---

## 13. Migration Plan (existing data → new model)

| Existing data | Migration approach |
|---|---|
| `LeaveBalance.balanceHours` | **Recompute, don't trust as-is.** Reconstruct `Credits` = sum of historical `accrual` + positive `adjustment` transactions; `Used` = sum of historical `deduction` transactions. `Available` becomes derived (`Credits − Used`) going forward, not an independently stored field. Since the existing ledger already has this history, this migration likely **retroactively fixes** the known tally bug rather than carrying it forward. |
| Approved `Leave` records (no day-level data) | Backfill `LeaveDay` child rows uniformly from the existing whole-record `isPaid` boolean — an approved paid leave becomes all-paid days, an unpaid one becomes all-unpaid days. No data loss; just no retroactive proration (there's no historical basis to prorate against). |
| Pending `Leave` records at cutover | Treat existing `isPaid` as the new pay-mode **intent** and let them flow through the new approval logic (proration, dept-scoped pool) the next time someone acts on them. |
| `Leave.leaveType` (free text) / no `policyId` FK today | Add `policyId` FK to `Leave`, resolved from the existing name-match logic at migration time; keep `leaveType` string only as a display fallback if resolution fails. |
| Implicit access via existing `LeaveBalance` rows | **Auto-assign** — every user with an existing `LeaveBalance` row for a policy gets an automatic assignment record on migration, preserving current access with no admin action required. |
| Department scoping prerequisite | Before Phase 4 ships, verify `departmentId` is populated for all admins/SVs/employees who'll participate in approval — data-quality check, not a code change. |

**Live-DB safety principle (applies to every phase):** no new column may be `NOT NULL` without a default on a table that already has rows. Every schema addition ships with a safe default (matching current behavior where possible) so existing rows are valid immediately and no backfill blocks the migration. Backfills (like the assignment auto-backfill) run as additive `INSERT ... SELECT` scripts in `scripts/`, run manually per `memory/feedback_migration.md` — never `prisma db push --accept-data-loss` against live data.

---

## 14. Implementation Phase Plan

Original 6-phase order confirmed, with one sequencing change: **Ledger (originally Phase 5) is built together with Phase 4 (Approval)**, since per-day proration needs correct, atomic ledger writes from the moment approval logic ships — building it after would mean retrofitting. Phase 5 becomes primarily the read-side (transaction history views, balance matrix) plus remaining ledger polish (e.g. reversal entries for Phase 6).

| Phase | Contains | Size/Risk | Client/UI Integration (high-level) |
|---|---|---|---|
| 1. Leave Type creation ✅ **Implemented** | Extend `LeavePolicy` with `isPaid`/`isNotPaid`, fix `updatePolicy` to allow full edits, assignment model (all/selected employees) | Small–medium, isolated | Admin settings screen: Leave Type CRUD form (name, isPaid/isNotPaid toggles, assignment picker — all vs. select employees). No employee-facing change yet. |
| 2. Request/submission ✅ **Implemented** | `policyId` FK on `Leave`, pay-mode intent field, assignment gate on submit, approver dropdown restricted to admin + dept-SV pool | Medium | Employee leave request form: type dropdown limited to assigned types, Paid/Unpaid toggle (shown only when the type permits both), approver dropdown now scoped to dept. See `docs/CLIENT_LEAVE_CONTRACT.md`. |
| 3. Viewing ✅ **Implemented** | Department-scoped filters across list endpoints + dashboard pending-count fix | Small–medium | Mostly transparent — scoping is server-driven, so admin/SV list screens just show fewer rows. Sidebar badge count fix should be visible immediately. See `docs/CLIENT_LEAVE_CONTRACT.md`. |
| 4. Approval/Decline **+ Ledger writer** ✅ **Implemented** | Per-day proration against `LeaveDay`, concurrency-safe approval (atomic status-guarded update), two-step escalation re-scoped to new pool, centralized ledger-writing service used by every balance-affecting action | **Large — highest risk, core of the redo** | Approver dashboard: show computed paid/unpaid per-day breakdown before confirming, escalation dropdown reflecting new pool, and a friendly "already actioned by someone else" state for the concurrency guard. See `docs/CLIENT_LEAVE_CONTRACT.md`. |
| 5. Ledger (read-side) ✅ **Implemented** | Transaction history views, balance matrix, any remaining ledger completeness work | Medium | Balance screens: Credits/Used/Available three-column display, transaction history list/detail view. See `docs/CLIENT_LEAVE_CONTRACT.md`. |
| 6. Cancel Leave ⏸ **Paused — awaiting real-world signal** | Punch-detection/manual trigger (mechanism still deferred, §15), single-day reversal via `LeaveDay` + centralized ledger writer | Medium, depends on 4 & 5 | "Cancel Leave" action (if manual trigger is chosen) + balance display reflecting the reversal in real time. |

---

## 14a. Phase 1 — Implementation Notes

- **Schema**: `LeavePolicy.isPaid`/`isNotPaid`/`assignedToAll` added, all defaulted `true` — zero behavior change for existing policies on deploy. New `LeavePolicyAssignment` table (policyId + userId), only consulted when `assignedToAll = false`.
- **Migration**: `scripts/add-leave-policy-type-and-assignment.sql` — additive only, no `NOT NULL` column without a default, no backfill required (the `assignedToAll: true` default already preserves "any employee can use any leave type" for every existing policy, so the earlier plan's assignment auto-backfill from `LeaveBalance` turned out to be unnecessary — the default flag achieves the same safety more simply). Run manually per `memory/feedback_migration.md`.
- **Controller** (`leavePolicyController.js`): `createPolicy`/`updatePolicy` now accept `isPaid`, `isNotPaid`, `assignedToAll`, `employeeIds`; validates employeeIds belong to the caller's company; rejects a policy with both pay-modes disabled; assignment replacement is transactional. `getPolicies` returns full config + assigned user IDs. `getAvailablePolicies` (employee-facing, `/api/leaves/policies`) now filters to policies the employee is actually assigned to (`assignedToAll: true` OR has an assignment row) — the first real enforcement of assignment, ahead of Phase 2's submission gate.
- **Not touched**: `deletePolicy` guardrail (still deferred, §15 item 6), `Leave.policyId` FK (Phase 2), credit/accrual amounts (still deferred, §15 item 1).
- **Routes**: unchanged — same `GET/POST/PUT/DELETE /api/leave-policies` paths, request/response bodies extended only.

## 14b. Phase 2 — Implementation Notes

- **Schema**: `Leave.policyId` added (nullable FK to `LeavePolicy`). `leaveType` is kept unchanged as a legacy/display field — it already stored the policy id for every request submitted through `submitLeaveRequest`, so this is additive, not a replacement.
- **Migration**: `scripts/add-leave-policyid-fk.sql` — nullable column, no backfill risk. Two-pass backfill mirrors `_resolvePolicy()`'s existing id-first/name-fallback logic; any row with no resolvable policy is left `NULL` rather than guessed at.
- **Controller** (`leaveController.js`):
  - `submitLeaveRequest` now: (1) restricts the `approverId` a request can target to admins/superadmins (company-wide) or supervisors in the requester's own department — same rule enforced server-side as what the dropdown will show, not just a client-side filter; (2) gates submission on `LeavePolicy.assignedToAll` / `LeavePolicyAssignment`; (3) validates the submitted pay-mode intent (`isPaid`) against the policy's `isPaid`/`isNotPaid` permission flags; (4) writes `policyId` alongside the existing `leaveType`.
  - `getApprovers` applies the identical department-scoped rule, so the dropdown and the write-time validation can never disagree.
  - Requesters with no `departmentId` fall back to admins/superadmins only (no supervisor is in-scope without a department to match against).
- **Not touched**: per-day proration (Phase 4), `getPendingLeavesForApprover`/`getLeavesForApprover` visibility scoping (Phase 3), ledger writes (Phase 4/5).
- **Client contract**: `docs/CLIENT_LEAVE_CONTRACT.md` — new doc for the client team covering the request-form changes for this phase.

## 14c. Phase 3 — Implementation Notes

- **No schema changes** — pure query/visibility-scoping work.
- **New shared helper**: `leaveVisibilityWhere(companyId, role, departmentId)` in `src/utils/leaveUtils.js` — admins/superadmins get company-wide, supervisors get their own department only, a department-less supervisor sees nothing. Shared between `leaveController.js` and `dashboardController.js` so the rule is defined once and can't drift between the list views and the sidebar badge.
- **`getPendingLeavesForApprover`** and **`getLeavesForApprover`** — company-wide visibility for admin/superadmin unchanged; supervisors now only see leaves from employees in their own department (previously company-wide for all three management roles). The existing `canAct` flag is untouched — it still only turns `true` for the specifically named `approverId`/`secondaryApproverId`, since broadening *who can actually approve* is Phase 4's job, not this phase's. So a supervisor may now see a department colleague's leave they can't yet act on — expected and correct for this phase.
- **`getUserLeaves`** (employee's own leaves) — untouched, was already correctly scoped to self.
- **Dashboard sidebar fix** (`dashboardController.js`, `getSidebarStats`) — `pendingLeaveRequests` now: (1) includes `pending_secondary`, fixing the undercount noted in `OLD_LEAVE_MODULE.md` §9.7; (2) uses the same `leaveVisibilityWhere` scoping as the list endpoints, so the badge count and what the list screen actually shows can never disagree.
- **Client contract**: `docs/CLIENT_LEAVE_CONTRACT.md` updated with a Phase 3 section — mostly no-op for the client (server just returns fewer rows to supervisors), called out mainly so nobody mistakes the drop in visible rows for a bug.

## 14d. Phase 4 — Implementation Notes

- **Schema**: `LeaveDay` table added (one row per deductible day: `leaveId`, `date`, `isPaid`, `hours`) per the child-table decision. Purely additive — `scripts/add-leave-day-table.sql`. An optional Node backfill (`scripts/backfill-leave-days-legacy.js`, `--apply` to write) generates uniform `LeaveDay` rows for historical approved leaves using the real `calcDailyHours()`; not required for new approvals to work, since it only affects historical reporting.
- **Single source of truth for day math**: `leaveUtils.calcDailyHours()` now does the actual day-walk (weekends/holidays/shift-awareness, unchanged rules); `calcRequestedHours()` is now just `sum(calcDailyHours())`. No behavior change to existing totals — this refactor exists so the new per-day proration and the existing total-hours display can never compute a different number for the same leave.
- **New service**: `src/services/Leave/leaveApprovalService.js` — the centralized ledger writer.
  - `computeProration(dailyHours, availableBalance, negativeAllowed)` — pure function, walks days in order, marks each paid until balance runs out, then the rest auto-fall to unpaid. `negativeAllowed` makes every day paid unconditionally (unchanged semantics from the old `_deductBalance`).
  - `applyLeaveApproval(leave, policy, approverId, note)` — if the employee's stated intent was unpaid, writes `LeaveDay` rows only, no balance/ledger touch at all (the deliberate-unpaid choice from §5 — "it's their call"). If paid, runs balance upsert + `LeaveDay` creation + `LeaveBalance` decrement + one consolidated `deduction` `LeaveTransaction` **in a single `prisma.$transaction`** — this is what closes `OLD_LEAVE_MODULE.md` §9.4 (ledger writes can no longer happen without a balance write or vice versa).
  - `previewLeaveApproval(leave, policy)` — read-only, same math, no writes. Backs the new preview endpoint.
- **Controller** (`leaveController.js`):
  - `_isEligibleApprover(role, actingDepartmentId, requesterDepartmentId)` — the broadened pool: any admin/superadmin, or any supervisor whose department matches the requester's. Applied uniformly to `approveLeave`, `rejectLeave`, and the new `previewApproval` — being the specifically named `approverId`/`secondaryApproverId` is no longer required to act, matching §8 ("assigned" is a default/notification target, not exclusive).
  - **Concurrency guard**: both the escalation step and the final-approval step now claim the leave via `prisma.leave.updateMany({ where: { id, status: expectedStage }, ... })` before doing anything else — if `count === 0`, someone else already acted, and the request gets a `409` instead of double-processing. If `applyLeaveApproval` throws after the claim succeeds, the status is reverted back to its pre-claim stage (compensating action) rather than leaving an `approved` leave with no ledger effect.
  - `rejectLeave` uses the same broadened eligibility + atomic claim, though it doesn't touch balance/ledger (rejection never did).
  - `_resolvePolicy(leave, companyId)` now prefers the Phase 2 `policyId` FK first, falling back to the legacy `leaveType` id/name resolution — signature changed (was `_resolvePolicy(leaveType, companyId)`), only call site was inside this file.
  - New `previewApproval` (`GET /api/leaves/:id/preview`) — same eligibility gate as approve/reject, returns the computed paid/unpaid day breakdown without writing anything, for the approver's dashboard to render before they confirm.
- **Not touched**: `LeaveDay`/ledger read-side surfaces (`listBalances`, transaction history) — still Phase 5. Punch-vs-leave conflict / Cancel Leave — still Phase 6.
- **Client contract**: `docs/CLIENT_LEAVE_CONTRACT.md` updated with the Phase 4 section — new preview call before the Approve button, the broadened approve/reject pool, and the new `409` "already actioned" case to handle.
- **Verified** via `scripts/verify-phase4-leave-approval.js` (throwaway scratch data, self-cleaning): partial proration (8h paid / 8h auto-unpaid against a 12h balance, one consolidated `-8h` ledger entry, balance landed at exactly 4h), deliberate-unpaid choice (balance untouched, zero ledger entries), and the concurrency guard (only 1 of 2 simultaneous claims succeeds) all passed.

## 14e. Phase 5 — Implementation Notes

- **No schema changes** — pure read-side work on top of Phase 4's ledger writes.
- **Three-column identity**: `available` = `LeaveBalance.balanceHours` (kept in sync going forward by Phase 4's atomic writer), `used` = sum of `deduction` transactions pulled straight from the ledger (not a separately-tracked field — this is what actually fixes the "Used not tallying" issue flagged earlier, since it's derived fresh from the ledger every time rather than trusted from a value that could drift), and `credits` = `available + used`, **derived, never independently summed**. This means Credits − Used = Available by construction — the three numbers can't disagree with each other, though `available` itself can still reflect the one known pre-Phase-6 gap (see caveat below).
- **`leaveController.listBalances`** (`GET /api/leaves/balances`) — each policy entry now returns `credits`/`used`/`available` alongside the legacy `balanceHours`/`usedHours` (kept, equal to `available`/`used`, for backward compatibility) plus `isPaid`/`isNotPaid`/`policyId`.
- **`leaveBalanceController.listMatrix`** (`GET /leave-balances/matrix`) — **response shape changed**: each cell in the `balances` object is now `{ credits, used, available }` instead of a flat number. This is a genuine breaking change to this endpoint's shape, called out explicitly in the client contract since the admin balance matrix UI hasn't been built against the old shape yet.
- **New endpoint**: `GET /api/leaves/:id/days` — returns the `LeaveDay` breakdown for a leave post-decision (complements Phase 4's `previewApproval`, which is the pre-decision version). Visible to the leave's own requester, or management under the same department-scoping rule as `leaveVisibilityWhere` (admin company-wide, supervisor own-department only).
- **Incidental bug fix**: `leaveBalanceController.adjustBalance` computed a floored `balanceAfter` for the ledger record but used a raw `increment` on the actual `LeaveBalance` row — a large negative adjustment could push the real stored balance negative while the ledger claimed it floored at 0. Fixed to apply the same floor to the actual stored value, so the ledger and the balance can't disagree. In scope for this phase as "ledger completeness" work.
- **Known caveat, not fixed this phase**: `available` (`LeaveBalance.balanceHours`) can still disagree with a pure ledger-sum reconstruction for leaves affected by the still-open `resolveConflict` gap (`cutoffPeriodController.js`, punch-wins reversal bumps balance directly with no ledger entry) — that's Phase 6's job, tracked in `OLD_LEAVE_MODULE.md` §9.4 and §14 of this doc. Not attempting a workaround here since Phase 6 fixes the root cause directly.
- **Client contract**: `docs/CLIENT_LEAVE_CONTRACT.md` updated — new three-column fields on balances, the breaking matrix cell shape change, and the new day-breakdown endpoint.

## 14f. Post-Phase-5 addition — Archived Leave Type

Not one of the original 6 phases — added afterward in response to a real production incident (see below), extending Phase 1's Leave Type management.

**Why:** `deletePolicy` correctly refuses to hard-delete a Leave Type that has real history (`Leave`/`LeaveBalance`/`LeaveTransaction`/`LeavePolicyAssignment` rows referencing it — the `LEAVE_POLICY_IN_USE` guard added alongside `docs/ERROR_CODES.md`). That's correct behavior — deleting it would orphan approved leave requests and corrupt the ledger — but it left no way to actually retire a leave type that's genuinely no longer wanted while keeping its history intact. The `assignedToAll: false` + zero-assignment workaround suggested in the moment was a hack (indistinguishable from "not configured yet") — this replaces it with a real, explicit field.

- **Schema**: `LeavePolicy.isArchived` (`Boolean @default(false)`) + `archivedAt` (`DateTime?`) — additive, safe default, zero behavior change on deploy. `scripts/add-leave-policy-archive-fields.sql`.
- **`updatePolicy`** now accepts `isArchived` in the update body — no new endpoint. `archivedAt` is only touched on an actual state transition (set on archive, cleared on unarchive), not on every save while already in that state.
- **`getPolicies`** (admin list) excludes archived types by default; `?includeArchived=true` to see them.
- **`getAvailablePolicies`** (employee-facing `/api/leaves/policies`) always excludes archived types, unconditionally — archiving overrides assignment entirely.
- **`submitLeaveRequest`** defensively rejects submission against an archived policy even if the client has a stale cached list.
- **`deletePolicy`**'s `409` message updated to point at archiving instead of the old assignment-based workaround.
- **Unchanged, deliberately**: balance/matrix/ledger views still show archived types' historical data — archiving stops *future* use, it doesn't hide the past.
- **Client contract**: `docs/CLIENT_LEAVE_CONTRACT.md` updated with an Archive section.

## 14g. Post-Phase-5 addition — Ledger View Placement (client)

Not a backend change — no code/schema touched here, this is a client-side scoping decision, logged because it reverses an earlier "out of scope" call.

**What happened:** an admin added credit via `POST /api/leave-balances/adjust`. The write was correct — `LeaveTransaction` got a new `adjustment` row exactly as designed (§14e) — but the Balance Matrix screen the admin was looking at only renders `credits`/`used`/`available` numbers, never a transaction list, so it looked like "the ledger is empty." Root cause: the frontend's own gap assessment (`DISCREPANCY_LEAVE_MODULE.md`, Phase 5) had marked `GET /api/leave-balances/transactions` as *"never called, no ledger view exists... likely out of scope."* It's no longer out of scope — this incident is exactly the reason to build it.

**Placement decision**: the full transaction-history/ledger view belongs on the **Settings side** (`CompanyConfigurations.jsx` → the Balance Matrix / Adjust Credits area), not the Approver side — that's where credits get changed, so that's where an admin needs to audit what happened. Concretely: a cell/row drill-down calling `GET /leave-balances/transactions?userId=X&policyId=Y`.

The **Approver side** (`EmployeesLeaveRequests.jsx`) doesn't need the general ledger — it already gets the specific transaction tied to the leave request being reviewed inline (`leaveController._attachTransactions`) plus the Phase 4 preview breakdown. That's a different, narrower need ("what will/did happen to *this* request") than the Settings-side ledger ("full audit history for this person/policy").

## 15. Deferred / Open Discussion Items

To revisit once these fundamentals are implemented or before implementation, per your instruction:

1. **Credits & accrual mechanics** — how `Credits` grows over time (flat grant vs. monthly/yearly accrual survives?), and how to handle the fact that the current leave year already has accrued values mid-year (migration complexity).
2. **Cancel Leave UX (Phase 6 — intentionally paused)** — automatic reversal on punch detection vs. manual "Cancel Leave" button; per-day-only reversal vs. whole-leave cancellation; who can trigger it. **Deliberately held open**: Phases 1–5 are backend-complete (Phase 4 verified via script) but not yet built/used in the client UI. Decision was made to build and run the UI for Phases 1–5 first and let real conflict patterns inform this design, rather than guess now — this is exactly the kind of decision real usage should drive. Revisit once there's usage signal.
3. **`affectedShifts` / schedule impact** — keep, drop, or redesign (today it's write-only, never consumed).
4. **Payroll/cutoff integration** — beyond punch-wins, how leave hours feed into payroll gross pay and OT-basis exclusion (today payroll has its own separate, inconsistent hour calc — `OLD_LEAVE_MODULE.md` §9.2).
5. **`LeaveType.defaultValue`** — exact meaning/behavior deferred from §2.
6. **`deleteLeave` guardrails**, **policy/type update completeness**, **adjustment ceilings** — carried over from Old Module gaps, not yet discussed.

---

## Related docs
- `docs/OLD_LEAVE_MODULE.md` — current/as-built reference this design supersedes
- `docs/CUTOFF_PERIOD_MODULE.md`
- `docs/TIMEKEEPING_GLOSSARY.md`
- `docs/PAYROLL_SYSTEM.md`
