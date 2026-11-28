# Client update: BB-151 Company Settings history

**Server:** next push (the version is chosen at `/push`). **Web:** a Settings History view, an "Are you sure?" step before saving, and settings actions hidden for non-admins. **Mobile:** none expected (see the last section). **Status:** built 2026-11-26. **Database change:** one new table. Order: the user runs `scripts/add-company-settings-events-bb151.sql` → `prisma generate` → deploy. Before the SQL runs, saves work as before; no history is written and the history endpoint returns an empty list with `meta.available: false`.

## Why
Company-wide settings change hours and pay for everyone. Until now a save overwrote the old value, so nobody could tell who changed what or when. Every save that changes something is now recorded: who, when, which page, and each field's old and new value.

## 1. History endpoint
`GET /api/company-settings/history`: admin / superadmin only (B. Buddy included). Supervisors and employees get 403.

Query (all optional):

| Param | Meaning |
|---|---|
| `from`, `to` | `YYYY-MM-DD` (`to` includes that whole day, UTC) or ISO timestamps |
| `area` | `general` \| `cutoff` \| `notifications` \| `check` \| `payroll` \| `profile` \| `leaveCredits` |
| `field` | one field name, e.g. `gracePeriodMinutes` |
| `actorId` | User id of the person who saved |
| `limit` | 1–100, default 50 |
| `cursor` | `meta.nextCursor` from the previous page |

Response, newest first:
```json
{
  "data": [
    {
      "id": "42",
      "at": "2026-11-26T18:04:11.000Z",
      "area": "general",
      "by": { "id": "cm…", "name": "Jane Admin", "role": "admin" },
      "bySupport": false,
      "changes": [
        { "field": "gracePeriodMinutes", "label": "Grace period (min)", "from": 15, "to": 10 },
        { "field": "otBasis", "label": "Overtime basis", "from": "daily", "to": "cutoff" }
      ]
    }
  ],
  "meta": { "nextCursor": "41", "available": true }
}
```
- `bySupport: true` = saved by B. Buddy. Show it as "BizBuddy Support"; the staff member is kept on the server only.
- `by` is null only if the user no longer exists.
- Values are plain JSON: numbers, strings, booleans, null, arrays (`autoClockOutNotifyEmails`) or objects (`checkPositions`). Dates are ISO strings. Ids (e.g. `secondaryApproverId`) are shown as ids; resolve the name client-side if you want.
- A save that changes nothing writes no row. One save can write two rows: the main settings PATCH writes `general`, plus `cutoff` when the cutoff schedule changed.

Which page writes which area:

| Area | Endpoint |
|---|---|
| `general` | `PATCH /api/company-settings` (incl. leave credit fields sent there) |
| `cutoff` | the `cutoffSettings` part of the same PATCH |
| `notifications` | `PUT /api/company-settings/notification-settings` |
| `check` | `PUT /api/company-settings/check-settings` |
| `payroll` | `PUT /api/company-information/payroll-config` |
| `profile` | `PUT /api/company-information/company-info`, `PUT /api/company/me` (and the system-level company edit) |
| `leaveCredits` | `POST /api/leave-balances/credit-setup/apply` |

Not recorded (records, not settings): earning/deduction types, tax rates, setup guide skip/dismiss.

### Suggested UI
A "History" tab or button on Company Settings: a table with When (company zone) / Who / Page / Setting / Old → New, filters for page and date range, and "Load more" using `nextCursor`. Booleans read better as On / Off.

## 2. "Are you sure?" before saving
Client only; the server needs nothing. Before any settings save above, show a simple confirm such as: "This changes the setting for the whole company. Save changes?" with Cancel and Save buttons. No reason is collected.

## 3. Admins only on settings changes (new 403s)
These endpoints used to accept any signed-in user. They now answer **403** `{ "message": "Access denied: insufficient permissions." }` unless the user is admin or superadmin:
- `PUT /api/company-settings/notification-settings`
- `PUT /api/company-settings/check-settings`, `POST /api/company-settings/check-test-pdf`
- `PUT /api/company-information/payroll-config`, `PUT /api/company-information/company-info`
- POST / PUT / DELETE on `/api/company-information/earning-types`, `/deduction-types`, `/federal-tax-rates`, `/state-tax-rates`

The GET endpoints are unchanged. Please hide or disable these save buttons for supervisors and employees. `PATCH /api/company-settings` is unchanged (admins; supervisors may still save `cutoffPageView` on its own).

## Mobile
None expected. Please confirm with the mobile dev that the app never calls the endpoints in section 3 as a supervisor or employee.

## Follow-up (2026-11-27): B. Buddy code + no dev history
- **Who on support rows:**
  - `GET /api/company-settings/history` rows made by support now return `by.name: "B. Buddy (123)"`, using the last 3 characters of the staff code, plus a new field `supportCode: "123"`.
  - Older rows, or rows with no staff code, return plain `"B. Buddy"` with `supportCode: null`.
  - `bySupport` is unchanged.
- **Web change:** if the page shows "BizBuddy Support" whenever `bySupport` is true, show `by.name` instead.
- **Dev/local:** when the server runs with `NODE_ENV=development`, settings changes save as usual but no history row is written. Production records as before.
- **Cutoff status history (same naming):** support events now return `by.name: "B. Buddy (123)"` (or `"B. Buddy"`) and `supportCode`:
  - `GET /api/cutoff-periods`: `lastReopen`.
  - `GET /api/cutoff-periods/:id`: `statusHistory[]`. Its fields are `fromStatus` / `toStatus` / `action`, not `from` / `to`.
  - Web: `actorLabel` should show `by.name` for support events.
  - Cutoff status events are still recorded in dev/local, because reopen depends on them.
