# Client Payroll Export Contract — BB-066

> What the client (web/mobile) needs to change to consume the new automatic payroll export
> generation on cutoff-period lock. See `docs/changelog-v2.10.31.md` (BB-066 section) for the
> full server-side design/rationale.

---

## ✅ Status — settled, no client action needed

As of 2026-08-07: **the trigger is `status: "processed"`**, not `"locked"` — moved after real
testing confirmed the actual admin flow always goes Open → Locked → Processed, and `"processed"`
is the one status this API already treats as truly final (no revert allowed), unlike `"locked"`
which can still be reopened. Locking a period no longer generates/refreshes the payroll export;
only advancing it to `"processed"` does.

**This required zero client change**, confirming what the doc said before the pivot: the toast
implementation already ships generic — it renders whatever `message` comes back from *any*
status-changing call, not branched on which status. It picked up the new trigger automatically.

**Confirmed working end-to-end.** One client-side follow-up surfaced and was resolved during
verification: a "Lock Period" option had been added to already-`processed` rows, which the server
correctly rejects with `400` (`processed` is intentionally terminal — see rationale in the
changelog). That client change was reverted rather than requesting the server allow the reversal;
menu is back to empty for processed rows, which is the correct state for something final.

---

## What changed

**Endpoint:** `PATCH /api/cutoff-periods/:id/status` — **same path, same request body**
(`{ "status": "open" | "locked" | "processed" }`). No new endpoint, no breaking change — only
the response is enriched, and only when the request sets `status: "processed"`. `"locked"` and
`"open"` transitions are completely unaffected by this ticket.

Advancing a department's cutoff period to `"processed"` now also generates/refreshes that
department's payroll summary server-side and folds it into a company+period JSON
(`PayrollExportBatch`) behind the scenes. This is transparent to the client — nothing needs to
change for the "mark processed" action itself to keep working. **The one thing we do want: the
success toast reads the server's `message` field**, so the admin sees confirmation the period
was secured for payroll — already done, see Status above.

---

## Response shape

**On a successful `"processed"` transition, with export generation succeeding (the normal case):**

```json
{
  "message": "Cutoff period status updated to processed. Payroll summary secured for Driver/Aide — 14 employee(s).",
  "data": {
    "id": "...",
    "companyId": "...",
    "departmentId": "...",
    "periodStart": "2026-07-08T00:00:00.000Z",
    "periodEnd": "2026-07-21T00:00:00.000Z",
    "status": "processed",
    "...": "...other existing CutoffPeriod fields, unchanged",
    "payrollExport": {
      "generated": true,
      "employeeCount": 14
    }
  }
}
```

**On a successful `"processed"` transition where export generation itself failed** (rare —
non-blocking, logged server-side, the status change still goes through):

```json
{
  "message": "Cutoff period status updated to processed.",
  "data": {
    "...": "...same CutoffPeriod fields...",
    "payrollExport": { "generated": false }
  }
}
```

Note there's no `employeeCount` in the failure case — don't assume it's always present.

**Locking (`status: "locked"`), unlocking (`status: "open"`), or any other transition** — response
shape is **completely unchanged** from before this ticket. `data.payrollExport` is only ever
present when `status: "processed"` was the request.

---

## UI work — already done

1. **"Processed" success toast** — reads `response.data.message` (or `response.message`,
   whichever your API client unwraps to) and displays that string directly. Both the success and
   failure-fallback strings above are complete, human-readable sentences — no client-side
   branching on `payrollExport.generated` needed just to pick toast text; the server already
   picked the honest wording. **Already shipped, generic across all statuses — no further change
   needed even though the trigger moved from `"locked"` to `"processed"` mid-ticket.**
2. **Optional, not required:** if you want a "Secured" badge/icon on the Cutoff Periods list row
   once this has run, `data.payrollExport.generated === true` (from the response, or from
   whatever your list-refresh does after the status change) is the field to key off. Not part of
   this ticket's ask — mentioning in case it's wanted later.
3. **No change needed** for the existing `CUTOFF_PROCESSED` in-app notification (bell icon) —
   its text is deliberately left generic/unenriched (see the changelog for why: it broadcasts
   company-wide, not just to management, so payroll headcount details are kept out of it). Nothing
   to build here.

---

## Fetch/download endpoint — now available

**New:** `GET /api/payroll-export/by-cutoff-period/:id` — `:id` is any single department's
`CutoffPeriod` id for the target period (the same id you already have from the Cutoff Periods
list); the response is the merged company+period JSON regardless of which department's id was
used to look it up. **Admin/supervisor/superadmin only** — same JWT Bearer auth as every other
endpoint in this API, no new auth mechanism. Not exposed to typical employee users, since the
payload spans every department that's processed for the period, not just one.

```json
{
  "message": "Payroll export retrieved.",
  "data": {
    "employeeCount": 14,
    "generatedAt": "2026-08-07T09:41:00.000Z",
    "payload": {
      "companyId": "...",
      "periodStart": "2026-07-08",
      "periodEnd": "2026-07-21",
      "generatedAt": "2026-08-07T09:41:00.000Z",
      "employees": [
        { "EmployeeName": "...", "EmployeeID": "...", "UserID": "...", "RegularHours": 0, "OTHours": 0, "DriverHours": 0, "TrainingHours": 0, "PTO": 0 }
      ]
    }
  }
}
```

**`404`** if no department has processed that period yet (`"No payroll export has been generated
for this period yet — at least one department must be marked processed first."`) — this is a
normal, expected response for an `Open`/`Locked` period, not an error state to alarm the user
over; treat it as "nothing to download yet."

**UI work:** whatever "Download Payroll Export" affordance you build (button on a processed row,
a separate payroll page, etc.) calls this endpoint and offers `data.payload` as a downloadable
JSON file, or renders it directly — your call on presentation. Note `data.payload` is the exact
JSON handed to the external payroll system, `data.employeeCount`/`data.generatedAt` are just
metadata about the batch, not part of the payload itself.
