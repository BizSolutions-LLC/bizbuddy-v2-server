# Mobile update — server v2.11.0

**From:** bizbuddy-v2-server
**For:** the BizBuddy mobile app
**Tickets:** BB-107 (deactivated accounts), BB-110 (B. Buddy on mobile), plus security hardening

Nothing breaks for existing users. Sections 1–2 need **no app changes**. Section 3 is the only real
feature work, and it's only needed if support staff should use B. Buddy from the phone. Everything
else in v2.11.0 is web or system-admin dashboard only.

> **Don't change the session, token or biometric handling as part of this release.** Some users have
> reported being logged out with their biometrics removed, and that is still under investigation.
> Leave that area exactly as it is until the investigation is done.

---

## 1. Deactivated accounts are signed out (BB-107) — works with the current app, no change

When an admin deactivates someone, or their company is retired, the **next API call** from their
phone returns:

```json
401 { "message": "Your account is inactive. Please contact your administrator.", "code": "TOKEN_VERSION_MISMATCH" }
```

- This is the same `code` the app already gets for "logged out on another device" and "log out
  everywhere". The **existing handler already covers it**: confirmed on a real phone on 2026-10-28,
  when the session expired and the app asked for a new sign-in. **No change needed.**
- Signing in again returns 403 `{ "message": "Account is inactive. Please contact your administrator." }`.
  The sign-in screen already shows server messages.
- Inactive accounts no longer appear in the company picker (`GET /account/get-user-email`). If an
  email has no active account left, the response has `hasActiveAccounts: false`, so show the existing
  "no account" state.
- **Server side, no app work needed:** deactivating also clears the phone's push token. The account
  stops getting push notifications, clock-in/out reminders and new shifts.

**Test (already passed once):** sign in on a phone, deactivate that employee from the Company panel,
then tap anything that loads data. The app should return to sign-in.

**For the logout investigation:** every request that gets a 401 is recorded in the request log with
the user, time, endpoint and device user agent. The system-admin dashboard's Request Logs (filter:
status 401) can show which users were signed out and when, without changing any app code.

## 2. Failed sign-in limit — no change needed

- `POST /api/account/login` now allows **20 failed attempts per 15 minutes per network**.
  Successful sign-ins don't count.
- After that it returns `429 { "message": "Too many failed sign-in attempts, please try again in 15 minutes." }`.
- If the sign-in screen already shows server messages, nothing to do.

---

## 3. B. Buddy on mobile (BB-110) — feature work

**What it is:**
- B. Buddy is a hidden **support admin** that exists in every company.
- BizBuddy support staff sign in with **one shared email** (`bizbuddy@bizsolutions.us`), the shared
  password, and **their own staff code + PIN**.
- On mobile it gets the **Company (admin) panel only**, never the employee features.
- The **single-device lock is skipped** for it, because several staff share the account.

### 3.1 Company picker — `GET /api/account/get-user-email?email=…`

Each account in the list now includes `isSystemAgent`:

```json
{ "userId": "…", "email": "bizbuddy@bizsolutions.us", "username": "bbuddy-…", "companyId": "…",
  "companyName": "Sunshine Learning", "role": "admin", "status": "active", "isSystemAgent": true }
```

- When `isSystemAgent` is true:
  - show an **"Internal"** badge instead of "Admin"
  - use the subtitle **"B. Buddy"**
  - a headset or support icon works well
- **Hide "Forgot your password?"** for it. Its password can only be changed centrally.

### 3.2 Sign-in — `POST /api/account/login`

1. **First request:** send the usual `{ email, password, companyId, deviceId }`. For B. Buddy the
   server answers:

   ```json
   401 { "message": "Enter your staff code and PIN to continue as B. Buddy.", "code": "AGENT_IDENTITY_REQUIRED" }
   ```

2. **Staff code + PIN step:**
   - **Staff code:** text, uppercase, e.g. `BIZ-002`.
   - **PIN:** 6–8 digits, numeric keypad, masked.
3. **Resubmit:** send the same body plus `agentCode` and `agentPin`.

| Response | Meaning | Show |
|---|---|---|
| 200 `{ data: { token } }` | Signed in | Continue (3.3) |
| 401 `AGENT_IDENTITY_INVALID` | Wrong code or PIN, or the staff member was suspended or removed | "Invalid staff code or PIN." Stay on the step. |
| 403 `AGENT_NOT_ASSIGNED` | This staff member isn't assigned to this company | Server `message` ("You're not assigned to this company…") |
| 429 `AGENT_LOCKED` | 5 wrong PINs; locked 15 minutes. `lockedUntil` is in the body. | Server `message`, plus a countdown to `lockedUntil` |

- **Device lock:** no `DEVICE_*` conflict ever happens for B. Buddy. The server ignores the device
  lock for it.
- **Never store the PIN.** Don't offer biometric quick-login or "remember me" for B. Buddy: every
  sign-in should ask for the code + PIN, so the audit trail always knows who is behind it.

### 3.3 After sign-in

- `GET /api/account/profile` returns `user.isSystemAgent: true` (and `role: "admin"`).
- **When true:**
  - Open the **Company panel** directly.
  - **Hide every employee feature:** clock in/out and breaks, my time logs and today's shift, my
    leave / overtime / punch requests / contests, presence, my profile edit, change password, and
    delete account.
  - Show a small **"Signed in as B. Buddy (support)"** banner, so it's never mistaken for a real admin.
- **Push:** don't register a push token, or ignore it. The server doesn't store one for B. Buddy,
  and that isn't an error.
- **Handle these gracefully** (a message, not a crash), in case a screen calls one of these endpoints:
  - `403 SYSTEM_AGENT_NOT_ALLOWED`: an employee-only action. Show *"Not available for B. Buddy."*
  - `403 SYSTEM_AGENT_PROTECTED`: only appears if someone tries to edit B. Buddy itself.

### 3.4 Session can end at any time

The server re-checks the staff member on **every** request. If a system admin suspends, removes or
moves them to another company, the next call returns **401 `TOKEN_VERSION_MISMATCH`**. Use the same
handler as section 1: sign out and show the `message`.

### 3.5 Test

1. **Picker:** `bizbuddy@bizsolutions.us` → the picker shows Sunshine Learning as **Internal**, with
   no "Forgot password".
2. **Sign-in and gating:**
   - Correct password → the staff code + PIN step.
   - Correct code + PIN → the Company panel, with no employee tabs.
3. **Errors:**
   - **Wrong PIN:** "Invalid staff code or PIN." After 5 tries, the locked message.
   - **Code assigned to another company:** "You're not assigned to this company…".
4. **Ending sessions:**
   - **Two phones, same code:** both stay signed in, because there's no device lock.
   - **Suspend the staff member** from the system-admin dashboard → the phone's next action returns to
     sign-in.

---

## 4. Not affected on mobile

- **Web-only changes:** Import Punch Logs, Upload Schedule and the Backtrack import (BB-108).
- **Dashboard-only changes:** the system-admin dashboard (2FA sign-in, Support Staff, Analytics,
  Security, Live Server, Capacity, Add company).
- **Unchanged:** notification payloads, clock-in/out, leave, overtime and punch-request endpoints.
  B. Buddy is filtered out of employee lists on the server, so no mobile filtering is needed.
- **Token rules:** tokens still don't expire for normal users, so no change to saved sessions.

## Ship order

The server deploys first. Section 1 works with the current app as long as it already signs out on
`TOKEN_VERSION_MISMATCH`. Section 3 can ship whenever it's ready: until then, B. Buddy just can't be
used from the phone, and web works.
