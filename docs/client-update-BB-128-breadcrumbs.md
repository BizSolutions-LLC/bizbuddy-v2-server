# Client update — BB-128 part 2: GPS breadcrumbs on the Employee Map

**Server:** next push (version chosen at `/push`). **Web** (Company Settings + Employee Map). **Mobile:** separate hand-off, `docs/mobile-update-BB-128-breadcrumbs.md`. **Status:** built 2026-11-18; section 2b added 2026-11-20 (not sent yet). **Database change:** yes (user runs `scripts/add-location-breadcrumbs.sql` → `prisma generate` → deploy).

Part 1 (`docs/client-update-BB-128.md`) is unchanged. The `layers.breadcrumbs` slot it reserved is now filled.

## 1. Company Settings (admin)
`GET` / `PATCH /api/company-settings`, two new fields:

| Field | Type | Default | Rule |
|---|---|---|---|
| `breadcrumbsEnabled` | boolean | `false` | Turns tracking on for the whole company |
| `breadcrumbIntervalMinutes` | integer | `5` | 1–60, otherwise 400 |

Suggested label: **"Track location during shifts"**. Help text: *"The mobile app records each employee's location every N minutes, only while they're clocked in. Routes are kept for 90 days."*

When switching it on, show a reminder: *"Tell your employees before turning this on."* (California: continuous location is personal information and needs notice. Suggested notice in section 4.)

## 2. Employee Map: route layer
Same endpoint, `GET /api/employee-map`. No new parameters.

**Routes appear when you ask for one day (`date`, or `from` = `to`) or one employee (`userId`).** For a wider range across many employees, `layers.breadcrumbs` is `null` and `summary.breadcrumbs.available` is `false`. Show the `reason` text ("Pick one day or one employee to see routes.").

`data.layers.breadcrumbs`: one track per punch.
```json
[
  {
    "timeLogId": "cuid",
    "employeeId": "cuid",
    "employeeName": "Jane Doe",
    "department": "Drivers",
    "startedAt": "2026-11-18T15:02:00.000Z",
    "endedAt": "2026-11-18T23:01:00.000Z",
    "pointCount": 96,
    "mockedPoints": 0,
    "distanceMeters": 18420,
    "gaps": [ { "from": "…", "to": "…", "minutes": 42 } ],
    "points": [
      { "at": "…", "atLocal": "2026-11-18 7:07 AM", "lat": 37.77, "lng": -122.41,
        "accuracy": 12, "speed": 1.3, "batteryLevel": 0.64, "isMocked": false }
    ]
  }
]
```
`data.summary.breadcrumbs`:
```json
{ "enabled": true, "intervalMinutes": 5, "available": true, "reason": null,
  "tracks": 14, "points": 1290, "mockedPoints": 3, "truncated": false }
```

Suggested display:
- A **"Routes"** toggle next to Clock-in / Clock-out / Heat.
- **Route line:** a polyline per track in time order, coloured per employee. Start and end dots; the clock-in / clock-out pins from part 1 already sit at the ends.
- **Fake GPS:** `isMocked` points drawn in a warning colour (⚠ "Fake GPS reported by the phone"). Show `mockedPoints` on the track's row.
- **Gaps:** no points for 3× the interval or more (phone off, no signal, permission removed). Draw the segment dashed and list it ("No location 9:10–9:52 AM").
- **Track list** (side panel): employee, time span, distance (km/mi), points, gaps, fake-GPS count.
- **Hover a point:** `atLocal`, accuracy, speed, battery.
- **`truncated: true`:** only the first 50,000 points came back; ask the user to narrow to one employee.
- **`enabled: false` and no tracks:** "Location tracking is off. Turn it on in Company Settings."

## 2b. Suspicious movement (added 2026-11-20, send this section as an update)
The phone doesn't always report a faked location (the "Fake GPS" flag can be missed or hidden), so the server also checks **speed**. Anything implying **more than 120 mph over more than 1 km** is flagged as suspicious. Nothing is rejected; it's a warning for the supervisor, like Fake GPS.

New fields on each track in `layers.breadcrumbs`:
```json
{
  "suspicious": 2,
  "jumps": [
    {
      "from": { "at": "2026-11-20T09:38:00Z", "lat": 37.33, "lng": -122.03 },
      "to":   { "at": "2026-11-20T09:39:00Z", "lat": -33.86, "lng": 151.21 },
      "meters": 11948000, "seconds": 60, "mph": 445000, "kmh": 716900
    }
  ],
  "pinChecks": {
    "clockIn":  { "meters": 120, "seconds": 240, "mph": 1, "kmh": 2, "suspicious": false },
    "clockOut": { "meters": 11950000, "seconds": 60, "mph": 445400, "kmh": 716900, "suspicious": true }
  },
  "points": [ { "…": "…", "jumpedHere": true } ]
}
```
- `jumps`: each impossible move between two route points. The distance of a jump is **not** added to `distanceMeters`.
- `points[].jumpedHere: true`: the point was reached by an impossible move. Draw the segment **into** this point dashed and red, not as a normal route line.
- `pinChecks.clockIn`: clock-in pin → first route point. `pinChecks.clockOut`: last route point → clock-out pin. `null` when the pin or the route is missing. `suspicious: true` means the route doesn't connect to the punch.
- `mph` / `kmh` are `null` when both moments have the same time (an instant jump).
- `suspicious`: count of jumps + suspicious pin checks for the track. `summary.breadcrumbs.suspiciousTracks`: how many tracks have any.

Suggested UI:
- Track list: a red warning badge "⚠ Suspicious movement (2)" when `suspicious > 0`; tooltip lists each jump ("4,862 mi in 1 min").
- Map: jump segments dashed red. Optional: a faint dashed line from the clock-in pin to the first point and from the last point to the clock-out pin (red when that pin check is suspicious).
- Also: draw route Start/End with the legend's markers (hollow / black) and a colour that is not the clock-out blue, so the route isn't confused with clock-out pins.

## 3. Employees can now open the map (own data only)
**Contract change:** an employee (not supervisor or admin) calling `GET /api/employee-map` used to get **403**. Now they get **200 with only their own** punches and route. Asking for another `userId` still returns 403.

If the web shows the Employee Map only to supervisors and admins, nothing breaks. Optionally add "My locations" for employees later.

## 4. Employee notice (for the company admin)
Suggested text: *"When location tracking is on, the BizBuddy mobile app records your location every few minutes, only while you are clocked in. It stops when you clock out. Your supervisor and company administrators can see the route, and so can you. Locations are deleted after 90 days."*

## Not included (possible later)
- Alerts (e.g. left the work site during the shift).
- Exporting routes (PDF / Excel).
- A per-company retention setting (fixed at 90 days).
