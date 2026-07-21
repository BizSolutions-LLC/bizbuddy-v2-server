# Changelog — v2.10.28

> BB-050: leave approval was failing for every request, paid or unpaid, single- or multi-shift —
> a missing `LeaveTransactionType` enum value, not the multi-shift-specific bug originally
> reported. Also investigated a separate, unrelated 500 on leave submission — client-side fix only,
> no server changes.

---

## Bug Fix

### BB-050 — Leave Approval Fails ("Failed to finalize leave approval")

**Files:** `src/prisma/schema.prisma`, `scripts/extend-leave-transaction-ledger.sql`

**Problem:** Approving a leave request returned a 500 with a generic "Failed to finalize leave
approval. Please try again." toast. Originally reported as specific to a multi-shift day (two
`UserShift` rows on the same date), but investigation and two live repros showed it fails on
**every** final approval — paid or unpaid, single- or multi-shift alike. The multi-shift framing in
the original report didn't hold up; single-shift approvals had never actually been re-verified
since the bug was introduced.

**Root cause:** `applyLeaveApproval()` (`src/services/Leave/leaveApprovalService.js`) writes a
`LeaveTransaction` lifecycle-marker row (`type: "approved"`) on every successful approval, in both
the paid and unpaid branches — added alongside the rest of the Leave Ledger's lifecycle events
(`submitted`/`escalated`/`rejected`/`cancelled`) in v2.10.25. `approved` was never added to the
`LeaveTransactionType` enum itself (`scripts/extend-leave-transaction-ledger.sql` added the other
four, not this one) — a straightforward oversight. Prisma validates enum arguments client-side
before touching the DB, so the write threw a `PrismaClientValidationError` unconditionally, was
caught by `approveLeave`'s generic error handler (`leaveController.js`), and surfaced only as the
generic toast — the real error was never returned to the client, only `console.error`'d.

**Fix:** Purely additive schema change — no application code changes needed, since
`applyLeaveApproval()` already correctly intended to write `"approved"`. Landed via PR #82
(`fix/add-approve-enum`, `92db608`/`bac8eb3`), merged directly to `master` ahead of this release
branch:
- `LeaveTransactionType` enum gains `approved` (`schema.prisma`).
- `scripts/extend-leave-transaction-ledger.sql` — extended in place with
  `ALTER TYPE "LeaveTransactionType" ADD VALUE IF NOT EXISTS 'approved';`, alongside the four
  lifecycle values it already added in v2.10.25.

**Verified:** confirmed against two independent live repros
(`PrismaClientValidationError: Invalid value for argument 'type'` at
`leaveApprovalService.js:203`, via `approveLeave` → `applyLeaveApproval`); retested successfully
after PR #82 was applied.

---

## Investigated — No Server Changes

### Leave Submission — `affectedShiftIds` Containing `null` Crashes Submit

**Reported:** `POST /api/leaves/submit` returning 500 during BB-050 verification.

**Investigation:** `submitLeaveRequest()` (`leaveController.js`) only checks that
`affectedShiftIds` is a non-empty array before querying
`prisma.userShift.findMany({ where: { id: { in: affectedShiftIds }, ... } })`. The request body
had `affectedShiftIds: [null]` — passes the non-empty-array check, then Prisma rejects `in: [null]`
client-side (`Expected ListStringFieldRefInput, provided (Null)`).

**Root cause (client-side):** a shift-picker UI flow is submitting an unselected/placeholder entry
as `null` in the array instead of omitting it or filtering nulls before building the request
payload.

**Fix:** client repo only — filter `affectedShiftIds` to real shift ID strings before sending, and
omit the field entirely (or send `[]`) if nothing remains selected. No server repo changes made;
left for the client team as requested.

---

## Files Changed

| File | Change |
|---|---|
| `src/prisma/schema.prisma` | BB-050: `LeaveTransactionType` gains `approved` (via PR #82) |
| `scripts/extend-leave-transaction-ledger.sql` | BB-050: extended with `ADD VALUE IF NOT EXISTS 'approved'` (via PR #82) |

---

## Open Items (Not in This Release)

- `affectedShiftIds: [null]` on `POST /api/leaves/submit` — fix pending in the client repo; no
  server-side defensive filtering added (deliberately deferred, not forgotten).
- `approveLeave`'s catch block still only logs the real error and returns a generic message to the
  client — flagged during BB-050 investigation as a follow-up worth considering separately, not
  addressed here.
