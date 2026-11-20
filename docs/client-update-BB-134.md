# Client update — BB-134 Device proof on clock-in / clock-out

**Server:** next push (version chosen at `/push`). **Web** (Company Settings + punch-log views) and **Mobile** (send `deviceId` on punches). **Status:** built 2026-11-18. **Database change:** one new company setting (user runs `scripts/add-company-punch-device-proof.sql` → `prisma generate` → deploy).

## Why not the MAC address
The client asked for the employee's phone MAC address at clock-in and clock-out. Modern phones don't give it to apps:
- iPhones always return `02:00:00:00:00:00`.
- Android 10+ returns a random one per Wi-Fi network.
- Browsers can't read it at all.

So the server records what the MAC was meant to prove: **which device sent the punch, whether it's the employee's registered phone, and when the server actually received it.** All of it is written by the server, not by the app, so the employer and the employee can both rely on it.

## Company setting (off by default)
`GET` / `PATCH /api/company-settings` → new field `punchDeviceProofEnabled` (boolean, default `false`, admin only).
- **Off:** punches work exactly as before.
- **On:** every **new** clock-in/out gets a proof. It's optional: a missing device ID or a different phone **never blocks** a punch, and hours, approvals and payroll don't use it. Old punches are not changed.

Suggested label: **"Record punch device"**. Help text: "Saves which phone or browser each clock-in and clock-out came from, and the time our server received it."

## Mobile — what to send
`POST /api/timelogs/time-in` and `POST /api/timelogs/time-out`: add **`deviceId`** to the body. Use the same value the app already sends to sign-in.
```json
{ "localTimestamp": "...", "deviceInfo": { ... }, "location": { ... }, "deviceId": "<same id as sign-in>" }
```
- Send it always. The server ignores it when the company has the setting off, so the app doesn't need to read the setting.
- Until the app sends it, app punches still get a proof with `deviceMatch: null`.
- Don't send a `proof` key inside `deviceInfo`: the server drops it and writes its own.

## Web — where the proof is
Stored in `TimeLog.deviceInfo.start.proof` (clock-in) and `deviceInfo.end.proof` (clock-out). `GET /api/timelogs` (company list) now also returns them as **`proofIn`** and **`proofOut`** (`null` when the setting was off at the time, or on older punches). `deviceIn` / `deviceOut` are unchanged and also include the `proof` key.
```json
"proofIn": {
  "deviceId": "A1B2-...",
  "registeredDeviceId": "A1B2-...",
  "deviceMatch": true,
  "serverReceivedAt": "2026-11-18T15:02:11.384Z",
  "ipAddress": "203.0.113.24",
  "userAgent": "BizBuddy/1 CFNetwork/1498 Darwin/24.0.0",
  "source": "app"
}
```
| Field | Meaning |
|---|---|
| `deviceMatch` | `true` = the employee's registered phone · `false` = a different phone · `null` = nothing to compare (web, no ID sent, or no phone registered yet) |
| `serverReceivedAt` | Server clock when the punch arrived. The punch time itself (`timeIn`/`timeOut`) still comes from the device. A big gap between the two is worth a look. |
| `source` | `app` · `web` · `other` (from the user agent) |
| `ipAddress` | Public network address the punch came from (not the phone's MAC) |

Suggested display on the punch-log row / details:
- **Device:** ✓ Registered phone / ⚠ Other phone / Web / — (from `deviceMatch` + `source`)
- **Received by server:** `serverReceivedAt` in the company zone
- **IP:** `ipAddress` (details only)

## Employee notice (for the company admin)
Employees are in California, where device IDs and IP addresses count as personal information. Before switching the setting on, the company should tell employees. Suggested text: *"When you clock in or out, BizBuddy records the device you used, its network address and the time our server received the punch. This confirms that your punches are genuine and protects both you and the company."*

## Not included (possible later)
- Blocking punches from an unregistered phone.
- A "Device verified" column in the Punch Logs PDF / Excel report.
