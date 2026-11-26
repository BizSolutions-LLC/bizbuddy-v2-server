# Mobile update: BB-128 phase 3b, "Locate now" for the Live map

**From:** bizbuddy-v2-server
**For:** the BizBuddy mobile app (iOS + Android)
**Ticket:** BB-128 (Employee Map, Live tab)
**Server status:** built 2026-11-26 (uncommitted), available in dev after the next deploy; production after the next server release. The server already sends the push and accepts the `locate` sample below.

**One new thing:** when the app receives a silent `LOCATE_REQUEST` push, it takes **one** fresh location and uploads it with the breadcrumb upload you already have. Nothing else changes: clock-in, clock-out, the interval breadcrumbs and `collectUntil` work exactly as today.

> **Don't change the session, token or biometric handling as part of this.** That area is still under investigation. Leave it exactly as it is.

---

## Why
On the web Live map, an admin sees where each clocked-in employee was **last seen**. When the last point is old (stale), the admin can now click the employee's initials, or **Refresh** for everyone, to ask the phone for its current location. The web keeps showing the old pin as a backup while it waits, then moves the pin when the fresh point arrives.

## Rules (decided by the business)
- **Silent.** The employee sees nothing: no banner, no sound, no in-app message, no inbox item. They are clocked in and working; this is part of work-time location tracking.
- **Only while clocked in.** The server sends a request only for an open punch (clocked in less than 24 h ago). The app must also ignore a request when it has no open punch, or when the punch is past `collectUntil`. **Never send a location after clock-out.**
- Every request is recorded on the server (who asked, when, for whom).

---

## 1. The push the app receives
A **data-only** FCM message (no `notification` block, so the OS shows nothing):

```json
{
  "data": {
    "type": "LOCATE_REQUEST",
    "requestId": "loc_8f2c1a…",
    "timeLogId": "cm…",
    "companyId": "cm…",
    "expiresAt": "2026-11-26T10:01:00.000Z"
  }
}
```
All values are strings (FCM rule). The server sends it with:
- **Android:** `priority: "high"`, so a data message can wake the app.
- **iOS:** `content-available: 1`, `apns-push-type: background`, `apns-priority: 5` (what Apple requires for background pushes).

It arrives on the same device token you already register (`User.deviceToken`, sent at sign-in). There's no new registration.

When it is sent:
- An admin clicks the employee's initials on the Live map, or presses Refresh (everyone clocked in, up to 50 phones).
- Only for an open punch (clocked in less than 24 h ago), with location tracking on for the company (`breadcrumbsEnabled`).
- At most once per employee per 30 s.
- `expiresAt` = 60 s after the request. After that the web shows "didn't answer", so a late fix is still saved as a normal point but no longer counts as the answer.

## 2. What the app does
1. Check `data.type === "LOCATE_REQUEST"`.
2. Ignore it if:
   - `timeLogId` isn't the punch currently open on this phone;
   - the punch is past `collectUntil`;
   - the employee is clocked out;
   - `expiresAt` has passed.
3. Get **one** location fix: high accuracy, timeout about **20 s**. Use the cached last-known fix only if it's under 30 s old.
4. Upload it right away (don't wait for the next interval batch) with the existing endpoint.

### `POST /api/timelogs/location-breadcrumbs` (existing)
Same body as the interval upload. One sample, with `source: "locate"` and the `requestId`:

```json
{
  "samples": [
    {
      "timeLogId": "cm…",
      "latitude": 14.7012,
      "longitude": 120.9634,
      "recordedAt": "2026-11-26T10:00:12.000Z",
      "accuracy": 8,
      "speed": 0,
      "heading": null,
      "batteryLevel": 0.82,
      "isMocked": false,
      "source": "locate",
      "requestId": "loc_8f2c1a…"
    }
  ]
}
```
- `recordedAt` = the time of the fix (not the time of the push).
- The response is per sample, as today: `saved` | `duplicate` | `rejected` (+ `reason`). `saved` and `duplicate` both count as the answer.
- `source` now accepts `"foreground"`, `"background"` or `"locate"`. Anything else is stored as empty.
- Same rules as every sample: the company must have tracking on (else 403 `BREADCRUMBS_DISABLED`), and `recordedAt` must be after clock-in and not after clock-out.
- No retry loop: if the upload fails, the point can go out with the next normal batch, without `requestId`.
- If no fix comes within the timeout, send nothing. The web shows "Phone didn't answer, showing last known location" after about 60 s.

## 3. Platform notes
- **Android:**
  - Handle the data message in the messaging service, even with the app in the background.
  - Use the foreground location service you already use for interval tracking (or a short one-off) to get the fix.
  - A force-stopped app receives nothing; that's expected.
- **iOS:**
  - Background pushes need the **Remote notifications** background mode, and they are **best effort**: iOS rate-limits them and drops them if the user swiped the app away.
  - We accept that for now; the web falls back to the last known pin.
  - If it proves unreliable in practice, the next step is Apple's **Location Push Service Extension** (needs the `com.apple.developer.location.push` entitlement requested from Apple). **Not** part of this change.
- **Battery:** one fix per request. The server limits requests to one per employee per 30 s.

## 4. Related check (not new, but please confirm)
Interval breadcrumbs should keep going while the app is in the **background** during a punch (until `collectUntil`). The 2026-11-24 check showed points arriving only while the app was open on screen. "Locate now" is a backup, not a replacement for background tracking, so please confirm in the next build:
- iOS: "Always" permission + `allowsBackgroundLocationUpdates`.
- Android: foreground service with the location type, and the battery-optimisation exemption prompt.

## 5. Older app versions
Nothing breaks: an app that doesn't know `LOCATE_REQUEST` ignores the message (no `notification` block, so nothing is shown). The web just shows "Phone didn't answer" for those phones.

## Questions back to the server side
1. Which app version will include this? Please tell us so the web can explain "didn't answer" on older phones.
2. Does iOS currently register for remote notifications with the background mode on?
3. Any objection to the 20 s fix timeout / 30 s cached-fix rule?
