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
