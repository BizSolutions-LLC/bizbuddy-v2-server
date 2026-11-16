# Client update — BB-121 Cutoff Page type (List / Calendar)

**Server version:** v2.11.12. **Web only:** the mobile app is not affected.

## What changed on the server
There is one new company-wide setting, `cutoffPageView`, on the existing company settings endpoints. Nothing else changed: the cutoff list, review, approval, OT, sync and finalize endpoints are exactly as before.

| Value | Page |
|---|---|
| `"list"` (default) | Today's pages: `/dashboard/company/cutoff-periods` + `.../:id/review` (**List Type**) |
| `"calendar"` | The new **Calendar Type** |

Every company starts on `"list"`, so nobody sees a change until an admin switches it.

### Read it
`GET /api/company-settings` → `data.cutoffPageView` (`"list"` or `"calendar"`)

### Save it (admin / superadmin; supervisor for this field only, during development)
```http
PATCH /api/company-settings
{ "cutoffPageView": "calendar" }
```
- **200:** the response `data` includes `cutoffPageView`.
- **400:** `{ "error": "cutoffPageView must be one of: list, calendar" }` for any other value. Unlike some older fields, it is not silently defaulted.
- **403:** for employees, and for a supervisor whose request contains anything besides `cutoffPageView`.
- **Supervisors (during development):** a supervisor can save this setting only if the body is exactly `{ "cutoffPageView": ... }`. Every other company setting stays admin/superadmin only. The choice still applies to the whole company, admins included.
- The field is optional: leaving it out of a PATCH keeps the current value, so the other Configurations sections don't need to send it.

## UI to build
1. **Configurations → new "Cutoff Page" section.** A List / Calendar choice, editable by admins and (during development) supervisors, read-only (or hidden) for everyone else. Save it with a body that holds only `cutoffPageView`. It applies to the whole company.
2. **Cutoff page routing.** Read `cutoffPageView` (already fetched with the company settings) and show the List or Calendar page. Supervisors follow the company's choice.

## Notes on the Calendar Type designs (agreed in planning)
Use the **same endpoints, buttons and calls** as today. No new or faster endpoints until after BB-114 batch 1 (~2026-11-28).

- **Data sources:**
  - List cards, tabs and "Needs your attention": `GET /api/cutoff-periods` (`approvalStats`, `paymentDate`, `status`, `payrollExport`) + `GET /api/cutoff-settings/departments` ("no upcoming period").
  - Review / calendar: one `GET /api/cutoff-periods/:id/approvals` per period. It returns every employee at once (`data`, `leaves`, `otBlocks[].breakdown.days`, `fixedHours`, `otBasis`, thresholds, `companyTimezone`).
  - Buttons: Approve OT → `approveOtBlock`; "Pay Driver PM on schedule" → the existing Approve Schedule; bulk → `bulkUpdateApprovals`; Sync / Finalize unchanged.
- **Load:** `/approvals` is the slowest cutoff endpoint, and it writes data every time it's read. Until Nov 28:
  - keep each period's response while the page is open;
  - call it again only after an action or a Sync;
  - never prefetch other periods. The period cards in the merged design must not each trigger a load.
- **Previous-cutoff days / "carried in" week totals:** show neighbouring cutoff days greyed out without hours, and drop "carried in". Showing them would need a second `/approvals` call on the previous (locked) period.
- **OT rule toggle (Daily / Weekly / Cutoff):** don't recalculate OT in the browser. Show the company's rule (`otBasis` + its threshold) only, so the page never shows a number payroll won't pay.
- **"Rejected" counts:** the server reports rejected and excluded together as `approvalStats.excluded`, so label it as excluded.
- **"Mark as processed" / "Finalize":** the server doesn't block marking an open period as processed yet. The "decide on overtime first" rule is enforced in the browser only for now.
- **Not only Driver/Aide:** the calendar cells also need to cover:
  - regular daycare staff (no segments);
  - B&C (shift picker);
  - fixed-hours employees (flat 80h);
  - leave days, including the `reverted` status (BB-125);
  - training punches;
  - punch-vs-leave conflict days.
- **Days:** bucket punches into calendar days in `companyTimezone` from the response, never the browser's zone.

## Exclude note fix (server v2.11.12)
`PATCH /api/cutoff-periods/:id/approvals/:approvalId` with `action: "exclude"` (or `"reject"`) used to save `reason || notes`, so the note was dropped whenever a reason was sent. The server now keeps both in the record's `notes`:

| Sent | Saved `notes` |
|---|---|
| `reason` + `notes` | `"<reason> — <notes>"` (just one copy if they're the same) |
| only `reason` or only `notes` | that value |
| neither, `reject` | `"Rejected by supervisor"` |
| neither, `exclude` | `null` |

- The request and response are unchanged, so the client can keep sending both fields. To show them apart again, split the saved `notes` on `" — "`.
- Notes already lost on past records can't be recovered.
- Bulk exclude (`/approvals/bulk`) takes only `notes` and was never affected.
