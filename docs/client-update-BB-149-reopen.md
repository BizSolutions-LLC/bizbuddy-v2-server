# Client update — BB-149 follow-up: Reopen a processed cutoff

**Server:** next push (version chosen at `/push`). **Web:** cutoff page (button, dialog, badge/history) + payroll export note. **Mobile:** none. **Status:** built 2026-11-25. **Database change:** one new table. Order: user runs `scripts/add-cutoff-status-events-bb149.sql` → `prisma generate` → deploy. Until then the reopen endpoint answers 503 `REOPEN_NOT_READY`; everything else works as before.

## Why
"Processed" was final: no status change allowed, so a cutoff that needed a correction after processing could only be reopened by a database script (PadPro Nov 11–24, 2026-11-25). Admins (and B. Buddy support) can now reopen it themselves, with a reason that is kept.

## Endpoint
`POST /api/cutoff-periods/:id/reopen` — admin / superadmin (B. Buddy included).

Body:
```json
{ "reason": "Training day hours corrected (Nov 14)", "confirmPaid": false }
```

| Response | When | What to show |
|---|---|---|
| 200 | Reopened (processed → open) | Toast: `message`. Reload the cutoff. `data.reopen = { reason, paymentDateReached, paymentDate }` |
| 400 `REOPEN_REASON_REQUIRED` | reason missing / under 5 / over 500 characters | Field error |
| 400 `REOPEN_NOT_PROCESSED` | not processed (a **locked** cutoff opens with the normal `PATCH /:id/status`) | `message` |
| 409 `REOPEN_CONFIRM_PAID` | payment date reached (company zone) and `confirmPaid` not true | The warning dialog below; on confirm, send the same request with `confirmPaid: true` |
| 409 `REOPEN_STATUS_CHANGED` | someone changed it meanwhile | "Reload and try again" |
| 503 `REOPEN_NOT_READY` | database update not applied yet | `message` |

**What a reopen does:** status → open. Approvals keep their decisions (pending ones can be decided again; approved ones need Reset to change). Payroll export rows stay but are marked **outdated** until the cutoff is processed again, which rebuilds them. **No notification** to employees. Processing it again sends **"Payroll Updated"** instead of a second "Payroll Processed" (`payload.updated: true`).

## Suggested UI
1. **Button** "Reopen" on a **processed** cutoff, admins only (hide for supervisors).
2. **Dialog**: "Reopen this cutoff?" + required **Reason** (5–500) + note: "Approvals stay as they are. The payroll export will show as outdated until you process it again."
3. **Paid warning** (on 409 `REOPEN_CONFIRM_PAID`, or up front when `paymentDate` ≤ today): "This cutoff's payment date (Nov 27) has been reached, so it may already be paid. Changes after reopening can differ from what was paid." Buttons: Cancel / **Reopen anyway** (sends `confirmPaid: true`).
4. **Badge / history**:
   - `GET /api/cutoff-periods` (list): each period adds `reopenCount` and `lastReopen = { at, by: { id, name }, bySupport, reason }` (`null` if never reopened). Badge e.g. "Reopened ×1".
   - `GET /api/cutoff-periods/:id` (detail): adds `statusHistory[]` (oldest first): `{ fromStatus, toStatus, action: "status"|"finalize"|"reopen", reason, at, by: { id, name }, bySupport }` (`finalize` = locked through Finalize Cutoff on the review page; `status` = Lock / Unlock / Mark Processed from the list), plus `reopenCount` / `lastReopen`. `bySupport: true` = done by B. Buddy (show "BizBuddy Support").
   - History starts with this release (earlier changes aren't recorded).
5. **Outdated export**:
   - List: `payrollExport.outdated` (boolean) + `payrollExport.outdatedDepartments` (names).
   - `GET /api/payroll-export/by-cutoff-period/:id`: `data.outdated`, `data.outdatedDepartments`, `data.reopenedAt`.
   - Show "Outdated: {departments} reopened, process again to update" next to the export / download, so nobody pays from old numbers.
