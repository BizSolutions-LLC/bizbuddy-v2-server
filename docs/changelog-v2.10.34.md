# Changelog — v2.10.34

> **BB-066** — the admin "Employee Leave Requests" page needed a cancellation timestamp, which
> surfaced a real bug underneath: the punch-wins conflict-resolution path (`resolveConflict`, both
> cutoff strategies) cancelled an already-approved, already-deducted leave and credited back a
> hardcoded flat 8h with no ledger entry — and the credit lookup itself was broken (compared a
> policy-id cuid against a human label, so it could never match), meaning the credit silently
> never landed at all, for any company. Fixed to credit the real amount and log it, and to surface
> `cancelledAt` on `GET /api/leaves`. One historical leave found uncredited and backfilled.
> Also fixes 3 `NotificationCode` enum values `leaveController.js` had always referenced but that
> were never added — which, once corrected out-of-band on the live DB ahead of this commit,
> caused a separate deploy to crash trying to drop them back out. This commit closes that drift.

---

## Schema

### BB-066 (follow-up) — Missing `NotificationCode` Enum Values

**Why:** `leaveController.js` has always referenced three notification codes —
`LEAVE_PENDING_SECONDARY_APPROVAL` (escalation to a second approver), `LEAVE_REQUEST_FIRST_APPROVED`
(first-stage approval, awaiting second), `LEAVE_REQUEST_CANCELLED` (employee self-cancel) — that
were never added to the `NotificationCode` enum. Every one of these notifications has been
silently failing since introduced: `Prisma​ClientValidationError` ("Invalid value for argument
`notificationCode`"), caught by the existing `try/catch` around each `createNotification` call, so
the leave action itself always succeeded — only the notification was ever lost.

**Added** to the enum: `LEAVE_PENDING_SECONDARY_APPROVAL`, `LEAVE_REQUEST_FIRST_APPROVED`,
`LEAVE_REQUEST_CANCELLED`. No application code changes needed — all three call sites already used
the correct intended string values.

**Deploy incident:** these values were applied directly to the live DB via raw SQL
(`scripts/add-leave-notification-codes.sql`, `ALTER TYPE ... ADD VALUE`) ahead of this
`schema.prisma` commit landing, to unblock manual testing. In the gap, a different deploy ran
`prisma db push --accept-data-loss` against the not-yet-updated `schema.prisma`, saw the live DB
had 3 enum values it didn't know about, and tried to drop them back out — which failed loudly
(`invalid input value for enum "NotificationCode_new": "LEAVE_REQUEST_CANCELLED"`) because live
`NotificationLog` rows already used that value (real employees had already self-cancelled leaves
by then). This commit lands the matching schema so `db push` stops seeing drift.

---

## Bug Fix

### BB-066 — Punch-Wins Conflict-Resolution Leave Cancellation: Silent No-Op Credit + No Ledger Entry

**The bug:** `resolveConflict` (`daycareCutoffStrategy.js`, `bncCutoffStrategy.js`) cancels an
already-approved, already-deducted leave when a punch is honored over it instead — reachable via
an admin manually resolving a conflict, or automatically via BB-051's `leaveConflictAutoRevert`
setting with zero human review. It credited back a hardcoded flat 8h regardless of the real
deducted amount, and wrote no `LeaveTransaction` ledger entry at all.

**Root cause turned out worse than "wrong amount":** the credit lookup was
`prisma.leavePolicy.findFirst({ where: { companyId, leaveType: leave.leaveType } })`. `Leave.leaveType`
stores the policy's `cuid` (`leaveController.js:283`); `LeavePolicy.leaveType` stores a
human-entered label (e.g. `"Sick Leave"`). These can never match — `leavePolicy` was always `null`,
so the credit block's `if (leavePolicy)` was always false. The flat-8h credit didn't just apply
the wrong number — it silently credited **nothing, ever, for any company**.

**Fixed:** new shared helper `src/services/Cutoff/leaveConflictCredit.js`
(`creditLeaveOnConflict`), used by both `daycareCutoffStrategy.js` and `bncCutoffStrategy.js` —
reads the real deducted hours back off the original `deduction` `LeaveTransaction` (and reads
`policyId` straight off that row, removing the broken lookup entirely instead of fixing it in
place), credits it via the same `upsert` pattern as `leaveBalanceController.adjustBalance` (not
raw `increment` — avoids reintroducing a previously-fixed balance/ledger drift bug), and writes a
`cancelled` lifecycle entry (`hours: null`, matching `cancelLeave`'s existing convention) plus a
separate `adjustment` entry when there's a real credit. Runs inside one `prisma.$transaction`,
replacing the old two separate best-effort calls; the leave-status flip uses an atomic
`updateMany` claim (same idempotency pattern as `cancelLeave`) to guard against double-crediting
from a race (e.g. overlapping punch conflicts on a multi-day leave).

### `GET /api/leaves` — Cancellation Timestamp

`_attachTransactions` (`leaveController.js`) now also surfaces the `cancelled` ledger entry
(previously only `deduction` was attached), adding `cancelledAt` (ISO string) and
`cancellation: { performedBy, note }` to every leave across `getUserLeaves`,
`getPendingLeavesForApprover`, and `getLeavesForApprover`. `performedBy` is `null` when
auto-reverted via BB-051 (no human acted), the acting admin for a manual conflict resolution, or
the employee themselves for a self-cancel.

**Client-side impact:** yes — additive-only fields, safe to deploy ahead of client work. Client
can add a conditional "Cancelled on" row keyed off `cancelledAt`. Pre-fix historical
conflict-cancellations have no `cancelled` ledger entry to read from, so `cancelledAt` stays `null`
for those — not retroactively fillable without a real recorded timestamp.

---

## Data Fix

### BB-066 — Albert Dalere's Conflict-Cancelled Sick Leave Never Credited Back

Diagnostic (`scripts/check-bb066-conflict-cancel-balance-gaps.js`, local-only) scanning for
`status: "cancelled"` leaves with a `deduction` transaction but no `cancelled` transaction found 2
candidates. A follow-up trace (`scripts/check-bb066-albert-dalere-credit-trace.js`, local-only)
against the live balance confirmed one — a 40h Sick Leave deducted on 2026-07-10, cancelled via
the pre-fix conflict-resolution path — was still fully uncredited: the live
`LeaveBalance.balanceHours` (12.5h) exactly matched the post-deduction ledger value, proving
nothing had corrected it since. The second candidate (an 8h leave) wasn't chased further; per the
root-cause finding above, its credit almost certainly never landed either, but wasn't separately
confirmed against live data.

**Backfilled** (`scripts/fix-bb066-albert-dalere-leave-balance-credit.js`, local-only; run and
confirmed): credited the real 40h back via an `adjustment` transaction, restoring the balance to
52.5h. Guarded against double-running (aborts if an `adjustment` transaction already exists for
the leave, or if the live balance doesn't match the expected pre-correction value).

**Follow-up, not yet run:** a new 4-day Sick Leave (Jul 29–31 + Aug 3, 2026, 32h flat) is being
filed for the same employee against the corrected balance
(`scripts/fix-bb066-albert-dalere-file-jul29-31-aug3-leave.sql`, local-only) — deliberately
deferred until after this deploy lands cleanly.

**Not backfilled:** the `cancelled` lifecycle ledger entry for this leave — would need a
fabricated `createdAt`, since the real cancellation moment was never recorded anywhere. Balance
correction was the priority; `cancelledAt` continues to show `null` for this specific historical
record.

---

## Investigation — Not Yet Resolved

### Dev-Environment Leave-Ledger Endpoint Reportedly Returning Nothing

Raised during manual testing — not yet root-caused. Unclear whether this is a real endpoint issue
or a data/environment difference (dev DB may simply not have ledger rows for the accounts being
checked). No investigation performed yet.

### Fabricated-Looking Ledger Note on a Live (Prod) `adjustment` Transaction

One employee's ledger showed an `adjustment` entry with a note reading like a literal doc
reference (`"...Cancel Leave yet built, see docs/UPDATED_LEAVE_MODULE.md §15 item 2"`) that
doesn't match any string written by current code — `leaveBalanceController.adjustBalance` (the
only endpoint that writes `type: "adjustment"` from an admin action) doesn't even accept a `note`
parameter. Most likely a manual DB insert (Prisma Studio, an ad-hoc script, or raw SQL) made
outside the normal application flow at some point. Not chased further — flagged as a possible
production data-integrity concern worth a second look.

---

## Files Changed

| File | Change |
|---|---|
| `src/prisma/schema.prisma` | Added `LEAVE_PENDING_SECONDARY_APPROVAL`, `LEAVE_REQUEST_FIRST_APPROVED`, `LEAVE_REQUEST_CANCELLED` to `NotificationCode` enum |
| `src/services/Cutoff/leaveConflictCredit.js` | New — shared `creditLeaveOnConflict` helper, used by both cutoff strategies |
| `src/services/Cutoff/daycareCutoffStrategy.js` | `resolveConflict`'s leave-cancel block now calls the shared helper inside a `prisma.$transaction`, replacing the old flat-8h/no-ledger/non-atomic block |
| `src/services/Cutoff/bncCutoffStrategy.js` | Same change as above |
| `src/controllers/Features/leaveController.js` | `_attachTransactions` now also fetches `cancelled` transactions, adding `cancelledAt`/`cancellation` to every leave across all 3 response endpoints |
| `docs/CLIENT_LEAVE_CONTRACT.md` | Updated the "flat 8h, no ledger entry" passage to describe the fixed behavior |
| `docs/LEAVE_MODULE.md` | Same update, 2 locations (§10 Ledger, §14e caveat) |
| `scripts/add-leave-notification-codes.sql` | New, local-only — raw SQL for the 3 enum values; already applied to the live DB |
| `scripts/check-bb066-conflict-cancel-balance-gaps.js` | New, local-only, read-only — scans for pre-fix conflict-cancelled leaves missing a ledger entry |
| `scripts/check-bb066-albert-dalere-credit-trace.js` | New, local-only, read-only — traced why one specific leave's credit never landed; confirmed the root cause against live data |
| `scripts/fix-bb066-albert-dalere-leave-balance-credit.js` | New, local-only, write — one-record balance backfill; run and confirmed |
| `scripts/fix-bb066-albert-dalere-shorten-adjustment-note.js` | New, local-only, write — shortened the backfill transaction's note text; run |
| `scripts/fix-bb066-albert-dalere-file-jul29-31-aug3-leave.sql` | New, local-only, write — files the follow-up 4-day leave; written, not yet run |
