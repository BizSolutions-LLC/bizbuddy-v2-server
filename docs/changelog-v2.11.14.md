# Changelog — v2.11.14

**Branch:** not created yet (uncommitted). **Tickets:** BB-128 part 1 (Employee Map): **COMPLETE 2026-11-16** (user confirmed). **Schema change:** none. **Client:** web, see `docs/client-update-BB-128.md` (not sent yet: server first). Mobile: no change.

---

# BB-128 — GPS Breadcrumbs: part 1, Employee Map

## What
BB-128 is GPS breadcrumbs: following an employee's location during the shift. Collecting that needs the mobile app (background location), so it waits for the mobile developer.

Part 1 is the **Employee Map**: where employees clock in and clock out on a chosen date, drawn as a heat map plus individual points, with the company's work sites. It uses the location the apps already save on each punch (`TimeLog.location.start` / `.end`). Nothing new is collected or stored.

The response already has `layers.breadcrumbs` (always `null` for now), so part 2 adds a layer without changing the page's contract.

## Changes
- `src/services/Locations/employeeMapService.js` (new): read-only.
  - **Date filter:** `date` (one day, default today) or `from`/`to` (max 31 days), in the company zone. A clock-in counts on the day of its timeIn, a clock-out on the day of its timeOut.
  - **Other filters:** `type` = `in` | `out` | `both`; `departmentId`; `userId`.
  - **Scope:** admins see the whole company; supervisors see their department and direct reports; everyone else gets 403. B. Buddy is hidden (`HUMAN_ONLY`).
  - **Coordinates:** reads `latitude`/`longitude` (also `lat`/`lng`) and `accuracy` when present. Skips missing, out-of-range and 0,0 values, and counts them as "without location".
  - **Heat layer:** clock-ins and clock-outs grouped on a ~11 m grid (4 decimals), `{ lat, lng, weight }`.
  - **Points:** one per punch, with employee, time, punch type, accuracy, and the nearest work site with the distance and whether the punch is inside its radius.
  - **Summary per layer:** punches, with location, without location, and outside every site (null when the company has no sites). There is also a per-employee count.
- `src/controllers/Features/employeeMapController.js`, `src/routes/Features/employeeMapRoutes.js` (new), mounted at `/api/employee-map` in `src/routes/index.js`.

## Endpoint
`GET /api/employee-map?date=YYYY-MM-DD&type=in|out|both&departmentId=&userId=` (or `from=&to=` in place of `date`)

```
data: {
  company:  { id, name, timeZone },
  filters:  { from, to, type, departmentId, userId },
  sites:    [{ id, name, latitude, longitude, radius }],
  summary:  { clockIn:  { punches, withLocation, withoutLocation, outsideSites } | null,
              clockOut: { … } | null,
              employees },
  heat:     [{ lat, lng, weight }],
  layers:   { clockIn:  [{ timeLogId, type: "in", at, atLocal, punchType, employeeId, employeeName,
                           department, lat, lng, accuracy, siteId, siteName, distanceMeters, insideSite }],
              clockOut: [ … type: "out" … ],
              breadcrumbs: null },
  employees: [{ id, name, employeeId, department, clockIns, clockOuts, withoutLocation }]
}
```
Errors are `{ message }`: 400 bad date / type / range, 403 role.

## Run order
No SQL and no `prisma generate`. Deploy, then the web client builds the page from `docs/client-update-BB-128.md`.

## Test (user)
- As admin, today, `type=both`: points match the day's punches. Check one punch's lat/lng against `TimeLog.location`.
- `type=in` → only `layers.clockIn` filled and `summary.clockOut` null; `type=out` → the reverse.
- A night punch (clock-in one day, clock-out the next): the clock-in shows on the first date, the clock-out on the second.
- A punch with no location (admin-entered, imported, auto clock-out) → counted in `withoutLocation`, not on the map.
- A company with work sites: a punch inside the radius → `insideSite: true`; far away → `false`, and counted in `outsideSites`.
- As supervisor: only their department and direct reports. As employee → 403.
- `from`/`to` 32 days apart → 400. `type=x` → 400. A bad date → 400.
- B. Buddy's own punches never appear.

## Notes
- **Privacy:** the points show each employee's exact punch location, and remote workers may punch from home. Access is limited to supervisors (their team) and admins.
- **Not in this version:** breadcrumbs (part 2, needs mobile).
