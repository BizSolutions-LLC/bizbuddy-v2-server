# Changelog — v2.11.20

**Branch:** `release/v2.11.20` (pushed 2026-11-23), from `origin/master` (after PR #134).

**Tickets:**
- BB-144: Modernize all email templates. **Built. The user checked the design with System Admin test sends on 2026-11-23. Real-data paths (morning/evening reports, missed clock-in/out, auto clock-out) are first exercised after deploy.**

**Schema change:** none. **Deploy:** needed (server code). No SQL, no `prisma generate`, no data scripts, no required env (optional `EMAIL_LOGO_URL`).
**Client impact:** no API change. The web app must keep the routes the email buttons open, plus `public/logo.png` (the email logo). Hand-off `docs/client-update-BB-144.md` (not sent).
**Mobile impact:** none.

---

# BB-144 — Modernize all email templates

- **What:** the 12 emails the server sends used 3 unrelated styles. They now share the design from the user's BizBuddy email-templates PDF/ZIP: logo header, white card with an orange strip, one orange button, and a shared footer (support email and phone, platforms, social links, Privacy, Terms).
- **User decisions (2026-11-23):**
  - All 12 existing emails, and fill the new data fields where the server can.
  - Not built: ZIP #13 cutoff-review, #14 ot-decision, and a "supervisor edited your punch" email. These go to a follow-up ticket.
  - #10 "Time log correction" restyles the existing auto clock-out correction notice (same trigger).
  - Password emails show the device only, read from the user agent. No location, no IP lookup.
  - Logo: the web app's live `https://mybizbuddy.co/logo.png` (checked: 200, image/png).
- **Copy corrected against the ZIP:**
  - Real lifetimes: reset link 5 minutes, deletion code 10 minutes.
  - Welcome: the temporary password doesn't expire and no change is forced at first sign-in, so the email asks the person to change it.
  - Clock-out reminder: it is sent before the shift ends, and an automatic clock-out records the shift end.
  - Supervisor copy: it goes to the configured addresses, so it greets by name only when the address belongs to someone in the company.
  - "Secure my account" is now "Choose a new password", opening Forgot password (no sign-out-everywhere feature exists).
  - Location rows removed.
- **Data added:**
  - Reset and changed: request/change time in the company zone, and the device.
  - Deletion code: company name.
  - Missed clock-in: shift end, date, minutes late, supervisor name.
  - Missed clock-out and automatic clock-out: shift, clock-in, hours, and the last day of the open cutoff (left out if there is none).
  - Supervisor copy: shift and net hours.
  - Morning report: one row per employee: scheduled, clocked in, late, not in. Leave days and company holidays are left out.
  - Evening report:
    - still clocked in, "Overdue" after the shift ends;
    - today's automatic clock-outs;
    - no-shows, worked count, hours today, and hours beyond the schedule marked "(est.)";
    - all using the Overview rules (`attendanceAnalyticsService.buildAttendance`).
- **Behaviour changes:**
  - The evening report is now also sent when the only items are automatic clock-outs or no-shows.
  - The morning report counts per employee and skips people on leave or a holiday.
  - Automatic clock-out email times are in the company zone (they were in the server's zone).
  - Admin email links fixed: `/dashboard/company-panel/punch-logs` and `/dashboard/time-logs` don't exist; they now open `/dashboard/company/punch-logs`.
- **Changes:**
  - `src/emails/templates/*.html` + `templates.json` (new): the 12 adapted templates, with subject and preview text.
  - `src/emails/renderEmail.js` (new): `renderEmail(key, data)` → subject / html / text (Handlebars, escaped; plain-text copy), button links, logo address.
  - `src/emails/emailFormat.js` (new): company-zone times and dates, hours, durations, names, correction deadline.
  - `src/emails/welcomeEmail.js` (new): the welcome email for all four senders.
  - `src/utils/describeDevice.js` (new): "Chrome on Windows" / "BizBuddy app on iPhone".
  - `src/services/emailService.js`: `sendEmail({ templateKey, data })`.
  - `src/services/notificationService.js`: all 8 notification emails moved to the new templates and data; report functions take a report object.
  - `src/controllers/Account/resetPasswordController.js`, `src/controllers/Features/requestAccountDeletionController.js`: inline HTML replaced; real lifetimes come from constants.
  - `src/controllers/Features/employeeController.js` (create + bulk), `src/controllers/Account/accountSignupController.js`, `src/services/Analytics/companyProvisionService.js`: new welcome email, with creator, department and role where known.
  - Jobs:
    - `sendMorningReport.js` and `sendEveningReport.js`: rebuilt (`buildEveningReport` is exported).
    - `sendEveningReportTestJob.js`: uses that builder.
    - `checkMissedClockIns.js`, `checkMissedClockOuts.js`, `autoClockOutJob.js`: pass shift, hours and cutoff details.
    - `sendAutoClockOutCorrectionEmails.js`: uses the #10 template.
  - `src/services/Analytics/emailTemplateCatalog.js` (BB-140 test sends) and `src/routes/testRoutes.js`: new sample data, one shared set. Keys and labels are unchanged.
  - Deleted: `src/templates/*.hbs` (8), `src/emails/welcome_bizbuddy.html`, `src/emails/renderTemplate.js`.
  - Unchanged: email logging and the hiding of passwords, codes and links in stored copies (BB-140).
- **Endpoints:** no change.
- **Order of steps:** merge → deploy. Nothing to run.
- **Open questions / follow-ups:**
  - The `/api/test/*` routes are mounted without sign-in, so the sample-email routes accept any `to` address. This was already the case before BB-144. Suggested as its own ticket (System Admin sign-in or removal).
  - Separate ticket: ZIP #13 / #14 and the "supervisor edited your punch" email.
  - The first real morning and evening reports after deploy are the real-data check.
