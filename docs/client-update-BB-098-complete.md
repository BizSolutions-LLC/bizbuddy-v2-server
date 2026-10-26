BB-098 — Leave Module: complete on the server

Hi team, BB-098 is done on our end. Here's the final state and what's left for the client.

WHAT'S DONE (SERVER)
- Leave credits per fiscal year: monthly or yearly grants, regularization, expiration and expiry reminders.
- creditLots on GET /api/leave-balances/matrix (on every cell) and on GET /api/leaves/balances.
- Leave reports: GET /api/reports/leave (summary, activity, expiration, requests, ledger).
  Contract: docs/client-handoff-BB-098-reports.md
- Settings and setup flow contract: docs/client-handoff-BB-098.md

PADPRO IS SET UP (applied Oct 21, 2026)
- 40h of Sick Leave per fiscal year. The fiscal year starts Jan 1.
- Monthly accrual: about 3.33h on the 1st of each month, starting Jan 1, 2027.
  PadPro already gave out this year's 40h, so nothing more is credited in 2026.
- Credits are usable for 2 fiscal years. Employees are reminded 60 days before they expire.
- New hires: credits start 6 months after the hire date, with a 20h catch-up that day
  (6 months x 3.33h), then the normal monthly accrual.
- Setup was first applied as "Once per fiscal year". We corrected it to "Monthly accrual" on the
  server. Settings now show grant mode = monthly_accrual and regularization = catch_up. Both are
  locked, which is expected.
- Apply expired only Eduardo Aviso's 4.75h of FY2024 credits.

WHAT EMPLOYEES WILL SEE
- Nov 1, 2026: 6 employees get a reminder about 99h of FY2025 Sick Leave that expires after Dec 31.
  It comes as an in-app notification plus a phone push. There is no email.
    notificationCode: LEAVE_CREDITS_EXPIRING
    title:   "[Piedmont Adult Day Program] Leave Credits Expiring"
    message: "[Piedmont Adult Day Program] 40h of your Sick Leave credits will expire after
             Dec 31, 2026. Use them before then."
    payload: { creditId, policyId, leaveType, fiscalYear, hours, expiresOn }
  It's sent once per employee for each fiscal year of credits.
- Jan 1, 2027: unused FY2025 hours expire. They show in leave history as an "expired" entry.
  No notification is sent for this. Then the first monthly accrual lands.

NEEDED ON THE CLIENT
1. Notifications: please handle LEAVE_CREDITS_EXPIRING before Nov 1. Show it in the notification
   list, and ideally open the employee's leave balance when it's tapped. A push arrives either way,
   but an unknown type may look generic or be hidden in the list.
2. Show creditLots (per-year hours and expiry date) on the balance views and in the admin matrix.
3. Company Settings: show the fiscal year start and grant mode as read-only after setup. Use
   leaveCreditsInitializedAt to know when setup has been applied.
4. Leave reports: build the Generate Report screen against GET /api/reports/leave.

SERVER DEPLOY
- These changes ship in server v2.10.49, which we're deploying shortly. We'll ping you when it's
  live on prod.

Thanks!
