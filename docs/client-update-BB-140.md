# Client update: BB-140 Emails page (System Admin Dashboard)

**Server version:** next release. **System Admin Dashboard only.** The company web app and mobile app are not affected.

## What it is
Every email the server sends is now logged: welcome emails, password reset, password changed, account-deletion code, missed clock-in/out, auto clock-out, reports, corrections, and tests. System Admins can:
- **List** them (who, what, when, sent or failed, the mail server's receipt).
- **Open** one and see the email **as it was sent**, with sensitive parts hidden (passwords, one-time codes and reset links show as `••••••`), plus a check of every image in it.
- **Send a test** of any template, with sample data, to any address.

Retention: the summary row is kept **1 year**; the copy of the email is kept **90 days** (after that the row stays, without a preview). "Sent" means the mail server accepted it. Delivery to the inbox and bounces are not tracked.

All endpoints: any signed-in system admin (same cookie / Bearer as the other System Admin pages), read-only except the test send.

---

## 1. List
```http
GET /api/system-admin/emails?from=2026-11-14&to=2026-11-20&companyId=&type=&status=&isTest=&q=&page=1&pageSize=50
```
| Param | Notes |
|---|---|
| `from`, `to` | `YYYY-MM-DD`, **UTC** days. Default: the last 7 days. Max 92 days. |
| `companyId` | one company |
| `type` | an email type (see `summary.byType` for the ones in range) |
| `status` | `sent` \| `failed` |
| `isTest` | `true` \| `false` (omit = both) |
| `q` | search recipient email or subject (contains, any case) |
| `page`, `pageSize` | default 1 / 50, max 100 |

```json
{
  "data": {
    "filters": { "from": "2026-11-14", "to": "2026-11-20", "companyId": null, "type": null, "status": null, "isTest": null, "q": null },
    "summary": {
      "total": 412, "sent": 409, "failed": 3,
      "byType": [ { "type": "MISSED_CLOCK_IN", "count": 120 }, { "type": "WELCOME_EMAIL", "count": 14 } ],
      "byDay": [ { "day": "2026-11-20", "sent": 61, "failed": 0 } ]
    },
    "page": 1, "pageSize": 50, "pages": 9,
    "items": [
      {
        "id": "4f1c…",
        "sentAt": "2026-11-20T15:02:11.000Z",
        "type": "WELCOME_EMAIL",
        "isTest": false,
        "status": "sent",
        "errorMessage": null,
        "to": "jane@client.com",
        "recipientUserId": "cmu…",
        "company": { "id": "cmv…", "name": "BizSolutions LLC" },
        "from": "no-reply@mybizbuddy.co",
        "subject": "Welcome to BizBuddy — your account is live",
        "messageId": "<…@mybizbuddy.co>",
        "accepted": ["jane@client.com"],
        "rejected": [],
        "smtpResponse": "250 2.0.0 Ok: queued as …",
        "triggeredBy": "user:cmu…",
        "sizeBytes": 18234,
        "redactedCount": 2,
        "copy": "available"
      }
    ],
    "retention": { "copyDays": 90, "summaryDays": 365 }
  }
}
```
- `copy`: `"available"` (preview can be opened), `"expired"` (older than 90 days), `"none"` (older rows from before this release, or the copy couldn't be saved).
- `company` / `recipientUserId` can be `null` (e.g. a test to an outside address).
- `triggeredBy`: `user:<id>`, `system-admin:<id>`, `system-admin:provision-company`, `self-signup`, or `null` for automatic jobs.
- Rows from before this release have no `from`, receipt or copy.

## 2. One email
```http
GET /api/system-admin/emails/:id
```
Same fields as a list item, plus:
```json
{
  "content": {
    "from": "no-reply@mybizbuddy.co",
    "to": ["jane@client.com"],
    "subject": "Welcome to BizBuddy — your account is live",
    "html": "<!DOCTYPE html>…Password: ••••••…",
    "text": "Hi Jane, …Password: ••••••"
  },
  "images": [
    { "url": "https://mybizbuddy.co/logo.png", "ok": true, "status": 200, "contentType": "image/png", "reason": null },
    { "url": "https://example.com/missing.png", "ok": false, "status": 404, "contentType": "text/html", "reason": "HTTP 404" }
  ],
  "legacyBody": null,
  "metadata": null
}
```
- `content` is `null` when there is no copy (`copy` not `"available"`). For older rows, `legacyBody` may hold the template data as JSON: show it as "Details (older email, no preview)".
- `images`: every image in the email, checked by the server right now. `ok: true` = loads and is an image; `false` = broken (see `reason`); `null` = not checkable (embedded attachment).

**Showing the preview safely:** render `content.html` in a **sandboxed iframe**, never with `dangerouslySetInnerHTML`:
```jsx
<iframe title="Email preview" sandbox="" srcDoc={content.html} style={{ width: "100%", height: 700, border: 0 }} />
```
`sandbox=""` blocks scripts, forms and navigation; images still load, so a broken image shows broken, exactly like in the client's inbox. Offer a "Text version" tab with `content.text` when present.

## 3. Templates (for the test form)
```http
GET /api/system-admin/emails/templates
```
```json
{ "data": { "templates": [
  { "key": "WELCOME_EMAIL", "label": "Welcome (new account with login details)", "from": "no-reply", "usedBy": "Add employee, bulk add, self sign-up, System Admin Add company" },
  { "key": "PASSWORD_RESET", "label": "Password reset instructions", "from": "no-reply", "usedBy": "Forgot password" },
  { "key": "missedClockIn", "label": "Missed clock-in (employee)", "from": "notifications", "usedBy": "Every 5 minutes job" }
] } }
```
12 templates today; build the dropdown from this list (don't hard-code it).

## 4. Send a test
```http
POST /api/system-admin/emails/test
{ "template": "WELCOME_EMAIL", "to": "you@example.com" }
```
- Sends the **real** template with **sample data** (Jane Doe, BizBuddy Demo Co., a fake password/code/link). The subject starts with `[TEST]`.
- `200` → `{ "message": "Test \"…\" sent to you@example.com. It appears in the email list as a test.", "data": { "template", "to", "status": "sent" } }`. Refresh the list: the test is at the top with `isTest: true`.
- `400` unknown template / invalid address; `429` more than 30 tests per hour per admin; `502` the mail server refused (the message says why; it's also in the list as `failed`).

## Suggested page: System Admin → **Emails**
- **Filters bar:** date range (default last 7 days), company, type (from `summary.byType`), status, "Include tests" toggle, search box.
- **Summary row:** total / sent / failed, and a small sent-vs-failed per-day bar chart from `summary.byDay`.
- **Table:** time (show in the admin's local time), type, to, company, subject, status badge (red for failed with the error in a tooltip), a "TEST" chip, a preview icon (disabled when `copy` isn't `"available"`).
- **Detail drawer:** header (from, to, subject, time, status, message id, server reply, triggered by, "N values hidden"), the sandboxed preview, the Text tab, and an **Images** list with ✅ / ❌ and the reason.
- **"Send test email" button:** template dropdown + email field + Send; show the message; refresh the list.
