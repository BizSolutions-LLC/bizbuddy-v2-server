# Server reply — BB-098 Leave Reports

**Status:** Built on the server, as requested, with the changes listed below. `GET /api/reports/leave` returns JSON, and the client builds the files.

---

## Answers to your questions

1. **A leave spanning two periods (`activity`):** credited, used, adjusted and expired hours go **by ledger entry date**, which is when the balance actually moved (for a leave, its approval date). That's what keeps `closing = opening + granted − used + adjusted − expired` true. `unpaidHours` doesn't move the balance, so it is taken **by leave day** (`LeaveDay` rows with `isPaid: false`). The used hours of a leave can therefore land in a different period from its unpaid days. Mention this in the report footnote if useful.
2. **Supervisor scope:** **own department only.** A supervisor always gets their department's employees. Passing another `departmentId`, or a `userIds` entry outside the department, returns **403**. A supervisor with no department also gets 403. Admin and superadmin see the whole company.
3. **Cost:** nothing expensive at this size. Opening balances are anchored on today's real balance and calculated backwards through the ledger (balance minus changes after the date), not summed from zero. Old balances from before the ledger existed have no entries, so summing forward would be wrong. The cap is **5 years** for `activity` and `ledger`.
4. **`usedHours` on a lot:** neither of the two sources you mentioned was accurate on its own:
   - `LeaveCreditUsage` misses admin deductions, and its rows are deleted when a leave is restored.
   - The subtraction had no record of the hours that expired.

   We added **`LeaveCredit.expiredHours`**, filled in by the expiration job, so `usedHours = grantedHours − remainingHours − expiredHours` is now exact. Nothing has expired yet, so there's no old data to fix.

## Changes from your draft

- **`creditedHours` (new, on `summary` and `activity`).** Every credit made before BB-098 setup was an admin **adjustment**, not a grant (`accrual`). PadPro's existing balances came entirely from adjustments, so `grantedHours` is 0 for them. `creditedHours = grantedHours + positive admin adjustments`. Show it as "Credited", or show both. `adjustedHours` is still the signed net of admin adjustments.
- **`usedHours` nets out credit-backs.** When a cutoff conflict gives a leave's hours back, the ledger records it as an `adjustment` linked to the leave (`leaveId` set). Those adjustments are subtracted from used. They are not counted in `adjustedHours`.
- **`summary.creditLots` is the current state, not "as of `to`".** Lots only store their current amounts. The envelope includes **`creditLotsAsOf`** (today's date) for the header. The hour totals still respect `to`. Each lot also carries `creditId` and `expiredHours`, and expired lots are included with `expiredAt` set, as you asked.
- **`requests`:**
  - `requestedHours` is **`null`** for pending requests (the day breakdown is only created on decision). Show the date range instead.
  - `decidedAt` comes from the approved or rejected ledger entry.
  - `creditsUsed` entries also include a `label` (e.g. "FY2025").
  - The `status` filter also accepts **`pending_secondary`**, which is a real status.
- **`activity` periods:**
  - Periods are cut to `from`–`to`, so the first and last can be partial.
  - Key formats: `2026-10` (month), `2026-Q3` (calendar quarter), `2026` (calendar year), `FY2026` (fiscal year).
  - With a fiscal start other than Jan 1: `FY2026-Q1`, labelled "FQ1 FY2026".
  - The envelope includes a `periods` array.
  - A row is returned for each employee × leave type that has a balance, any ledger entries, or unpaid days in the range.
- **`ledger`:** each row also has `date` (company timezone). `totals` = `{ count, byType }`.
- **`summary` rows** are skipped for employee × leave type pairs with no balance and no history. `nextExpiration` is the oldest lot that still has hours, and only while expiration is on.
- **`expiration` default range** (no `from`): every lot still usable, plus lots expired in the last 12 months. `state` is measured against `to`, which defaults to today.
- **`settings`** also includes `leaveGrantMode`.

Everything else follows your draft: the envelope, the employee object (`name` as "Last, First"), filters, defaults, the 400/403 errors, and `{ message }` bodies.

## Before testing

- The new `LeaveCredit.expiredHours` column is already in the database. Nothing to run.
- PadPro's leave credit setup was applied on Oct 21, 2026, so `expiration`, `creditLots` and `settings.leaveCreditsInitializedAt` return real data. `creditsUsed` stays `[]` for leaves decided before setup.

## Quick test calls

```
GET /api/reports/leave?type=summary
GET /api/reports/leave?type=activity&from=2026-01-01&to=2026-10-21&groupBy=quarter
GET /api/reports/leave?type=requests&from=2026-09-01&to=2026-10-31&status=approved,pending
GET /api/reports/leave?type=ledger&from=2026-10-01&to=2026-10-21&includeLifecycle=true
GET /api/reports/leave?type=expiration
```
