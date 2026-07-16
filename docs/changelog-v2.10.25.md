# Changelog — v2.10.25

> Leave Module continuation: decision audit trail, real pay-outcome persistence, a shift-worker
> 0h computation bug fix, requester self-cancel (pre-approval), and a unified Leave Ledger built
> on the existing `LeaveTransaction` table. `docs/UPDATED_LEAVE_MODULE.md` renamed to
> `docs/LEAVE_MODULE.md` — now the current-system reference, not a draft redo proposal.

---

## New Feature

### Decision Audit Trail — `escalatedBy` / `decidedBy`

**Files:** `src/controllers/Features/leaveController.js`; `src/prisma/schema.prisma`

**Problem:** `Leave.approverId`/`secondaryApproverId` record who a request was assigned or
escalated *to* — not who actually acted, since any eligible admin or the requester's department
supervisor can act on a request regardless of who it's named to (Phase 4 broadened pool).

**Fix:** Two new nullable, FK-backed, indexed columns on `Leave`:
- `escalatedByUserId` — the first-stage reviewer who chose to escalate. Null if never escalated.
- `decidedByUserId` — whoever made the final approve/reject call.

Written in `approveLeave`'s escalate branch and both `approveLeave`'s final claim and
`rejectLeave`'s claim. All three leave-list read paths now include and format `escalatedBy`/
`decidedBy` alongside the existing `approver` block.

**Migration:** `scripts/add-leave-decided-by-fields.sql` — additive, nullable, no backfill (actor
on already-decided leaves isn't recoverable).

---

## Bug Fix

### Real Pay Outcome Never Persisted on `Leave`

**Files:** `src/services/Leave/leaveApprovalService.js`; `src/prisma/schema.prisma`

**Problem:** `Leave.isPaid` only ever reflected the employee's submitted intent, never the real
per-day proration outcome computed at approval. A request submitted as paid could come back
fully or partially unpaid if the balance ran out, but the top-level record — and anything reading
it (the client's Pay Type badge) — kept showing the submitted intent. Confirmed via a real case:
a Maternity Leave request with a depleted balance, approved fully unpaid, day breakdown correct,
top-level badge still read "Paid Leave."

**Fix:** `Leave.actualPaidHours`/`actualUnpaidHours` (`Decimal? @db.Decimal(6,2)`, null until
decided). Both branches of `applyLeaveApproval` now write these alongside their existing writes.

**Migration:** `scripts/add-leave-actual-hours-fields.sql` — additive, nullable, with a one-time
backfill (`SUM(hours) FILTER (WHERE isPaid)` per `leaveId`) so already-approved leaves are
corrected immediately, since the true split already exists in `LeaveDay`.

---

## Bug Fix

### `calcDailyHours()` — 0h for Shift Workers on an Unplotted Schedule

**File:** `src/utils/leaveUtils.js`

**Problem:** A genuine shift worker requesting leave for dates where their schedule hadn't been
plotted yet computed 0h across the entire range — both the total-hours display and the approver's
paid/unpaid day breakdown. Confirmed real case: a Maternity Leave request, Aug 3–7, priced out at
0h entirely.

**Root cause:** `isShiftWorker`'s fallback query had no date filter — it matched *any* `UserShift`
ever (past or future), which resolves `true` for a real shift worker even when nothing is plotted
in the requested range. The per-day loop then only counts in-range scheduled days, so an unplotted
range costs 0h across the board.

**Fix:** Removed the date-unfiltered fallback query. `isShiftWorker` is now simply
`shiftHoursMap.size > 0` — whether anything is actually plotted in the requested range. When
nothing's plotted, every eligible day now falls to the existing salaried-style fallback
(`Company.defaultShiftHours`), same as SV/manager/salaried staff already got.

**Design considered and rejected:** collecting actual submitted start/end times for unplotted
days (capped at `defaultShiftHours`) was discussed as a more precise alternative, but rejected —
today's leave model is whole-day only ("Punch Wins" assumes a day is either fully leave or fully
worked), and a time-ranged partial leave would need genuine intra-day leave/shift coexistence that
doesn't exist anywhere else in this module.

**Not corrected retroactively** — the one confirmed historical case is handled by manual
reject-and-resubmit, not a backfill script.

---

## New Feature

### Cancel Leave — Requester Self-Cancel (Pre-Approval Only)

**Files:** `src/controllers/Features/leaveController.js`; `src/routes/Features/leaveRoutes.js`

**Problem:** No employee-facing way to withdraw a submitted leave request existed. The only
existing delete path (`deleteLeave`) is admin/supervisor/superadmin-only, matches only the
specifically-named `approverId` (not the broadened Phase 4 pool), and hard-deletes the row
unconditionally regardless of status — a real integrity risk, left untouched here.

**Fix:** New `PUT /api/leaves/:id/cancel`. Only the requester may call it, only while `status` is
`pending` or `pending_secondary`. Uses the same atomic-claim pattern as approve/reject (`409` if
raced by an approver acting first). No balance/ledger writes — deduction only happens at
approval, so a still-pending leave has no balance footprint to reverse. Notifies the same eligible
management pool as submit (`LEAVE_REQUEST_CANCELLED`).

No new column needed — only the requester can ever cancel, so there's no "who acted" ambiguity
the way approval had.

---

## New Feature

### Unified Leave Ledger

**Files:** `src/prisma/schema.prisma`; `src/controllers/Features/leaveController.js`;
`src/services/Leave/leaveApprovalService.js`; `src/controllers/Features/leaveBalanceController.js`;
`src/utils/leaveUtils.js`

**What:** `LeaveTransaction` — previously a balance-movement-only ledger (`accrual`/`deduction`/
`adjustment`) — now also carries the leave's full lifecycle: `submitted`, `escalated`, `approved`,
`rejected`, `cancelled`. One shared table gives a single chronological feed (`ORDER BY createdAt`)
instead of requiring the client to merge two separate tables.

**Schema:** `LeaveTransactionType` gains the four new values. `hours`/`balanceBefore`/
`balanceAfter` loosened from required to nullable — the new lifecycle types have no balance to
report. Purely additive/loosening, safe for a live table with existing rows.

**Write points:** one row per lifecycle event in `submitLeaveRequest`, `approveLeave` (escalate
branch), `applyLeaveApproval` (both branches, inside its existing `$transaction`), `rejectLeave`,
and `cancelLeave`. A paid approval produces both its existing `deduction` row and a new `approved`
row; every decision gets exactly one lifecycle marker regardless of pay outcome.

**Read side** (`GET /api/leave-balances/transactions`, existing endpoint, no new route):
- Null-safe number formatting (previously `Number(t.hours)` would silently turn `null` into `0`).
- New company/department-wide mode: a management caller with no `?userId=` now gets the same
  visibility-scoped feed as everywhere else in this module (`leaveVisibilityWhere`), instead of
  falling back to just their own records — this is what makes a genuine cross-employee "Leave
  Ledger" screen possible. The existing `?userId=X&policyId=Y` single-employee drill-down
  (Balance Matrix cell click) is unchanged.
- New optional `?leaveId=` filter, for a per-leave detail timeline.
- New `user` field per row (the leave requester), alongside the existing `performedBy`.

`leaveVisibilityWhere` (`leaveUtils.js`) gained an optional 4th parameter (relation field name,
default `"User"`) so it can also scope `LeaveTransaction` queries, whose relation to `User` is
named lowercase `user`. Existing call sites unaffected.

**Not built:** historical backfill — existing leaves have no lifecycle rows before this ships;
the feed starts from deploy forward.

**Migration:** `scripts/extend-leave-transaction-ledger.sql`.

---

## Docs

- `docs/UPDATED_LEAVE_MODULE.md` renamed to **`docs/LEAVE_MODULE.md`** — status updated from
  "Draft — Target Design" to "Current system," reflecting that Phases 1–5 plus all post-Phase-5
  additions are implemented. All cross-references updated (`CLIENT_LEAVE_CONTRACT.md`,
  `DISCREPANCY_LEAVE_MODULE.md`, `ERROR_CODES.md`, and code comments in `leaveController.js`,
  `leaveApprovalService.js`, and four scripts).
- `docs/CLIENT_LEAVE_CONTRACT.md` — new sections for Cancel Leave and the unified Leave Ledger;
  corrected the `requestedHours`/preview-hours note for the shift-worker 0h fix.

---

## Files Changed

| File | Change |
|---|---|
| `src/prisma/schema.prisma` | `Leave.escalatedByUserId`/`decidedByUserId`/`actualPaidHours`/`actualUnpaidHours`; `LeaveTransactionType` +4 values; `LeaveTransaction.hours`/`balanceBefore`/`balanceAfter` nullable |
| `src/utils/leaveUtils.js` | `calcDailyHours` shift-worker 0h fix; `leaveVisibilityWhere` gains relation-field parameter |
| `src/controllers/Features/leaveController.js` | `escalatedByUserId`/`decidedByUserId` writes; new `cancelLeave`; ledger writes for submit/escalate/reject/cancel |
| `src/services/Leave/leaveApprovalService.js` | `actualPaidHours`/`actualUnpaidHours` writes; ledger writes for `approved` |
| `src/controllers/Features/leaveBalanceController.js` | `getTransactions` — null-safe formatting, company/department-wide mode, `leaveId` filter, `user` field |
| `src/routes/Features/leaveRoutes.js` | New `PUT /:id/cancel` |
| `scripts/add-leave-decided-by-fields.sql` | New migration |
| `scripts/add-leave-actual-hours-fields.sql` | New migration + backfill |
| `scripts/extend-leave-transaction-ledger.sql` | New migration |
| `docs/LEAVE_MODULE.md` | Renamed from `UPDATED_LEAVE_MODULE.md`; §14h–§14l added; status rewritten |
| `docs/CLIENT_LEAVE_CONTRACT.md` | Cancel Leave + Leave Ledger sections added |

---

## Open Items (Not in This Release)

- Punch-wins conflict resolution (`bncCutoffStrategy.js`/`daycareCutoffStrategy.js`) refunds a
  hard-coded 8h with no ledger entry when a punch overrides an approved leave — belongs to a
  Cutoff/TimeLog discussion, not this release.
- Phase 6 post-approval Cancel Leave (reversing an already-approved, already-deducted leave) —
  still paused pending real usage signal.
- Leave Accrual mechanics (`§15` item 1) — next module discussion.
- No historical backfill for the new Leave Ledger lifecycle events.
