# BB-144: Modernized email templates (client hand-off)

**Status:** built on the server 2026-11-23, not deployed yet. **No API change.**

All 12 emails the server sends now share one design (logo header, white card with an orange strip, one orange button, shared footer). The design comes from `docs/BizBuddy-email-templates.pdf` / `.zip`.

## What the web client needs to do

Nothing has to be built. Please **keep these routes working**, because the email buttons link to them:

| Email button | Route |
|---|---|
| Welcome: "Sign in to BizBuddy" | `/sign-in` |
| Password reset: "Choose a new password" | `/reset-password/confirm?token=…` (unchanged) |
| Password changed: "Choose a new password" | `/reset-password` |
| Missed clock-in: "Clock in now"; clock-out reminder: "Open BizBuddy" | `/dashboard/employee/punch` |
| Missed clock-out, automatic clock-out, time log correction | `/dashboard/employee/punch-logs` |
| Supervisor auto clock-out copy, morning and evening reports | `/dashboard/company/punch-logs` |

**Also keep `public/logo.png`.** Every email shows the logo from `https://mybizbuddy.co/logo.png`. If that file is renamed or removed, the emails show the text "BizBuddy" instead of the logo. It is 4268 × 1553 px (84 KB) and the emails show it 150 px wide. A smaller copy (about 400 px wide, same name) would make the emails lighter and is optional.

If any of these routes or the logo changes or moves, tell the server side so the emails follow.

**Fixed along the way:** the old admin emails linked to `/dashboard/company-panel/punch-logs` and `/dashboard/time-logs`. Neither route exists in the web app, so those buttons went nowhere. They now point to `/dashboard/company/punch-logs`.

## System Admin → Emails (BB-140)

- Template keys and labels are unchanged (`GET /api/system-admin/emails/templates`). The page needs no change.
- A test send now shows the new design.
- Log `type` for the eight notification test sends is now the same as the real sends (e.g. `MISSED_CLOCK_IN` instead of `missedClockIn`). If the page filters test rows by the old template names, switch to the notification types.

## Mobile

No change. Email buttons open the web app.

## App download QR codes (added 2026-11-23)

QR codes for the BizBuddy mobile app, ready to use on the website, sign-in page, flyers or slides.

**Where:** this server repo, folder `docs/app-qr/`. Copy the files you need into the web app's `public/` folder (suggested: `public/qr/`) and reference them from there, e.g. `/qr/bizbuddy-ios-app-store-qr.svg`.

| App | Link inside the QR | Files |
|---|---|---|
| iPhone (App Store) | `https://apps.apple.com/app/bizbuddy-tks-payroll/id6742564608` | `bizbuddy-ios-app-store-qr.svg`, `.png`, `-orange.png` |
| Android (Google Play) | `https://play.google.com/store/apps/details?id=com.bizsolutions.mybizbuddy` | `bizbuddy-android-google-play-qr.svg`, `.png`, `-orange.png` |

- **Direct links:** the store address is encoded straight in each code. There's no QR service, no redirect page, no tracking, and the codes never expire.
- **No country in the iPhone link:** visitors in LA land on the US store page. An iPhone opens the App Store app directly.
- **Checked:** every file was decoded back to the exact link above.
- **Formats:**
  - SVG: sharp at any size; best for web pages and print.
  - PNG: 1060 px, for slides or documents.
  - Orange: BizBuddy orange `#C2410C`, the same as the email buttons. The plain versions are black.
- **When using them:**
  - Keep the white margin around each code.
  - Don't place them smaller than about 2 cm (0.8 in) in print.
  - Label them "iPhone" and "Android" when shown side by side.
- **If a store link ever changes** (new app id or package name), the codes must be made again. Ask the server side.
