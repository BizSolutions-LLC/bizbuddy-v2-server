# Client update — BB-128 Employee Map: three views + initials pins

**Server:** next push (built 2026-11-25). **Web only.** Mobile: no change. **Status:** not sent; build once the server is deployed.

## What changes
The Employee Map page gets **three tabs**. Each tab calls its own endpoint **only when it is opened** (and again when its filters change):

| Tab | Endpoint | Who sees the tab |
|---|---|---|
| Clock-in / out | `GET /api/employee-map/punches` | same as today (admin: company, supervisor: team, employee: self) |
| Routes | `GET /api/employee-map/routes` | same as today |
| Live | `GET /api/employee-map/live` | **admins only** (B. Buddy included). Hide the tab for everyone else; the server answers 404 to them |

The old combined `GET /api/employee-map` still works, unchanged apart from the extra fields below. Switch to the three endpoints; we retire the old one after that.

## Initials pins (all tabs)
Every person in every response now has `initials` ("CC") and `color` ("#2563EB"). The colour comes from the employee, so one person has the same colour on every tab and every load.
Draw pins as a round badge: `color` background, white `initials` (Leaflet `L.divIcon`). Suggested: clock-in = solid badge, clock-out = badge with a white ring, live stale = 50% opacity.
Where it is: `layers.clockIn[]` / `layers.clockOut[]` items and `employees[]` (punches), `tracks[]` (routes), `employees[]` (live).

## 1. Clock-in / out — `GET /api/employee-map/punches`
> 2026-11-26: the site picked for a pin changed slightly. It's now the site the pin is **inside** (if several, the closest center), else the one whose edge is nearest; sites without a radius are only used when no site has one. Before, the nearest **center** was picked first, so a pin inside a big site next to a small one showed as outside. Fields unchanged (`distanceMeters` still to the center).

Same query as today: `date` or `from`/`to` (max 31 days), `type=in|out|both`, `departmentId`, `userId`.
`data` = `{ company, filters, sites, summary: { clockIn, clockOut, employees }, heat, layers: { clockIn, clockOut }, employees }`. This is the old response minus the breadcrumbs.
Suggestion: show initials pins by default; offer the heat map only as a toggle (with 2–3 people a heat blob tells nothing).

## 2. Routes — `GET /api/employee-map/routes`
Query: `date` or `from`/`to`, `departmentId`, `userId`. Routes need one day or one employee, otherwise `tracks` is `null` and `summary.reason` says why.
`data` = `{ company, filters, sites, summary, tracks }`.
- `sites[]`: work-site circles, the same array as `/punches` and `/live` (added 2026-11-25 at the client's request).
- `summary` = the old `summary.breadcrumbs` (`enabled, intervalMinutes, available, reason, tracks, points, mockedPoints, lowAccuracyPoints, suspiciousTracks, truncated`).
- `tracks[]` = the old `layers.breadcrumbs[]` + `initials`, `color`, `lowAccuracyPoints`, `pins`.
- `tracks[].pins` (added 2026-11-25 at the client's request): `{ clockIn, clockOut }`, each `{ lat, lng, at, atLocal, accuracy }` or `null` (no location on that punch, or no clock-out yet). `atLocal` has the same "YYYY-MM-DD h:mm A" format as the `/punches` items; `accuracy` may be null. Draw them at the route ends, and the dashed pin-to-route links from `pinChecks` (red when `suspicious`). A track whose points are all fake GPS still gets `pins` (its `pinChecks` stay null).
- New per point: `points[].lowAccuracy` (accuracy worse than 100 m). It is still drawn and still checked for suspicious movement, but not counted in `distanceMeters`. Suggestion: draw it lighter, and in the popup say "±350 m, not counted in distance".
- `points[].batteryLevel` is now filled when the app sends it, as a **fraction 0–1** (0.42 = 42%).
Optional: a time slider that moves the initials badge along the track (`points[].at`).

## 3. Live — `GET /api/employee-map/live` (admins only)
Query: optional `departmentId`.
Poll every `refreshSeconds` (60) while the tab is open and the browser tab is visible; stop when the tab closes.
`data`:
- `generatedAt`, `refreshSeconds`
- `tracking: { enabled, intervalMinutes, staleAfterMinutes }`. When `enabled` is false, show a banner: "Location tracking is off for this company. Showing clock-in locations only."
- `summary: { clockedIn, live, stale, clockInOnly, noPosition }`
- `sites[]` (same as the other tabs)
- `employees[]`, one per employee **clocked in right now**:
  `{ employeeId, name, initials, color, employeeCode, department, timeLogId, punchType, clockedInAt, clockedInAtLocal, collectUntil, position }`
  - `position` is `null` when there is no location at all. List these in the side panel as "No location yet", with no pin.
  - otherwise `position` = `{ source: "breadcrumb" | "clockIn", lat, lng, accuracy, at, atLocal, ageSeconds, stale, speed, heading, batteryLevel, isMocked, appState }`.
  - Label: "Seen 3 min ago" from `ageSeconds` (re-count it locally between polls). `source: "clockIn"` = "At clock-in, 8:57 AM" (no breadcrumb yet).
  - `stale: true` → faded pin. `isMocked: true` → red outline + "Fake GPS reported by the phone".
  - `batteryLevel` (0–1) when present: small battery icon.
  - **`hereSince`** (added 2026-11-26, client request): ISO time the person arrived at the spot where they are now, or `null`. This drives "here for 1 hr, 20 min". Server rule (100 m radius, same as the client's Routes `STOP_RADIUS_M`):
    - Measure from the **latest accurate** breadcrumb (accuracy ≤ 100 m). The pin itself still shows the latest point, as before.
    - Walk the punch's breadcrumbs backwards; points less accurate than 100 m are skipped. Stop at the first one more than 100 m away. `hereSince` = the time of the point just after it.
    - If the whole punch stayed within 100 m: the clock-in time. If the clock-in pin itself is more than 100 m away (they clocked in somewhere else), use the first breadcrumb's time instead.
    - `source: "clockIn"` (no breadcrumbs yet): the clock-in time.
    - `null` when the punch has breadcrumbs but none of them is accurate.
    - A gap with no points at the same spot counts as "here". A stale position still gets `hereSince`.
  - **`site`** (added 2026-11-26, Live redesign): work-site status, or `null` when the company has no site with a radius or there's no position.
    ```json
    "site": { "id": "cm…", "name": "Kaingin site", "inside": false, "distanceMeters": 210, "since": "2026-11-26T09:40:00.000Z" }
    ```
    - `id` / `name`: the site they're inside. If inside several, the one with the closest center. Otherwise the site whose **edge** is nearest. Only sites with a radius count.
    - `inside`: within that site's radius. Same rule as `/punches` (`insideSite`), so both tabs agree.
    - `distanceMeters`: distance to the site's **edge** ("210 m outside"); always `0` when inside. Note that `/punches`' `distanceMeters` is to the site's **center**.
    - `since`: when the current state began. States are "inside site X" (each site its own state: Main office → Kaingin restarts the time) or "outside" (whatever site is nearest). Same walk-back as `hereSince`: from the latest accurate point, skipping points less accurate than 100 m.
      - Same state the whole punch: the clock-in time (or the first breadcrumb if the clock-in pin was in a different state).
      - `source: "clockIn"`: the state of the clock-in pin, `since` = clock-in time.
      - No accurate point: the state from the latest point, `since: null`.
    - Stale position: the last known state (show it as last known). A Locate now answer updates it on the next poll.
- People who clock out drop off at the next poll. Nobody is ever shown after clock-out.
Side panel: list `employees[]` sorted by name; clicking one centres the map on their pin.

## 3b. Locate now (added 2026-11-26)
The admin clicks an employee's initials (pin or side panel), or **Refresh**, to ask the phone(s) for a fresh location. The **stale pin stays on the map as the backup** while waiting. It's silent for the employee: they see nothing. The server only sends it to people clocked in right now.

Needs the matching mobile app version (`docs/mobile-update-BB-128-locate-now.md`). Until then, requests go out but end as `no_answer`.

### Endpoints (admins / superadmins only, B. Buddy included; 404 for anyone else, like `/live`)
**One employee:** `POST /api/employee-map/live/:employeeId/locate` (no body). `:employeeId` = `employees[].employeeId` from `/live`.
```json
{ "data": {
  "employeeId": "cm…", "timeLogId": "cm…",
  "sent": true, "reused": false, "reason": null,
  "locate": { "requestId": "loc_…", "status": "pending", "requestedAt": "…", "expiresAt": "…", "answeredAt": null }
} }
```
`reason` when `sent` is false:
| `reason` | Meaning | What to show |
|---|---|---|
| `cooldown` | asked less than 30 s ago; `locate` is that running request (`reused: true`) | keep showing it, no error |
| `no_device` | the employee has no registered phone (never signed in on the app) | "No phone registered, showing last known location" |
| `push_failed` | the push service refused it (`locate.status: "not_sent"`) | "Couldn't reach the phone, showing last known location" |
| `rate_limited` | this admin sent 200 requests in 10 min | "Too many requests, try again in a few minutes" |

**Refresh (everyone clocked in):** `POST /api/employee-map/live/locate`, body `{ "departmentId": "…" }` optional (send the Live filter's department).
```json
{ "data": {
  "clockedIn": 12, "requested": 12, "skippedOverCap": 0,
  "sent": 10, "reused": 1, "noDevice": 1, "failed": 0, "rateLimited": 0,
  "results": [ { "employeeId": "…", "timeLogId": "…", "sent": true, "reused": false, "reason": null, "locate": { … } } ]
} }
```
At most 50 phones per click (`skippedOverCap` = the rest). Toast: "Locating 10 people…" (+ "1 without a phone").

Errors (both endpoints): 409 `message` when the employee isn't clocked in, location tracking is off for the company, or the company is inactive. 404 for non-admins.

### What `/live` adds
- `employees[].locate`: `null` (no request in the last 10 min), or `{ requestId, status, requestedAt, expiresAt, answeredAt }`. `status` is:
  - `pending`: waiting for the phone, up to 60 s;
  - `answered`: a fresh point arrived, and `position` is already the new one;
  - `no_answer`: 60 s passed with nothing;
  - `not_sent`: the push failed.
- `tracking.locateAnswerSeconds` (60).
- `position.appState` can now also be `"locate"` (the point came from Locate now).

### Suggested UI
1. **Click initials / Refresh:** call the endpoint and keep the current pin. Add a pulsing ring + "Locating…" in the bubble or side panel.
2. **While any `locate.status === "pending"`:** poll `GET /live` every **5 s** (instead of 60 s), and stop at `expiresAt` + 5 s. Then go back to the 60 s poll.
3. **`answered`:** move the pin (the new `position`). Short "Updated just now" flash; "Seen …" and "here for" come from the new point.
4. **`no_answer` / `not_sent`:** keep the old pin. Show "Phone didn't answer, showing last known location (seen 1 h 29 min ago)" in the bubble until the next click.
5. **Refresh button:** in the Live header next to the filters. Disable it for 30 s after a click (the server ignores repeats inside 30 s anyway).
6. **"here for" on a stale position:** count it only up to `position.at` (not to now), or show "Last seen here …". All we know is that the person was there until the last point.

The employee never sees anything, so no other copy is needed.

## Errors
`{ message }`. 400 = bad date/type/range, 403 = an employee asking for someone else, 404 = Live for a non-admin.
