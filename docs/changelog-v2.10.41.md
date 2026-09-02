# Changelog — v2.10.41

> **BB-080** — a supervisor (or admin/superadmin) can now file a punch/time-correction request
> on behalf of an employee in their scope, instead of requiring the employee to submit it
> themselves. Still goes through the normal pending-approval flow — nothing is auto-approved.
>
> **BB-081** — CSV bulk upload of weekly employee schedules, using a half-hour time-block grid
> template and a two-phase preview/confirm flow so nothing is written until the uploader
> reviews and approves what will be created.

---

## BB-080 — Create a Punch/Time-Correction Request on Behalf of an Employee

**Why:** Previously `RequestedTimeLog` (`submitRequestPunchLog`,
`requestPunchLogController.js`) could only ever be filed by the authenticated user for
themselves — `userId` was hard-coded to `req.user.id`. This meant an employee who, say,
forgot to clock in/out and called their supervisor instead had no way to get a request filed
without doing it themselves after the fact. BB-080 lets a supervisor/admin/superadmin file the
request for that employee directly.

**Scope of "who can act for whom"** mirrors the existing BB-072 rule already used for Leave
approver eligibility (`leaveController.js`'s `_isEligibleApprover`, `leaveUtils.js`'s
`leaveVisibilityWhere`), reimplemented locally as `_isEligibleToActFor()` in
`requestPunchLogController.js`:
- `employee` — may only submit for themselves.
- `supervisor` — may act for anyone in their own department, or any employee individually
  assigned to them as a direct supervisor (`EmploymentDetail.supervisorId`), regardless of
  department.
- `admin` / `superadmin` — unrestricted, may act for any employee in the company.

**Schema** (`src/prisma/schema.prisma`) — `RequestedTimeLog` gains a nullable `createdByUserId`
+ `createdBy` relation, distinct from the existing `userId` (who the request is *for*). This
mirrors the existing `userId`/`performedById` split on `LeaveTransaction`. `null` for self-filed
requests (the existing/dominant case, unaffected); populated only when someone files on another
employee's behalf. Migration ran manually against the DB (raw SQL, followed by `prisma
generate`); the one-off script has since been removed from `scripts/` per this repo's
migration-script convention.

**`submitRequestPunchLog`** (`requestPunchLogController.js`) — accepts an optional
`targetUserId` in the request body. When present and different from the caller: employees are
rejected with `403`; otherwise the target employee is looked up (scoped to the caller's
company), `_isEligibleToActFor()` is checked (`403` if ineligible, `404` if the target isn't
found), and on success the request is created with `userId` = the target employee and
`createdByUserId` = the acting supervisor/admin. No route/middleware change was needed — `POST
/submit` already permitted `employee, admin, supervisor, superadmin`.

**Read paths** — `viewMyRequestedPunchLogs`, `viewAllRequestedPunchLogs`,
`approveRequestedPunchLog`, `rejectRequestedPunchLog`, and the create response now include
`createdBy` (`id`, `email`, `profile.firstName/lastName`), so the client can show e.g. "Filed by
[supervisor name] on your behalf." `viewAllRequestedPunchLogs`'s flattened response shape adds
`createdByDisplayName` instead of the nested object, matching its existing convention.

**New endpoint — `GET /api/employee/team`** (`employeeController.js`'s `getMyTeam`,
`employeeRoutes.js`) — returns the employees the caller is allowed to act for, using the same
department-OR-direct-report scoping described above (company-wide for admin/superadmin). Added
to back the client's "create on behalf of" employee picker; no equivalent endpoint existed
before this (`getAllEmployees`, `getUsersInDepartment`, and `getCompanyEmployees` were all
checked and none apply this scoping to employee/user records).

**Client-side impact:**
- `POST /api/request-punch-log/submit` gains an optional `targetUserId` field.
- New `GET /api/employee/team` endpoint (**singular** "employee", matching this module's
  existing `/api/employee` prefix — not `/employees`) to populate the employee picker.
- `createdBy` / `createdByDisplayName` added to the response shapes listed above.
- New UI needed: an employee picker / "create on behalf of" entry point on the supervisor's
  request screen, and a "filed by ___" indicator in request lists where `createdBy` is present.

**Files Changed:**

| File | Change |
|---|---|
| `src/prisma/schema.prisma` | New `RequestedTimeLog.createdByUserId` + `createdBy` relation; reverse relation on `User` |
| `src/controllers/Features/requestPunchLogController.js` | New `_isEligibleToActFor()` helper; `submitRequestPunchLog` accepts `targetUserId`; `createdBy` added to read/response paths |
| `src/controllers/Features/employeeController.js` | New `getMyTeam()` — department-or-direct-report-scoped employee list |
| `src/routes/Features/employeeRoutes.js` | New `GET /team` route, gated to `admin`/`superadmin`/`supervisor` |

---

## BB-081 — CSV Upload Template for Schedules of Employees

**Why:** Assigning shifts one employee/date at a time (`assignShifts`) or via a recurring rule
(`createShiftSchedule`) doesn't fit a common real-world case: an admin/supervisor building out
a whole week's schedule for a team from a spreadsheet. BB-081 adds a CSV-driven bulk path
purpose-built for that — instead of explicit `startTime`/`endTime` columns, the uploader marks
which half-hour blocks of the day each employee works, and the server derives the actual shift
times from the marked blocks.

**Design, confirmed before implementation:**
- One upload = one week. Rows = employee × date (not one wide row per employee for the whole
  week), each carrying 46 time-block columns (`01:00`…`23:30`, half-hour increments) that get
  marked for the blocks that employee works that day.
- An `overnight` flag (set per upload) allows a row's marks to wrap from the last block (23:30)
  back to the first (01:00) as one continuous overnight span, instead of requiring the whole
  shift to fall within a single calendar day.
- Two-phase, **stateless** flow: `POST .../preview` parses the file, merges each row's blocks
  into a time range, proposes a default Shift name, and checks conflicts — **writes nothing**.
  `POST .../confirm` takes the (possibly user-edited: renamed shifts, skipped rows) preview
  rows back, re-validates everything against current data, and commits.
- Within one import batch, rows resolving to the identical `(startTime, endTime,
  crossesMidnight)` span share one proposed default Shift name, editable before confirming —
  but this import never renames or reuses a pre-existing company `Shift` template; every
  confirmed group always creates a brand-new `Shift` row, so bulk-importing a schedule can't
  silently mutate an unrelated existing template.
- Conflict handling: a row overlapping an employee's existing shift on that date is marked
  `conflict` in the preview (not silently skipped or overwritten) — the uploader excludes it
  explicitly (`skip: true`) before confirming, matching this repo's newer CSV-import
  convention (BB-077) rather than the older `replaceConflicts` pattern used by the existing
  `/shift-assignments/assign` endpoints.
- Department scoping matches BB-077/BB-080: a `supervisor` uploader is restricted to employees
  in their own department; `admin`/`superadmin` stay company-wide. This is *stricter* than
  today's existing shift-assignment endpoints (`assignShifts`, `bulkAssignShifts`,
  `createShiftSchedule`), which currently apply no department restriction at all — a
  pre-existing inconsistency flagged during planning, not something this ticket changes.

**No schema changes were needed** — `UserShift.createdFrom` already supports `'bulk'` as a
value, and `Shift` already has everything a template needs.

**New files:**
- `src/utils/csvScheduleParser.js` — pure CSV parsing/shape validation and
  `mergeBlocksToTimeRange()`, the block-to-time-range algorithm.
- `src/services/Features/scheduleImportService.js` — `previewScheduleImport()` (parse, resolve
  employees, merge, conflict-check — no writes) and `commitScheduleImport()` (re-validate,
  group into Shift batches, create inside a `$transaction`, notify).
- `src/controllers/Features/scheduleImportController.js` — `downloadScheduleTemplate`,
  `previewScheduleUpload`, `confirmScheduleImport`.
- `src/routes/Features/scheduleImportRoutes.js` — mounted at `/api/schedule-import`, same
  multer config (memoryStorage, 5MB, CSV-only) as the punch-log importer.

**Client-side impact:**
- Three brand-new endpoints with no prior contract: `GET /api/schedule-import/template`,
  `POST /api/schedule-import/preview` (multipart, returns a preview — nothing written),
  `POST /api/schedule-import/confirm` (JSON body of the edited preview rows, `207` response).
- New UI needed end-to-end: an upload entry point collecting the `overnight` parameter and
  week, a template download, a block-grid CSV to fill in, and a review/confirm modal showing
  each row's status (`ready`/`conflict`/`error`) with an editable Shift Name and a per-row
  skip toggle before confirming.

**Files Changed:**

| File | Change |
|---|---|
| `src/utils/csvScheduleParser.js` | New — block-grid CSV parsing, template builder, block-merge algorithm |
| `src/services/Features/scheduleImportService.js` | New — preview/commit business logic |
| `src/controllers/Features/scheduleImportController.js` | New — template/preview/confirm route handlers |
| `src/routes/Features/scheduleImportRoutes.js` | New — routes, multer config |
| `src/controllers/Features/shiftAssignmentController.js` | Exported existing `hasTimeOverlap()` for reuse (was module-private) |
| `src/routes/index.js` | Registered `/schedule-import` route |
