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
- People who clock out drop off at the next poll. Nobody is ever shown after clock-out.
Side panel: list `employees[]` sorted by name; clicking one centres the map on their pin.

Not in this round: a "Locate now" button (asks the phone for a fresh location). It comes later and will feed the same response.

## Errors
`{ message }`. 400 = bad date/type/range, 403 = an employee asking for someone else, 404 = Live for a non-admin.
