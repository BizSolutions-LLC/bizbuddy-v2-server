# Mobile update — BB-134 Device proof on clock-in / clock-out

**From:** bizbuddy-v2-server
**For:** the BizBuddy mobile app (iOS + Android)
**Ticket:** BB-134
**Server status:** built 2026-11-18, available in dev. Production after the next server release.

One small change: **send `deviceId` with every clock-in and clock-out.** Nothing else changes, and nothing breaks if an older app version doesn't send it.

> **Don't change the session, token or biometric handling as part of this.** That area is still under investigation. Leave it exactly as it is.

---

## Background
A client asked to record the employee's phone **MAC address** on each punch, so the employer and the employee both have proof the punch came from the employee's own phone and wasn't tampered with.

**Please don't try to read the MAC.** iOS always returns `02:00:00:00:00:00`, and Android 10+ returns a random value per Wi-Fi network, so it proves nothing. Instead, the server compares the phone's **device ID** (the one the app already sends at sign-in) with the phone registered to the account.

## The change

### `POST /api/timelogs/time-in` and `POST /api/timelogs/time-out`
Add **`deviceId`** to the JSON body, next to the fields you already send:

```json
{
  "localTimestamp": "2026-11-18T07:02:11-08:00",
  "deviceInfo": { "platform": "ios", "manufacturer": "Apple", "model": "iPhone 15" },
  "location": { "latitude": 37.77, "longitude": -122.41 },
  "deviceId": "<exactly the same value sent as deviceId to POST /api/account/login>"
}
```

Rules:
1. **Same value as sign-in.** It must be identical to the `deviceId` the app sends to `/api/account/login` (same source, same format, no prefix). If it differs even slightly, every punch shows as "different phone".
2. **Always send it**, on both clock-in and clock-out, including auto/offline punches the app sends later. The app doesn't need to check any company setting: the server ignores it when the company has the feature off.
3. **Top level of the body**, not inside `deviceInfo`.
4. **Don't put a `proof` key inside `deviceInfo`.** The server removes it and writes its own.
5. A string; the server trims spaces. If the app has no ID, leave the field out (don't send `"unknown"`).

### Responses
No change. Status codes, messages and the response body stay the same. **A punch is never refused** because of the device ID (missing, different phone, anything).

## What the server records (for your information)
When the company has **"Record punch device"** on, each punch saves this inside `deviceInfo.start.proof` (clock-in) / `deviceInfo.end.proof` (clock-out):

| Field | Meaning |
|---|---|
| `deviceId` | What the app sent |
| `registeredDeviceId` | The phone registered to the account at sign-in |
| `deviceMatch` | `true` same phone · `false` different phone · `null` nothing to compare |
| `serverReceivedAt` | Server time when the punch arrived |
| `ipAddress`, `userAgent`, `source` | Network address, app/browser info, `app` / `web` / `other` |

The app doesn't need to show any of this. If you show punch history in the app and want to, `deviceMatch` is the one to use (e.g. a ✓ "Registered phone" badge).

## How to test (dev)
Ask the web admin to switch on **Record punch device** for the test company, then:
1. Sign in on phone A, clock in and out → `deviceMatch: true` on both.
2. Clock in/out with an older build that doesn't send `deviceId` → punch works, `deviceMatch: null`.
3. Turn the setting off → punch works, no proof saved.

The web team sees the result in the punch logs (`proofIn` / `proofOut` on `GET /api/timelogs`).

## Questions for the mobile dev
1. What is the `deviceId` source today on iOS and Android (e.g. `identifierForVendor`, Android ID, a UUID saved on first launch)? Does it survive an app reinstall or update?
2. Do offline punches get sent later? If so, can they carry the same `deviceId`?
