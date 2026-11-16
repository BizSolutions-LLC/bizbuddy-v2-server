# Changelog — v2.11.12

**Branch:** not created yet (uncommitted). **Tickets:** BB-121 (company-wide Cutoff Page setting). **Schema change:** yes, one column (`Company.cutoffPageView`). **Client:** web, see `docs/client-update-BB-121.md`.

---

# BB-121 — Cutoff Page type: List / Calendar

## What
BB-121 redesigns the cutoff pages. The current list + review pages become the **List Type**, and a new **Calendar Type** is added. An admin picks one for the whole company in Configurations → Cutoff Page.

For now the server only stores that choice. The Calendar Type uses the existing cutoff endpoints unchanged; the API improvements wait for BB-114 (after ~2026-11-28).

## Changes
- `scripts/add-company-cutoff-page-view.sql`: adds `Company.cutoffPageView TEXT NOT NULL DEFAULT 'list'`. Plain text, not a Postgres enum.
- `src/prisma/schema.prisma`: `Company.cutoffPageView String @default("list")`.
- `src/controllers/Account/companySettingsController.js`:
  - `getSettings` returns `cutoffPageView`.
  - `updateSettings` accepts it, only `"list"` or `"calendar"`; any other value → 400. Its response includes the field.
  - Who can save: admin/superadmin, and, **during development**, a supervisor when the request body is exactly `{ cutoffPageView }`. Every other setting stays admin/superadmin only. Revisit before production: one supervisor changes the page for the whole company.

## Exclude note no longer dropped (BB-121 follow-up from the client)
- **Cause:** `TimeLogApproval` has one `notes` column. Excluding a record (`PATCH /api/cutoff-periods/:id/approvals/:approvalId`, action `exclude`/`reject`) saved `reason || notes`, so the free-text note was lost whenever a reason was also sent. This happened on both List and Calendar pages, daycare and B&C.
- **Fix:** a new `buildExcludeNote(reason, notes, action)` in `src/services/Cutoff/daycareCutoffStrategy.js`, also used by `bncCutoffStrategy.js`, saves:
  - **both sent:** `"<reason> — <note>"`, or just one copy if the two are the same;
  - **only one sent:** that one;
  - **neither, on reject:** `"Rejected by supervisor"` (unchanged);
  - **neither, on exclude:** null (unchanged).
- No schema change, and the response shape is unchanged. Notes already lost on past records can't be recovered.
- Bulk exclude (`/approvals/bulk`) takes only `notes`, so it never had this problem.

## Run order
1. The user runs `scripts/add-company-cutoff-page-view.sql`.
2. The user runs `prisma generate`.
3. Deploy. The SQL must come first, because the new code selects the column.
4. The web client builds the Configurations section and the page switch (`docs/client-update-BB-121.md`).

## Test (user)
- `GET /api/company-settings` → `cutoffPageView: "list"` for every company.
- PATCH `{ "cutoffPageView": "calendar" }` as admin → 200, and the GET shows it.
- PATCH `{ "cutoffPageView": "grid" }` → 400.
- PATCH `{ "cutoffPageView": "calendar" }` as supervisor → 200.
- PATCH `{ "cutoffPageView": "list", "otBasis": "weekly" }` as supervisor → 403, and nothing is saved.
- PATCH as employee → 403.
- Exclude one record with `reason` + `notes` → the saved note reads `"reason — note"`. With only one of them → that one. Reject with neither → "Rejected by supervisor". Try this on a daycare and a B&C company.
- Saving other settings without the field leaves it unchanged.

- SQL + `prisma generate`: done by the user on 2026-11-16. Next: commit/push on `release/v2.11.12`, then deploy.

## Production plan for the Calendar Type (agreed 2026-11-16)
- **The Calendar ships to production view-only.** Clients can see it, but approvals stay on the List page. The client side:
  - hides or disables approve, exclude, "Approve remaining" and the OT actions on the Calendar review page;
  - labels its hours as **"Preview"**;
  - adds a link to approve in the List review for the same period, so a company on Calendar can still approve.
- **Same API as the List page.** The Calendar calls only existing endpoints (`/cutoff-periods`, `/:id/approvals`, `/api/timelogs`, `/api/company-settings`, the same approve/exclude PATCH). This release adds only the `cutoffPageView` setting and the exclude-note fix.
- **Why view-only:** the Calendar review works out preview hours in the browser (client audit: `docs/BB-121-client-computation-audit.md` in the client repo). With approvals on the List page, those previews can't change what's saved or paid.
- **Decide before production:** whether supervisors keep saving `cutoffPageView`. It's harmless while the Calendar is view-only.

## Client computation audit — server review (2026-11-16)
The audit was checked against both repos. It is accurate: the cited functions and lines match, and the copied rules match the server's approval code (driver segment hours, grace + 59 s, lunch overlap, Staff in/out times, default picks), apart from the gaps below.
- **Gaps already in the audit:**
  - Staff lunch: the client subtracts it, the server doesn't (Q2 below).
  - Regular-segment cap at `defaultShiftHours`: the server applies it on approval, the preview doesn't.
- **Added by the server review:**
  - The preview works from `originalTimeIn/Out` when they're set; approval works from the current `timeIn/timeOut`. They can differ on a record that was approved then reset, or after a conflict resolve.
  - Two client comments no longer match the code: `rawPayHours` ("lunch not applied"), and the comment above `segmentRow` ("Actual = the server's hours").

## Parked (not in this release)
- **Q2, regular approval doesn't deduct lunch (payroll, own ticket, label TBD).**
  - `daycareCutoffStrategy` REGULAR approval stores `actualHours = clockOut − clockIn`, with no lunch subtracted in either mode.
  - `payrollExportService` pays `actualHours`.
  - `syncApprovedRegularToTimeLog` then overwrites the lunch-deducted `netWorkedHours`.
  - This affects the List page and payroll today. Start with a read-only check of the affected approved records.
- **Q1, early minutes on Raw approval (user's policy decision).** The time-log calculation snaps an early clock-in within `earlyClockInGraceMinutes`, but Raw approval keeps the real time and pays the early minutes (5.5h pending vs 5.52h approved). Pending and approval should follow one rule.
- **Q4, Driver/Aide lateness.** Measured from the template start of the earliest assigned shift; `customStartTime` is ignored. A 7:52 punch with no `beyond_grace` needs a look at the actual record.
- **Making the Calendar actionable:** after BB-114 batch 1 (~2026-11-28), with the `/approvals` redesign. It would add one shared approval-hours function used for both preview and approval (fixes the client copies + Q1/Q3/Q5), shift times and `rawLateMinutes` in `/approvals`, a stored approval mode (schema), and a per-record, all-or-nothing bulk approve.

## Not changed / next
- Calendar Type page itself: built by the client from the shared designs; view-only in production for now.
- From the earlier, reverted BB-121 work, now for after Nov 28:
  - `counts` on the list;
  - one `groupBy` for the approval stats;
  - LA instead of UTC as the sync's fallback time zone;
  - `processed` allowed only from `locked`;
  - notification labels that read `periodStart`/`periodEnd`.
