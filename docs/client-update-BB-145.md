# BB-145: Public contact form (server reply)

**Status:** built on the server 2026-11-23, not deployed yet. Your draft contract is accepted, with **one change** (`elapsedMs`, below) and a few notes.
**Database change:** none. The email shows in System Admin → Emails as type `CONTACT_FORM`.

## Endpoint

`POST /api/public/contact`, no sign-in, JSON, max 16 KB.

Request fields, rules and responses are as in your draft:

| Case | Status | Body |
|---|---|---|
| Sent | `202` | `{ "ok": true }` |
| Looks like a bot (honeypot, too fast, more than 3 links) | `202` | `{ "ok": true }`, dropped silently |
| Validation failed | `400` | `{ "code": "VALIDATION_ERROR", "message": "Please check the highlighted fields.", "fields": { … } }` |
| Too many messages | `429` + `Retry-After` (seconds) | `{ "code": "RATE_LIMITED", "message": "Too many messages. Please try again later." }` |
| Anything else | `500` | `{ "code": "CONTACT_FAILED", "message": "We couldn't send your message. Please email us directly." }` |

## Please change: send `elapsedMs`

`startedAt` compares the visitor's clock with the server's. If a visitor's clock runs a few seconds fast, a real message looks "too fast" and is dropped silently: the visitor sees the confirmation and we never get the message.

Please add **`elapsedMs`**: milliseconds since the form appeared, measured in the browser (`Date.now() - startedAt` at submit). The server uses it when present.

Until then, `startedAt` still works. The server drops only when the difference is between 0 and 3 s, never when it's negative.

## Added: optional `phone`

The server also accepts an optional **`phone`** field (the user asked for it, 2026-11-23). Please add an optional "Phone" input next to Work email.

| Field | Rules |
|---|---|
| `phone` | Optional. Trimmed, max 30 chars, one line. Digits, spaces and `+ ( ) - .`, plus an optional extension (`x12`, `ext. 12`). 7–15 digits. Error key `phone`: "Enter a valid phone number." |

Leave it empty or leave it out when the visitor skips it. The email shows it as a tap-to-call link.

## Notes

- **Field errors:** `fields` keys are `name`, `email`, `company`, `phone`, `teamSize`, `message`, with fixed text, e.g. `"Enter a valid email address."`. A body over 16 KB answers `400` with `fields.message`.
- **Rate limits:**
  - 5 per hour and 20 per day per address. Only accepted requests count, so a visitor who fixes a highlighted field isn't blocked.
  - 200 emails a day for everyone together.
  - The counters start again after a server restart.
- **Links:** more than 3 links (`http://`, `https://`, `www.`) across name, company, team size and message counts as spam.
- **CORS:** unchanged: `mybizbuddy.co`, `staging.mybizbuddy.co`, localhost 3000/3001/19006. `www.mybizbuddy.co` redirects to `mybizbuddy.co`, so it needs nothing. A new preview domain must be added on the server first.
- **Recipients** are set on the server only (`CONTACT_FORM_TO`). The client never sends a recipient, and any extra fields are ignored.
- **Until it's deployed**, the endpoint answers 404, so your "email us directly" fallback applies.

## Mobile

No change.
