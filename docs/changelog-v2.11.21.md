# Changelog — v2.11.21

**Branch:** `release/v2.11.21` (pushed 2026-11-23), from `origin/master` (after PR #135).

**Tickets:**
- BB-145: Public contact form. **Built 2026-11-23. Client side cleared (user). The server send is first exercised after deploy.**
- BB-144 (addendum): app download QR codes. **Docs only, complete.**

**Schema change:** none. **Deploy:** needed (server code). No SQL, no `prisma generate`, no data scripts.
**Env (required for BB-145):** set `CONTACT_FORM_TO=info@bizsolutions.us,WebDev@bizsolutions.us` on Render **before** deploy. If it is missing, the form answers 500 and the page shows "email us directly".
**Client impact:**
- BB-145: new public endpoint. The client already builds against it. Hand-off `docs/client-update-BB-145.md` (server reply: optional `phone` field, `elapsedMs` request).
- BB-144: QR files described in `docs/client-update-BB-144.md`.
**Mobile impact:** none.

---

# BB-145 — Public contact form

- **What:** the landing page contact form now sends. `POST /api/public/contact` (no sign-in) emails the message to the team inbox, Reply-To = the visitor.
  - No auto-reply to the visitor: the address isn't verified, so an auto-reply would let anyone make the server email a stranger.
  - No table: the System Admin Emails log (BB-140) is the record, type `CONTACT_FORM`.
- **User decisions (2026-11-23):**
  - Recipients: `info@bizsolutions.us` and `WebDev@bizsolutions.us`. The first is the visible To and the rest get a hidden copy (Bcc), so "Reply all" never shows the visitor the other internal address.
  - Optional `phone` field added to the client's draft.
  - Email time in Los Angeles time.
  - The email is a 13th System Admin test sample.
- **Request:**
  - Fields: `name` (1–100), `email` (valid, ≤ 254), `company` (≤ 150), `phone` (optional, ≤ 30, 7–15 digits, extension allowed), `teamSize` (≤ 20), `message` (10–5000, line breaks kept).
  - Plus the honeypot `website` and `startedAt` / `elapsedMs`.
  - Name, email, company, phone and team size must be one line. Unknown fields are ignored.
- **Responses:**
  - `202 {ok:true}`: sent, or a bot dropped silently.
  - `400 VALIDATION_ERROR` with `fields`.
  - `429 RATE_LIMITED` + `Retry-After`.
  - `500 CONTACT_FAILED`.
  - All error text is fixed; visitor input is never echoed back.
- **Security:**
  - Bot drop (silent 202, logged): honeypot filled in, under 3 s, or more than 3 links.
  - Rate limits:
    - per IP, 5 per hour and 20 per day (only accepted requests count);
    - 200 sent emails per LA day for everyone together.
    - The counters are kept in memory and start again after a restart.
  - Request bodies are limited to 16 KB.
  - Visitor text is escaped in the HTML, and Reply-To is passed as `{name, address}`, so it is never parsed as an address list.
  - The message body is not stored in RequestLog.
  - CORS is unchanged; `www.mybizbuddy.co` redirects to `mybizbuddy.co`.
- **"Too fast" check:** `startedAt` compares the visitor's clock with the server's, so a fast visitor clock could silently drop a real message. The server prefers `elapsedMs`, which the client was asked to send. With `startedAt` alone it drops only a difference of 0–3 s, never a negative one.
- **Changes:**
  - `src/routes/Public/contactRoutes.js` (new): route, per-IP limits, response shapes.
  - `src/services/Public/contactFormService.js` (new): validation, bot checks, daily cap, the send (`sendContactEmail` is also used by the test sample).
  - `src/emails/templates/contact-form.html` (new) + `templates.json`: the team email in the BB-144 design, with a tap-to-call phone and a mailto reply button.
  - `src/utils/mailer.js`: optional `replyTo` and `bcc`; Bcc addresses are logged as recipients.
  - `app.js`: 16 KB JSON limit for this route, with the form's own error shape.
  - `src/middlewares/requestLogger.js`: the body of this route is not stored.
  - `src/routes/index.js`: mounts `/api/public`.
  - `src/services/Analytics/emailTemplateCatalog.js`: `CONTACT_FORM` test sample (goes to the test address, not the team).
- **Endpoints:** new `POST /api/public/contact`.
- **Order of steps:** set `CONTACT_FORM_TO` on Render → merge → deploy.
- **Open questions / follow-ups:**
  - The client should send `elapsedMs`.
  - If the server ever runs more than one instance, the in-memory limits need a shared store.

# BB-144 (addendum) — App download QR codes

- **What:** `docs/app-qr/` holds QR codes for:
  - the iPhone app: `https://apps.apple.com/app/bizbuddy-tks-payroll/id6742564608`, with no country in the link, so LA users get the US store;
  - the Android app: Google Play `com.bizsolutions.mybizbuddy`.
- **Files:** SVG + PNG + orange PNG for each app.
- **Direct links:** the link is encoded straight in each code, with no QR service or redirect. Each file was decoded back to its link.
- **Client:** described in `docs/client-update-BB-144.md`.
- **Endpoints:** no change.
