# Client update — BB-128 Employee Map (part 1 of GPS Breadcrumbs)

**Server:** v2.11.14. **Web only.** Mobile: no change for now. **Status:** server first. Build this once the server is deployed.

## What it is
A new **Employee Map** page that shows where employees clocked in and out on a chosen date: a heat map of the busy spots, individual punch points, and the company's work sites. Breadcrumbs (location during the shift) come later as one more layer on this same page.

## Who sees it
Supervisors (their department and direct reports) and admins. Employees get 403, so hide the menu item for them.

## Data
`GET /api/employee-map?date=YYYY-MM-DD&type=in|out|both&departmentId=&userId=`
- `date` defaults to today (company zone). For a range, use `from=&to=` instead (max 31 days).
- `type` defaults to `both`.

Response `data`:
- `sites[]`: `{ id, name, latitude, longitude, radius }`. Draw each as a circle (radius in metres; may be null, then show a pin).
- `heat[]`: `{ lat, lng, weight }`. Feed straight into a heat-map layer.
- `layers.clockIn[]` / `layers.clockOut[]`: one point per punch: `{ timeLogId, at, atLocal, punchType, employeeId, employeeName, department, lat, lng, accuracy, siteName, distanceMeters, insideSite }`. Popup suggestion: name, "Clock-in 8:57 AM" (`atLocal`), site name or "Outside work sites (1.2 km from Main Office)", accuracy "±15 m" when present.
- `layers.breadcrumbs`: always `null` for now (part 2). Leave room for a toggle later.
- `summary.clockIn` / `summary.clockOut`: `{ punches, withLocation, withoutLocation, outsideSites }` (null for the type not asked for). Show as small stat tiles. **Show `withoutLocation`** ("12 punches have no location: entered by an admin, imported, or location was off") so the map isn't misread as complete.
- `employees[]`: `{ id, name, employeeId, department, clockIns, clockOuts, withoutLocation }`. Use it for an employee filter/side list. Selecting one re-calls with `userId`.
- `company.timeZone`: show times in this zone, not the browser's (`atLocal` is already formatted).

Errors: `{ message }`. 400 = bad date/type/range, 403 = role.

## Page (suggestion)
- Filters: date picker (single day by default), Clock-in / Clock-out / Both toggle, department, employee.
- Map: heat layer by default, with a switch to show individual points (colour clock-in vs clock-out differently). Show work-site circles always.
- Map library: client's choice. Leaflet + leaflet.heat + OpenStreetMap is free; Google Maps needs an API key and billing.

## Privacy
Points show exact punch locations (possibly someone's home for remote staff). Keep the page to supervisors/admins, and don't cache the response in shared storage.
