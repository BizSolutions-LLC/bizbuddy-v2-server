# Client update: BB-137 Employee Logins (Company panel → Requests & Logs)

**Server version:** next release. **Company web app only.** Mobile: no change (mobile sign-ins are recorded by the server already).

> **Confidential feature.** Employees must never learn this page exists. Admins only (B. Buddy included). Please follow section 5 so nothing about it reaches non-admin users.

## What it is
The server now records every sign-in attempt (successful and failed) and sign-out: when, platform (mobile / web), which phone (`deviceId`) or browser (`browserId`), IP and app/browser. It flags:

| Flag | Meaning |
|---|---|
| `platformSwitch` | Signed in on a different platform than last time (mobile ↔ web) |
| `newDevice` | A phone or browser this employee never used before |
| `sharedDevice` | This phone/browser was also used to sign in to **another** account (strongest sign of one person punching for others) |
| `failedBurst` | 3+ failed attempts for the same email within 15 minutes |

Plus, per employee: **punches made from a device that isn't theirs** (needs the company's "Record punch device" setting, BB-134).

Flags are warnings only. Nothing is blocked, and employees see no difference.

---

## 1. Send a browser id at web sign-in (required for web tracking)
The web sends no device id today, so web logins can't be told apart. On the **sign-in** request (`POST /api/account/login`), and on sign-out, add a field **`browserId`**:

```js
// once per browser, kept in localStorage; no UI, no wording
function getBrowserId() {
  try {
    let id = localStorage.getItem("bb_bid");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("bb_bid", id);
    }
    return id;
  } catch {
    return undefined; // private mode etc.: just omit it
  }
}

await api.post("/api/account/login", { email, password, companyId, browserId: getBrowserId() });
```
- Name it exactly `browserId`. **Never send it as `deviceId`**: `deviceId` turns on the mobile one-phone lock.
- Only letters, digits and `.`, `_`, `:`, `-` (a UUID is fine), max 100 characters.
- Keep a neutral storage key (e.g. `bb_bid`) and no comments or labels that describe the purpose in shipped code.
- The sign-in response is unchanged.

## 2. List
```http
GET /api/employee-logins?from=2026-11-14&to=2026-11-20&userId=&departmentId=&platform=&event=&outcome=&flag=&q=&page=1&pageSize=50
```
| Param | Notes |
|---|---|
| `from`, `to` | `YYYY-MM-DD` in the **company** time zone. Default last 7 days, max 92 days |
| `userId`, `departmentId` | filters |
| `platform` | `mobile` \| `web` \| `other` |
| `event` | `sign_in` \| `sign_out` |
| `outcome` | `success` \| `failed` \| an exact outcome (below) |
| `flag` | `any` \| `platformSwitch` \| `newDevice` \| `sharedDevice` \| `failedBurst` |
| `q` | search email, IP, device id or browser id |

Outcomes: `success`, `wrong_password`, `user_not_found`, `inactive`, `device_switch_cooldown`, `device_already_registered`, `agent_denied`, `invalid_request`, `denied` (older imported history: inactive or device conflict), `error`.

```json
{
  "data": {
    "timeZone": "America/Los_Angeles",
    "filters": { "from": "2026-11-14", "to": "2026-11-20", "...": "..." },
    "summary": {
      "signIns": 240, "successful": 228, "failed": 12,
      "byOutcome": [ { "outcome": "success", "count": 228 }, { "outcome": "wrong_password", "count": 9 } ],
      "byPlatform": [ { "platform": "mobile", "count": 190 }, { "platform": "web", "count": 38 } ],
      "flagged": { "platformSwitch": 14, "newDevice": 3, "sharedDevice": 2, "failedBurst": 1 }
    },
    "page": 1, "pageSize": 50, "pages": 5, "total": 240,
    "items": [
      {
        "id": "cm…",
        "at": "2026-11-20T15:02:11.000Z",
        "atLocal": "2026-11-20 7:02:11 AM",
        "event": "sign_in",
        "outcome": "success",
        "failed": false,
        "employee": { "id": "cmu…", "name": "Jane Doe", "department": "Classroom A", "status": "active" },
        "email": "jane@client.com",
        "platform": "mobile",
        "deviceId": "a1b2c3…",
        "browserId": null,
        "ipAddress": "203.0.113.7",
        "userAgent": "okhttp/4.12.0",
        "flags": { "platformSwitch": false, "newDevice": false, "sharedDevice": true, "failedBurst": false },
        "sharedWith": { "sameCompany": [ { "userId": "cmu…", "name": "Bob Reyes" } ], "otherCompanyAccounts": 0 },
        "source": "live"
      }
    ]
  }
}
```
- `employee` is `null` for attempts with an unknown email (still useful: someone guessing).
- `sharedWith` names only people **in this company**; accounts in other companies are only counted.
- `source: "backfill"` = rebuilt from older server logs (before this release); those rows may lack `browserId`.

## 3. One employee
```http
GET /api/employee-logins/employees/:userId?from=&to=
```
Default last 30 days (max 92). Returns:
- `employee`: name, department, status, `registeredDeviceId` (current phone), `lastLoginAt`.
- `summary`: sign-ins, failed, flag counts, number of devices, `foreignDevicePunches`.
- `devices`: every phone/browser they signed in from (kept year): `kind` (`device` \| `browser` \| `unknown`), `id`, `platform`, `firstSeen`, `lastSeen`, `signIns`, `isRegisteredPhone`, `alsoUsedBy` (`{ sameCompany: [{userId,name}], otherCompanyAccounts }` or `null`).
- `events`: their sign-ins/outs in the range (same shape as the list, `employee: null`).
- `foreignDevicePunches`: punches whose recorded device (BB-134 proof) isn't theirs: `timeLogId`, `punch` (`clock-in`/`clock-out`), `at`, `atLocal`, `deviceId`, `registeredDeviceId`, `deviceMatch`, `deviceAlsoUsedBy`.
- `punchProofNote`: show as a hint when the list is empty (needs "Record punch device" on).

## 4. Shared devices
```http
GET /api/employee-logins/shared-devices?from=&to=
```
Default last 90 days. Phones/browsers that signed in to **2+ accounts of this company**:
```json
{ "data": { "items": [
  { "kind": "device", "id": "a1b2c3…", "platform": "mobile", "lastSeen": "…",
    "accounts": [ { "userId": "cmu…", "name": "Jane Doe", "department": "Classroom A", "signIns": 31, "lastSeen": "…" },
                  { "userId": "cmu…", "name": "Bob Reyes", "department": "Classroom A", "signIns": 4, "lastSeen": "…" } ] }
] } }
```

## 5. Keeping it hidden (please follow)
- **Access:** every `/api/employee-logins` endpoint answers **404 Not found** to anyone who isn't an admin, as if it didn't exist. Don't show any error text that hints otherwise.
- **Menu:** show "Employee Logins" under Requests & Logs **only for admins**. Don't render a disabled item for others.
- **Code splitting:** load the page as a separate, lazy chunk imported only inside the admin-only route, so its code, text and endpoint names are not in the bundle that employees download. Keep the endpoint path out of shared constants files.
- **No traces elsewhere:** no notifications, emails, badges, tooltips or help text about it outside the page; no mention in employee-facing release notes.

## Suggested page
- **Top cards:** sign-ins, failed, and the four flag counts (click = filter).
- **Tabs:** *All logins* (table) · *Shared devices* · *By employee* (opens the employee view).
- **Table columns:** time (company zone), employee, event, outcome (red when failed), platform icon, device/browser (short id), IP, flag chips (Switch / New device / Shared / Failed burst).
- **Employee view:** device list (registered phone marked), timeline, and "Punches from another device" with links to the punch.

## Note for the company (not in the app)
California employers should mention sign-in monitoring in their general employee privacy notice (e.g. *"For security, we record sign-in activity such as device, browser and IP address."*). That doesn't reveal this page.
