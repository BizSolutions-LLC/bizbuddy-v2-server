# Changelog — v2.11.26

**Branch:** `release/v2.11.26` (pushed 2026-11-26), from `origin/master` (after PR #140).

**Tickets:**
- BB-151 Company Settings history + admin-only guards on settings changes. **Complete** (user: "seems fine"; SQL already run, client UI done).
- BB-128 Live "here for" (`position.hereSince`, client request). **Awaiting test.**
- BB-128 Live redesign, work-site status (`position.site`, client request) + corrected site pick on `/punches`. **Awaiting test.**
- BB-128 phase 3b "Locate now" (silent push asking the phone for a fresh location). **Awaiting test**; answers need the mobile release.

**Schema change:** YES (BB-151). New table `CompanySettingsEvent`. Order: user runs `scripts/add-company-settings-events-bb151.sql` (already done) → `prisma generate` → deploy. Saving settings works without the table (no history written). **Env:** none. **Data scripts to run after deploy:** none.

**Client impact:**
- BB-151: History view, "Are you sure?" before saving, and settings saves hidden for non-admins (new 403s). Hand-off `docs/client-update-BB-151.md` (applied by the client side).
- BB-128: `position.hereSince`, `position.site`, `employees[].locate`, the two locate endpoints and the `/punches` site note. All in `docs/client-update-BB-128-map-views.md` (Live section + 3b). Additive.

**Mobile impact:**
- BB-128 Locate now: handle the silent `LOCATE_REQUEST` push and upload one fix with `source: "locate"` + `requestId`. Hand-off `docs/mobile-update-BB-128-locate-now.md` (not sent). It also asks the mobile dev to confirm that background interval sending works.
- BB-151: none expected. Confirm the app never calls the newly admin-only settings endpoints as a non-admin.

---

# BB-151 — Company Settings history

- **What:** company-wide settings were overwritten in place with no record of who changed what. Every settings save that changes something now writes one history row: who (User + B. Buddy staff id), when, IP, which page ("area"), and each field old → new. While investigating, several settings writers turned out to have **no role check** (any signed-in employee could change them through the API); they are now admin/superadmin only.
- **User decisions:** log all settings writers; add the role guards; client confirm = a simple "Are you sure?" (no reason stored); history visible to admins + superadmins.
- **Changes:**
  - `scripts/add-company-settings-events-bb151.sql` (stays out of git; user runs it) + `src/prisma/schema.prisma`: `CompanySettingsEvent` (BIGSERIAL, companyId FK cascade, area, changes JSONB `[{field, from, to}]`, actorId, agentId, ip, createdAt; index companyId + createdAt). Kept forever.
  - `src/services/Company/companySettingsEventService.js` (new, raw SQL): `diffSettings` (only real changes; Decimal/Date/JSON normalised), `recordDiff` / `recordSettingsChange` (best effort, never fails a save, no row when nothing changed), `listHistory` (newest first, cursor by id, actor names, `bySupport`, field labels).
  - `src/controllers/Account/companySettingsController.js`: shared `SETTINGS_SELECT`; `updateSettings` records `general` + `cutoff`; `updateCheckSettings` records `check`; new `getSettingsHistory`.
  - `src/controllers/Company/notificationSettingsController.js`: records `notifications`.
  - `src/controllers/PayrollSystem/companyInformationController.js`: `updatePayrollConfig` → `payroll`, `updateCompanyInfo` → `profile`.
  - `src/controllers/Account/companyController.js`: `updateCompany` (used by `/company/me` and the superadmin edit) → `profile`.
  - `src/controllers/Features/leaveCreditSetupController.js`: `applySetup` → `leaveCredits`.
  - `src/routes/Account/companySettingsRoutes.js`: `GET /history`; admin guard on PUT `/check-settings`, POST `/check-test-pdf`, PUT `/notification-settings`.
  - `src/routes/PayrollSystem/companyInformationRoutes.js`: admin guard on PUT `/payroll-config`, `/company-info` and every POST/PUT/DELETE of earning types, deduction types, federal and state tax rates. GETs unchanged.
- **Endpoints:** `GET /api/company-settings/history?from&to&area&field&actorId&limit&cursor` (admin/superadmin).
- **Not logged:** earning/deduction types, tax rates, setup guide skip/dismiss (records, not settings). History starts at deploy.
- **Order:** SQL (done) → `prisma generate` → deploy.

# BB-128 — Live: "here for" (`position.hereSince`)

- **What:** client request for a Life360-style "here for 1 hr 20 min" bubble. `/live` now reads every breadcrumb of the open punches (was only the latest) and walks back from the latest **accurate** point (≤ 100 m), skipping less accurate points, to the first point more than 100 m away (`STAY_RADIUS_M`, same as the client's Routes stop radius).
  - Whole punch within 100 m: the clock-in time, unless the clock-in pin itself is more than 100 m away (then the first breadcrumb).
  - Clock-in pin only: the clock-in time.
  - No accurate point: `null`.
  - The two rule changes from the request (anchor on an accurate point, clock-in pin check) were OK'd by the user.
- **Changes:** `src/services/Locations/liveMapService.js` (`punchPoints`, `hereSinceFor`); `src/services/Locations/employeeMapService.js` exports `distanceMeters`.

# BB-128 — Live redesign: work-site status (`position.site`)

- **What:** client request: per person `site { id, name, inside, distanceMeters, since }` so Live can group "Needs a look" / "On site".
  - The site is the one they're inside (if several, the closest center), else the one whose **edge** is nearest; only sites with a radius count.
  - `distanceMeters` = to the edge (0 inside).
  - `since` uses the same walk-back as `hereSince`. States are "inside site X" (each site separate) or "outside".
  - `null` when no site has a radius.
- **Fix on `/punches`:** the old `matchSite` picked the nearest **center** and then checked it, so a pin inside a big site next to a small one showed as outside. It now uses the same `siteState` rule. Fields unchanged (`distanceMeters` still to the center).
- **Changes:** `src/services/Locations/employeeMapService.js` (`siteState`, `matchSite`); `src/services/Locations/liveMapService.js` (`siteFor`, shared `sinceSame`).

# BB-128 phase 3b — Locate now

- **What:** on Live, an admin clicks an employee's initials (or Refresh for everyone) to ask the phone for a fresh location; the stale pin stays as the backup.
  - The server sends a **silent** data-only FCM push `LOCATE_REQUEST { requestId, timeLogId, companyId, expiresAt }` (Android priority high; iOS background push).
  - The app takes one fix and uploads it through the existing breadcrumb upload with `source: "locate"` + `requestId`.
  - `/live` shows `locate.status`: pending, answered, no_answer or not_sent.
- **User decisions:** silent (the employee sees nothing; clocked in = work time); Refresh-all included; only open punches (≤ 24 h); company tracking must be on.
- **Rules:** 60 s answer window; 1 request per employee per 30 s; 200 per admin per 10 min; Refresh capped at 50 phones. Requests are kept in memory for 10 min (no table; one Render instance assumed; a restart only drops requests in flight). Audit = RequestLog (path has the employee id, B. Buddy agentId).
- **Changes:**
  - `src/services/Locations/locateRequestService.js` (new).
  - `src/controllers/Features/employeeMapController.js`, `src/routes/Features/employeeMapRoutes.js`: two POST routes.
  - `src/services/Locations/liveMapService.js`: `employees[].locate`, `tracking.locateAnswerSeconds`.
  - `src/services/Locations/locationBreadcrumbRules.js`: `source` accepts `"locate"`.
  - `src/services/Locations/locationBreadcrumbService.js`: a `locate` sample (saved or duplicate) answers its request.
- **Endpoints:** `POST /api/employee-map/live/:employeeId/locate`, `POST /api/employee-map/live/locate` (body `departmentId` optional). Admin/superadmin, 404 otherwise; 409 when not clocked in, tracking off, or company inactive.
- **Open questions:**
  - iOS delivery is best effort. Apple's Location Push Service Extension comes later, only if needed.
  - Background interval sending stopped on the user's phone (app closed in the background, permission "Always"); the mobile dev is asked to confirm.
