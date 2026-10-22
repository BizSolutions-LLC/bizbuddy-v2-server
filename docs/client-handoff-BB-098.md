BB-098: Leave credits (fiscal-year grants, regularization, expiration), server v2.10.48
=======================================================================================

WHAT'S NEW
----------
Leave credits are now tracked per fiscal year, so the server knows which year each hour came from.
A company can turn on two features. They are independent and both start OFF:

  1. Leave Grant: the server gives leave credits automatically, either as a lump sum once per
     fiscal year (e.g. 40h) or as a monthly accrual (40h / 12 each month).
  2. Leave Expiration: unused credits expire after N fiscal years (counting the year they were
     granted). Employees get a reminder X days before (default 60).

New hires get credits only after a regularization period (e.g. 6 months from their hire date).
What happens on that date depends on a company setting (see 1c).

Everything is company-wide and applies to every leave type. PadPro only has Sick Leave.

The server work is in. Nothing changes for a company until an admin goes through the setup flow
in section 2.


1. COMPANY SETTINGS: NEW "LEAVE CREDITS" SECTION
------------------------------------------------
GET /api/company-settings and PATCH /api/company-settings now include these fields:

  Field                       Type / values                          Input
  --------------------------  -------------------------------------  ---------------------------
  leaveGrantEnabled           boolean                                Toggle "Automatic leave grant"
  leaveGrantMode              "yearly_lump" | "monthly_accrual"      Radio: "Once per fiscal year" /
                                                                     "Monthly accrual"
  leaveGrantHours             number > 0                             "Hours per fiscal year" (e.g. 40)
  leaveYearStartMonth         1–12                                   Fiscal year start: month
  leaveYearStartDay           1–28                                   Fiscal year start: day
  leaveExpirationEnabled      boolean                                Toggle "Leave expiration"
  leaveCreditLifetimeYears    1–10                                   "Credits usable for N fiscal years"
  leaveExpiryReminderDays     0–365 (0 = no reminder)                "Remind employees N days before"
  leaveRegularizationMonths   0–60 (0 = no waiting period)           "Credits start N months after hire"
  leaveRegularizationGrant    "none" | "catch_up" | "prorated" |     "On regularization" select
                              "full"                                 (see 1c)
  leaveCreditsInitializedAt   ISO string | null (read-only)          Not an input; see 1b

a) Showing the fiscal year end
   Only the start is stored. Show the end as a read-only label: start + 1 year - 1 day.
   Example: start Jan 1 → "Jan 1 – Dec 31". Start Jul 1 → "Jul 1 – Jun 30".

b) Fields that lock once setup has been applied (leaveCreditsInitializedAt is not null)
   - leaveYearStartMonth, leaveYearStartDay and leaveGrantMode become read-only.
     PATCH rejects changes to them with 400 { error }.
   - Suggested hint: "Locked after leave credits were set up."

c) "On regularization" options depend on the grant mode
   Only show the options that are valid. Anything else returns 400.

   Once per fiscal year (yearly_lump):
     - "none"     → "Nothing until the next fiscal year"
     - "prorated" → "Prorated for the months left in the fiscal year"
     - "full"     → "Full annual amount"
   Monthly accrual (monthly_accrual):
     - "none"     → "Start accruing the following month"
     - "catch_up" → "Grant the waiting period's worth at once, then accrue monthly"

   When the admin switches the grant mode in the form, reset this select to "none".

   You can hide "On regularization" when leaveRegularizationMonths = 0. For employees hired
   after setup the rule still applies on their hire date, so showing it is also fine.

d) What the toggles do through PATCH
   - Turning either toggle OFF: a plain PATCH works at any time.
   - Turning leaveGrantEnabled ON: a plain PATCH works only after setup has been applied once.
     Before that it returns 400.
   - Turning leaveExpirationEnabled ON: always use the setup flow (section 2), never a plain
     PATCH. A plain PATCH returns 400.
   - Simplest client rule: if a toggle goes from OFF to ON, open the setup flow (section 2).
     If it goes from ON to OFF, PATCH directly and show a confirmation.
   - Other fields (hours, lifetime, reminder days, regularization) save with a normal PATCH.
     Changing the lifetime only affects credits granted from then on. Suggested hint:
     "Applies to new credits only."

   PATCH errors come back as 400 { "error": "message" }. Several validation messages are joined
   with "; ". Show the message as is.


2. SETUP FLOW: PREVIEW, THEN APPLY (admin / superadmin only)
-----------------------------------------------------------
Both endpoints take the same body: the settings form (any field from section 1, except
leaveCreditsInitializedAt) plus the two toggles as they'll be after confirming. Fields left out
fall back to what's saved.

  POST /api/leave-balances/credit-setup/preview   ← read-only, safe to call on every form change
  POST /api/leave-balances/credit-setup/apply     ← saves the change

a) Preview response

  200 {
    "data": {
      "settings": { …effective settings incl. leaveGrantEnabled / leaveExpirationEnabled },
      "initialized": false,
      "today": "2026-10-15",
      "currentFiscalYear": { "fiscalYear": 2026, "label": "FY2026",
                             "startsOn": "2026-01-01", "endsOn": "2026-12-31" },
      "rows": [
        {
          "userId": "…", "name": "Jane Doe", "status": "active",
          "policyId": "…", "leaveType": "Sick Leave", "isArchived": false,
          "balanceHours": 95,
          "lots": [                                  // newest fiscal year first
            { "fiscalYear": 2026, "label": "FY2026", "hours": 40,
              "expiresOn": "2027-12-31", "expiresImmediately": false },
            { "fiscalYear": 2025, "label": "FY2025", "hours": 40,
              "expiresOn": "2026-12-31", "expiresImmediately": false },
            { "fiscalYear": 2024, "label": "FY2024", "hours": 15,
              "expiresOn": "2025-12-31", "expiresImmediately": true }
          ],
          "expiringNowHours": 15,
          "balanceAfterHours": 80
        }
      ],
      "totals": { "activeEmployeesWithBalance": 42, "balanceHours": 2100,
                  "expiringNowHours": 230, "balanceAfterHours": 1870 },   // active employees only
      "regularization": {
        "missingHireDate": [ { "userId": "…", "name": "…" } ],
        "inWaitingPeriod": [ { "userId": "…", "name": "…", "regularizationDate": "2027-01-15" } ]
      }
    }
  }

  - Rows come sorted: active employees first (by name), then inactive or deleted employees who
    still have a balance.
  - Labels are "FY2026" when the fiscal year starts Jan 1, and "FY2026-27" otherwise.
  - Before setup, "lots" is an estimate: the balance is split into chunks of "hours per fiscal
    year", newest first. This is the same rule as the CSV forecast already reviewed. After setup,
    "lots" shows the real stored credits.

b) Suggested preview screen
   - Header: the current fiscal year label with its dates, and the effective settings in one line.
   - Totals tiles: Current balance / Expiring immediately / Balance after.
   - Table: Employee | Status | Leave type | Balance | one column per fiscal year (hours +
     "expires DATE") | Expiring now | Balance after.
     Highlight lots where expiresImmediately = true, e.g. red with the label "Expires on apply".
   - A warning list for regularization.missingHireDate: "These employees have no hire date and
     won't receive automatic credits until one is set." Link each to the employee profile.
   - An info list for regularization.inWaitingPeriod: "Credits start on <regularizationDate>".
   - Buttons: Cancel / Confirm & apply.
   - If expiringNowHours > 0, ask for confirmation first: "<X>h across <N> employees will expire
     immediately. This can't be undone."

c) Apply response

  200 { "data": { "applied": { … }, "settings": { …saved settings } } }

  - First-time setup: applied = { "lotsCreatedFor": 42, "expiredHours": 230 }
  - Later applies with expiration on: applied = { "expired": { "lots": 3, "hours": 45 } }
  - Errors:
      400 { "message", "errors": [] }   bad settings (same rules as section 1)
      409 { "message" }                 setup was already applied (e.g. a double click or two
                                        admins at once). Reload the settings.
  - After a successful apply, reload the company settings (GET) so the form's lock state and
    toggles match the server.


3. LEAVE BALANCES (employee view + admin drill-down)
----------------------------------------------------
GET /api/leaves/balances. Every leave type entry gains new fields; nothing is removed.

  {
    "policyId": "…", "leaveType": "Sick Leave",
    "credits": 120,          // NOW = available + used + expired
    "used": 25,
    "expired": 15,           // NEW
    "available": 80,
    "creditLots": [          // NEW, oldest first; [] before setup
      { "fiscalYear": 2025, "label": "FY2025", "remainingHours": 40, "expiresOn": "2026-12-31" },
      { "fiscalYear": 2026, "label": "FY2026", "remainingHours": 40, "expiresOn": "2027-12-31" }
    ],
    "nextExpiration": { "date": "2026-12-31", "hours": 40 } | null,   // NEW, only when expiration is on
    …existing fields unchanged (balanceHours, usedHours, shiftHours, transactions, isPaid, isNotPaid)
  }

  - Add an "Expired" figure next to Credits / Used / Available. The identity is now
    Credits − Used − Expired = Available.
  - When nextExpiration is set, show a notice: "40h expire after Dec 31, 2026".
    Use warning styling when the date is within leaveExpiryReminderDays.
  - Optional breakdown of creditLots, e.g. a small table or an expandable "By fiscal year" list:
    FY label | hours | usable through. Leave is always taken from the oldest year first, so the
    top row is the next to be used and the next to expire.
  - "expiresOn" is the last usable day, a plain date. Format it as is, without converting it
    through a timezone, or it will show a day earlier in Pacific time.


4. BALANCE MATRIX
-----------------
GET /api/leave-balances/matrix: every cell is now
  { "credits", "used", "expired", "available" }
with credits = available + used + expired. Add an "Expired" sub-value, or show it in the
tooltip, wherever "Used" is shown.

Each cell also has "creditLots" (added for the Leave Credits Management section):
  "creditLots": [{ "fiscalYear", "label", "remainingHours", "expiresOn" }]   // oldest first
  - Same shape as on /leaves/balances. It is [] until setup is applied
    (leaveCreditsInitializedAt is null), so show "—" in that case.
  - Unlike /leaves/balances, fully used years are included with remainingHours 0, so a
    year that was used up shows 0h. Expired years are left out.
  - Sum of remainingHours = available whenever available >= 0. If the leave type allows
    a negative balance and the employee is below 0, every year is at 0 and the sum is 0,
    while available is negative. The debt isn't tied to a fiscal year.
  - Reminders (LEAVE_CREDITS_EXPIRING) are sent by the hourly job, not by Apply. An
    employee already inside the reminder window at Apply gets it on the next run, within
    about an hour. Hours that expire at Apply (expiresImmediately) or later by the job send
    no notification. Only the "expired" ledger row is written.


5. LEAVE LEDGER / TRANSACTIONS
------------------------------
GET /api/leave-balances/transactions (and the "transactions" inside /leaves/balances):

  - New type "expired": negative hours, with balanceBefore and balanceAfter set and
    performedBy = null (system).
    Note example: "Expired — FY2024 credits (usable through 2025-12-31)", or
    "Expired on leave credit setup — …" for the ones expired at setup.
    Suggested label: "Expired", grey or red badge.
  - Automatic grants are "accrual" rows (same type as before; it just appears now) with
    performedBy = null. Note examples:
      "Annual grant — FY2026"
      "Monthly accrual — November 2026 (FY2026)"
      "Regularization grant (prorated) — regularized 2026-11-03"
    Suggested label: "Granted" or "Accrual". Show the note.
  - If the ledger has a type filter, add "expired" to its options. ?type=expired works.


6. NOTIFICATION
---------------
New notificationCode: "LEAVE_CREDITS_EXPIRING", sent to the employee (socket + push + list).

  title:   "Leave Credits Expiring"
  message: "40h of your Sick Leave credits will expire after Dec 31, 2026. Use them before then."
  payload: { "creditId", "policyId", "leaveType", "fiscalYear", "hours", "expiresOn" }

  - Each fiscal-year lot gets one reminder, when it enters the reminder window.
  - Add the code to the notification icon/route map. Tapping it should open the employee's
    leave balances, or the new leave request form.
  - Push: the FCM "data.type" is "LEAVE_CREDITS_EXPIRING", and "data.payload" is the JSON string
    above.


BEHAVIOR TO KNOW
----------------
- The server runs grants, expirations and reminders hourly, in the company's timezone. There's no
  endpoint to trigger it.
- A yearly grant lands on the fiscal year's start date. A monthly accrual lands on the first run of
  each month.
- At setup, everyone's current fiscal year counts as already granted, because their existing
  balance includes it. The first automatic grant comes at the next fiscal year (yearly) or next
  month (monthly).
- Regularization:
  - Credits start on hire date + regularizationMonths.
  - Employees already past that date at setup are treated as regular and get nothing extra.
  - Catch-up and prorated hours count toward the fiscal year of the regularization date.
  - Employees with no hire date, while a waiting period is set, get no automatic credits until
    a hire date is added. It might be worth showing "Leave credits start on <date>" on the
    employee profile, calculated client-side from hireDate + leaveRegularizationMonths.
- Manual adjustments (POST /api/leave-balances/adjust) are unchanged for the client. Behind the
  scenes, a credit goes into the current fiscal year and a deduction takes from the oldest.
- Approving leave: unchanged for the client. Hours are taken from the oldest fiscal year first.
- Turning expiration OFF stops anything from expiring and stops reminders. Credits keep their
  fiscal years, and turning it back on goes through preview/apply again.


COMPATIBILITY
-------------
Everything is additive. The only change in meaning is "credits", which now includes expired
hours. Until a company runs setup, creditLots is [], nextExpiration is null and expired is 0, so
"credits" reads the same as before.


HOW TO CHECK IT (PadPro)
------------------------
1. Company settings: set fiscal start, 40h, yearly lump, lifetime 2, reminder 60, regularization
   6 months + "prorated". Save. Both toggles still OFF.
2. Turn on Leave Expiration, which opens the preview. The rows and totals should match the CSV
   forecast (scripts/bb098-padpro-leave-expiration-preview-*.csv) for the same settings. Check
   the missing-hire-date list.
3. Confirm & apply. Fiscal start and grant mode should now be locked, and the success message
   should show the hours expired.
4. Open one employee's balances: Expired matches their "past expiration" in the CSV, creditLots
   lists their fiscal years, nextExpiration is set, and the ledger shows "expired" rows.
5. Turn on Leave Grant with a plain toggle. It should save without opening the preview.
6. Try changing the fiscal start. You should get a 400 with a "locked" message.
7. Turn Leave Expiration OFF, then ON again. It should go through the preview again with nothing
   expiring.
