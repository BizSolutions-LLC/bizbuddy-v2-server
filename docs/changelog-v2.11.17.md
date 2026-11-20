# Changelog — v2.11.17

**Branch:** `release/v2.11.17` (pushed 2026-11-20), from `origin/master` (after PR #131).

**Tickets:**
- BB-126 Employees Punch Logs: server-computed rows (shared with the punch-log report): **built, awaiting test**.
- BB-128 part 2 GPS breadcrumbs (mobile dev's upload kept; map layer, settings, 90-day cleanup, impossible-travel flags): **complete**.
- BB-129 fix: `resolveShiftForTimeLog` picked the next day's shift west of UTC (Daily Task Report shift label, auto-breaks): **complete**.
- BB-134 Punch device proof (record-only, off by default): **built, awaiting test**.
- BB-135 Schedules List sheet view + Roster OT warning: **complete** (client UI polish only).
- BB-137 Company Panel Employee Logins (confidential, admins only): **built, awaiting test**.
- BB-139 New Business Requirement Details workbook (System Admin download): **complete**.
- BB-140 System Admin: every sent email (log, redacted S3 copy, preview, image check, test sends): **built, awaiting test**.
- BB-141 Face capture as punch proof on S3 (replaces the questionnaire photo of PRs #129/#130): **done for now** (prod test after the mobile release).

**Schema change:** yes, additive. Already run by the user on 2026-11-20 (dev + prod):
1. `scripts/add-punch-face-photos.sql` (BB-141) — **must be in place before deploy** (punch code reads the new columns)
2. `scripts/add-email-log-bb140.sql` (BB-140)
3. `scripts/add-login-events-bb137.sql` (BB-137)
BB-128 / BB-134 columns were already in production. Then `prisma generate` → deploy.
After deploy (optional, off-hours): `node scripts/backfill-bb137-login-events.js` (dry run) → `--apply` (re-runnable).

**New env (Render + local):** `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` (face photos), `AWS_S3_EMAIL_BUCKET` (email copies). `RENDER_DB_PLAN=0.5c-1g` (DB upgraded 2026-11-20).

**New dependencies:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `sharp`.

**Client impact (web):** hand-offs `docs/client-update-BB-126.md`, `-BB-128-breadcrumbs.md` (section 2b), `-BB-134.md`, `-BB-135.md` (part 2), `-BB-137.md` (send privately), `-BB-139.md` (applied), `-BB-140.md`, `-BB-141.md`.
**Mobile impact:** `docs/mobile-update-BB-141.md` (face photo on clock-out / clock-in by company settings), `docs/mobile-update-BB-134.md` (send `deviceId` on time-in/out). BB-137 / BB-126 / BB-140: no app change. A consolidated mobile hand-off (everything since 2026-11-11) is still to be written.

Full details per ticket: CLAUDE.md "Open follow-ups" and `docs/CLAUDE.md` (routes table).

# BB-126 — Employees Punch Logs: server-computed rows
- **What:** `GET /api/timelogs` returns `row.display` + `meta` computed by `src/services/TimeLogs/punchDisplay.js`, the same module the punch-log report's live rows use. Basis per punch: live / decided (no approval pending, cutoff open) / reviewed (selected locked cutoff, per period). New filters `cutoffPeriodIds`, `employeeIds`, `q`. DayCare shifts now by the punch's date (was today's).
- **Changes:** new `services/TimeLogs/punchDisplay.js`; `services/Reports/punchLogReportService.js` (helpers moved, loadLive uses punchDisplay); `controllers/Features/timeLogController.js` (getCompanyTimeLogs); `utils/generatePunchLogsReportXlsx.js` ("Decided" label).
- **Open:** `GET /api/timelogs` has no role check (pre-existing); cutoff approvals page and payroll export still compute separately.

# BB-128 part 2 — GPS breadcrumbs
- **What:** kept the mobile dev's `POST /api/timelogs/location-breadcrumbs`; removed ours (`/api/employee-map/breadcrumbs`, `/config`). Map `layers.breadcrumbs` gains impossible-travel flags (`jumps`, `pinChecks`, `suspicious`, `summary.breadcrumbs.suspiciousTracks`). Request log stores only the sample count.
- **Changes:** `services/Locations/breadcrumbService.js`, `employeeMapService.js`, `employeeMapController.js`, `routes/Features/employeeMapRoutes.js`, `middlewares/requestLogger.js`, `jobs/breadcrumbRetentionJob.js`, `utils/cronScheduler.js`, `companySettingsController.js`, `schema.prisma` (duplicates removed).
- **Open:** does the app read Android `Location.isMock()` / iOS `isSimulatedBySoftware`?

# BB-129 — shift resolution fix
- **Changes:** `services/timeLogComputeService.js` (`resolveShiftForTimeLog` uses the punch's local date as a UTC range), comment in `taskReportFormAssignmentService.js`. Past punches not recomputed. Same pattern remains in `resolveDriverAideSegments` (not changed).

# BB-134 — Punch device proof
- **Changes:** `utils/punchDeviceProof.js`, `timeLogController.js` (time-in/out, `proofIn`/`proofOut`), `companySettingsController.js` (`punchDeviceProofEnabled`).

# BB-135 — Schedules List + Roster OT
- **Changes:** `services/Schedules/`, `userShiftController.js`, `routes/Features/userShiftRoutes.js` (`GET /api/usershifts/range`, `includeOt=1`).

# BB-137 — Employee Logins (confidential)
- **What:** `LoginEvent` per sign-in attempt / sign-out (recorded after the response), flags platform switch / new device / shared device / failed burst; admin-only endpoints `/api/employee-logins` (404 for others); 1-year cleanup; RequestLog backfill script.
- **Changes:** `services/Security/`, `controllers/Security/`, `routes/Security/`, `accountSigninController.js`, `routes/index.js`, `jobs/loginEventRetentionJob.js`, `cronScheduler.js`, `schema.prisma`, `scripts/backfill-bb137-login-events.js`.

# BB-139 — Onboarding workbook
- **Changes:** `utils/generateNewBusinessWorkbook.js`, `controllers/Analytics/onboardingWorkbookController.js`, `systemAdminRoutes.js` (`GET /api/system-admin/onboarding-workbook`).

# BB-140 — System Admin emails
- **What:** all mail through `utils/mailer.sendMail` (reset-password and deletion-code moved onto it), logged by `services/Analytics/emailLogService.js`: summary row (1 year) + redacted copy in S3 (90 days). Endpoints `/api/system-admin/emails`, `/:id`, `/templates`, `POST /test`.
- **Changes:** `utils/mailer.js`, `utils/emailRedact.js`, `utils/emailContext.js`, `utils/s3.js`, `services/emailService.js`, `services/notificationService.js`, `services/Analytics/emailTemplateCatalog.js`, `controllers/Analytics/emailLogController.js`, `jobs/emailLogRetentionJob.js`, `employeeController.js`, `accountSignupController.js`, `resetPasswordController.js`, `requestAccountDeletionController.js`, `companyProvisionService.js`, `schema.prisma`.
- **Open:** welcome emails contain the plain-text password (suggested ticket: activation link). No bounce tracking (SES later).

# BB-141 — Face capture on S3
- **What:** company sub-switches `taskReportFaceCapture` / `taskReportFaceCaptureClockIn` (forms mode only); required photo on clock-out (and clock-in); browser punches refused while it applies (`WEB_PUNCH_DISABLED`); `PunchFacePhoto` + S3; viewable in cutoff approvals until approved. Questionnaire no longer needs/stores a photo.
- **Changes:** `services/Features/punchFacePhotoService.js`, `controllers/Features/punchFacePhotoController.js`, `routes/Features/punchFacePhotoRoutes.js`, `timeLogController.js`, `timeLogRoutes.js`, `taskReportFormResponseService.js`, `taskReportFormController.js`, `taskReportFormRoutes.js`, `companySettingsController.js`, `config/connection.js` (omit old photo bytes), `schema.prisma`, `scripts/check-bb141-old-face-photos.js`.
- **Open:** don't enable for a company before the mobile release sends photos.
