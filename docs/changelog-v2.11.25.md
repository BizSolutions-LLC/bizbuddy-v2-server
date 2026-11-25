# Changelog — v2.11.25

**Branch:** `release/v2.11.25` (pushed 2026-11-25), from `origin/master` (after PR #139).

**Tickets:**
- BB-128 breadcrumb DB review: read-only DB check script, `batteryLevel` saved, one insert per upload, low-accuracy points left out of the route distance. **Awaiting test.** The check script was already run by the user (2026-11-25: 120 points, 0.2 MB, 76% background, 92% within 20 m).
- BB-128 map views: Employee Map split into three tabs that load separately (Clock-in/out, Routes, Live) + initials pins; `/routes` also returns punch pins + work sites (client request). **Awaiting test.**

**Schema change:** NO. **Env:** none. **Data scripts to run after deploy:** none.
**Client impact:** yes, additive only. Hand-off `docs/client-update-BB-128-map-views.md` (three tabs, initials pins, Live polling, low-accuracy points, battery 0–1, `tracks[].pins`, `sites` on `/routes`). Not sent. The old combined `GET /api/employee-map` keeps working until the client switches.
**Mobile impact:** none required. Ask the mobile dev which scale the app sends for `batteryLevel` (0–1 or 0–100); the server stores 0–1 and reads values above 1 as a percentage.

---

# BB-128 — GPS breadcrumb DB review

- **What:** the user asked how the breadcrumb table looks. Verdict: the design is sound (one row per point, cascades with the punch, the unique (timeLogId, recordedAt) stops double saves, indexes cover the map and the 90-day cleanup). Four gaps were fixed:
  - **A. Read-only check:** `scripts/check-bb128-breadcrumb-db.js` (raw SQL): table/index size and share of the DB, per company (rows, punches, employees, oldest/newest, points per punch, MB), rows per day, accuracy buckets, foreground/background, fake GPS, battery filled, upload delay, points older than 90 days.
  - **B. `batteryLevel` saved:** it was never stored (always null). Now stored as a fraction 0–1; a value above 1 is read as a percentage, exactly 1 = full; anything else → null.
  - **C. One insert per upload:** an upload wrote up to 50 rows one by one. Now duplicates are found up front (already stored or repeated in the batch) and the new rows go in one `createMany({ skipDuplicates })`. Each sample still gets saved / duplicate / rejected, so the mobile contract is unchanged. An upload now saves all its points or none (before, a failure halfway left some saved).
  - **D. Low accuracy:** points with an accuracy radius over 100 m are still shown and still checked for impossible travel, but no longer added to `distanceMeters` (GPS drift). `points[].lowAccuracy`, `lowAccuracyPoints` per track and in the summary.
- **Changes:**
  - `src/services/Locations/locationBreadcrumbRules.js`: `cleanBatteryLevel`.
  - `src/services/Locations/locationBreadcrumbService.js`: batch insert, battery.
  - `src/services/Locations/breadcrumbService.js`: accuracy rule (`LOW_ACCURACY_METERS = 100`; a jump also restarts the distance from the new point).
  - `scripts/check-bb128-breadcrumb-db.js` (new, read-only).
- **Endpoints:** none new; `POST /api/timelogs/location-breadcrumbs` responds the same.
- **Open questions:** battery scale (mobile dev). Coverage is still thin (about 18 points per punch at BizSolutions LLC, 3 at Sunshine Learning); the Nov 27 interval check (`scripts/check-bb128-breadcrumb-intervals.js --from 2026-11-24 --to 2026-11-27`) decides the mobile follow-up.

# BB-128 — Employee Map: three views + initials pins

- **What:** the map answered every question as "what happened over a period", with a heat map that says little for 2–3 people. User decisions: three views (Clock-in/out, Routes, Live), each loaded only when its tab opens; Live = last known position now (3a), "Locate now" with a silent push later (3b); Live for admins and B. Buddy only, no supervisors yet; initials pins like Life360.
- **Changes:**
  - `src/services/Locations/mapPeople.js` (new): `initials` + `color` per person (colour from the user id, same on every tab).
  - `src/services/Locations/employeeMapService.js`: split into `buildPunchMap` / `buildRoutesMap` over a shared context (company, filters, scope); shared `loadSites`; the combined `buildEmployeeMap` returns the same shape as before (+ the new fields).
  - `src/services/Locations/liveMapService.js` (new): open punches (no clock-out, clock-in within 24 h), one per employee, latest breadcrumb per punch in one `DISTINCT ON` query, else the clock-in pin; `stale` after 3× the interval; `collectUntil` from LiveUser.
  - `src/services/Locations/breadcrumbService.js`: tracks get `initials`, `color` and `pins { clockIn, clockOut }` (client request: punch pins at the route ends, null = no location or still open; also set when every point is fake GPS).
  - `src/controllers/Features/employeeMapController.js`, `src/routes/Features/employeeMapRoutes.js`: three routes.
  - `docs/CLAUDE.md`: route table row.
- **Endpoints:**
  - `GET /api/employee-map/punches`: same query and scope as today (admin company, supervisor department + direct reports, employee self).
  - `GET /api/employee-map/routes`: same query and scope; `{ company, filters, sites, summary, tracks }`.
  - `GET /api/employee-map/live[?departmentId]`: admins + superadmins (B. Buddy included), 404 for anyone else; `{ generatedAt, refreshSeconds: 60, tracking, sites, summary, employees[].position }`.
  - `GET /api/employee-map`: unchanged (kept until the client switches).
- **Privacy:** Live lists only punches with no clock-out and reads only points inside them, so nobody is shown after clocking out. California companies should tell employees in writing that location is tracked while they are on the clock.
- **Order of steps:** merge → deploy → send `docs/client-update-BB-128-map-views.md`.
- **Open questions:** retire the combined endpoint once the client has switched; "Locate now" (3b) needs a mobile release; supervisors on Live later if wanted.
