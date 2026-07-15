# Changelog — v2.10.24

> BB-044: cutoff periods embedded in `employment-details/me` (admin-aware); new
> `punch-logs/bootstrap` endpoint consolidates 6 mount-time employee dashboard calls into one.

---

## New Feature

### BB-044 — Cutoff Periods Embedded in `GET /api/employment-details/me`

**File:** `src/controllers/Features/employmentDetailController.js` → `getMyEmploymentDetails`

**Problem:** The employee-side date-range picker (`CutoffDateRangeFilter`) was making two extra
round-trips per page load (`&status=open` + a plain history call) to reconstruct data the
company/admin side already got in one shot from `getCutoffPeriods`.

**Fix:** `getMyEmploymentDetails` now returns a `cutoffPeriods` array alongside `data`, same shape
(`id`, `periodStart`, `periodEnd`, `status`, `departmentId`) the admin-side endpoint already
returns — no client-side reshaping needed.

**Follow-up fix — admin/superadmin scoping:** Initial version scoped `cutoffPeriods` to the
caller's own `departmentId`. This silently broke for `admin`/`superadmin` accounts with no
`EmploymentDetail` row (e.g. no department assigned) — they'd only see the sparse
company-wide (`departmentId: null`) periods instead of the full set every department produces.
Admins/superadmins now skip the department filter entirely and see every cutoff period for the
company, matching the company-side view. Regular employees remain scoped to their own
department + company-wide periods.

This rule now lives in a shared service (see below) rather than inline in the controller.

---

## New Feature

### Punch Logs Bootstrap Endpoint

**New:** `GET /api/punch-logs/bootstrap`

**Problem:** `/dashboard/employee/punch-logs` fired 8 concurrent requests on mount. An audit of
the actual client code (not assumptions) confirmed 6 of them were genuinely load-once data that
could be safely consolidated:

| Old endpoint | Old function |
|---|---|
| `GET /api/company-settings/` | `fetchCompanySettings` |
| `GET /api/employment-details/me` | `fetchEmployeeDetails` |
| `GET /api/leaves/approvers` | `fetchApprovers` |
| `GET /api/account/approver` | `fetchSupervisors` |
| `GET /api/location/assigned` | `fetchLocations` |
| `GET /api/request-punch-log/my-requests?limit=10&status=PENDING` | `fetchMyRequests` |

Two were deliberately kept out: `GET /api/usershifts/` (`fetchUserShifts`) re-scopes to whatever
date range is currently active, not just the initial mount — folding it into a one-time bootstrap
would go stale the moment a custom date range is applied outside the bootstrap's window. Live
values (`overtime/threshold-status`) and filter-driven calls (`timelogs/user`) were excluded for
the same reason.

**Fix:** `punchLogsBootstrapController.getPunchLogsBootstrap` composes all 6 in parallel
(`Promise.all`) and returns a payload trimmed to exactly the fields the client audit confirmed are
read — not full re-bundled payloads. Notably: `companySettings` returns 8 of the ~25 company
fields (incl. `id`, needed client-side for a daycare-company UI flag), `employmentDetails` drops
the unused `supervisor` sub-object, `approvers` drops `username`, `supervisors` drops `email`, and
`pendingRequests` drops the redundant `user` sub-object (these are always the caller's own
requests).

**Additive only** — all 6 original endpoints stay live, unchanged, for mobile. No deprecation
timeline; web switches over whenever ready.

### Shared Services Extracted (Enables the Above Without Duplicating Logic)

Three pieces of non-trivial business logic were pulled out of their original controllers into
services, so the bootstrap endpoint and the original endpoints share one implementation instead of
drifting apart:

| New service | Extracted from | Used by |
|---|---|---|
| `src/services/Cutoff/cutoffPeriodVisibilityService.js` → `getVisibleCutoffPeriods` | `employmentDetailController.getMyEmploymentDetails` (BB-044 admin-bypass rule) | `employmentDetailController`, `punchLogsBootstrapController` |
| `src/services/Approvers/approverResolutionService.js` → `getEligibleApprovers`, `getDirectSupervisors` | `leaveController.getApprovers`, `accountSignupController.getApprover` | `leaveController`, `accountSignupController`, `punchLogsBootstrapController` |
| `src/services/Locations/assignedLocationsService.js` → `getAssignedLocations` | `locationController.getAssignedLocationsForUser` | `locationController`, `punchLogsBootstrapController` |

All four original endpoints (`employment-details/me`, `leaves/approvers`, `account/approver`,
`location/assigned`) now delegate to these services — external response shape and behavior are
unchanged, verified by re-running each against real data.

**Confirmed NOT mergeable:** `leaves/approvers` and `account/approver` were considered for
consolidation into one approver list, but their department-resolution rules differ
(`account/approver` also checks `supervisedDepartments`/`supervisedEmployees` relations that
`leaves/approvers` doesn't). Both are kept as separate keys (`approvers`, `supervisors`) in the
bootstrap response — the web client's existing fallback logic (prefer `supervisors`, fall back to
`approvers` when empty) is unchanged.

---

## Bug Fix

### BB-042 — Wrong payment dates on Staff / Staff Supervisor cutoff periods

**Reported:** `/dashboard/company/cutoff-periods` showed `Jul 12, 2026` as the payment date for
the `Staff` and `Staff Supervisor` rows of the `Jun 24 – Jul 7, 2026` bi-weekly period, while
`Driver/Aide` (same period) correctly showed `Jul 10, 2026`.

**Root cause:** `CutoffPeriod.paymentDate` is computed once at generation time as
`periodEnd + DepartmentCutoffSettings.paymentOffsetDays` and stored — it is never recalculated on
read. `Driver/Aide` and `Staff`'s offsets had been updated from the default `5` days to `3` days,
but `Staff Supervisor`'s offset was left at `5`. Additionally, several `Staff`/`Staff Supervisor`
`CutoffPeriod` rows had already been generated *before* the `3`-day offset change and were never
regenerated, so they kept the stale `5`-day (`+2` days too late) payment date even after the
setting was corrected.

No application code was changed — the calculation logic
(`src/services/Cutoff/cutoffGenerationService.js`, `src/controllers/Cutoff/cutoffGenerationService.js`,
`src/jobs/autoGenerateCutoffPeriodsJob.js`) was already correct and consistent across all three
places it's duplicated. This was purely a data/config issue for company
`cmnegwuxm0004rf7fzo6wjrw2`.

**Fix (data only, company `cmnegwuxm0004rf7fzo6wjrw2`):**
- `DepartmentCutoffSettings.paymentOffsetDays` for `Staff Supervisor`: `5` → `3`.
- Backfilled `CutoffPeriod.paymentDate` on 10 stale `open` rows (`Staff` + `Staff Supervisor`,
  periods from `2026-05-13` through `2026-07-21`) to `periodEnd + 3 days`.
- `Driver/Aide` was already correct and untouched.

**Scripts (diagnostic + one-off, not part of the app runtime):**
- `scripts/check-payment-date-jun24-cutoff.js` — confirmed the initial discrepancy
- `scripts/fix-payment-date-jun24-cutoff-period.js` — fixed the reported period + Staff Supervisor setting
- `scripts/check-all-payment-date-mismatches.js` — swept the rest of the company for the same pattern
- `scripts/fix-payment-date-remaining-stale-periods.js` — backfilled the remaining 8 stale rows found by the sweep

**Status:** Done. Verified no remaining mismatches for this company as of `2026-07-15`.

---

## New Docs

| File | Purpose |
|---|---|
| `docs/CLIENT_PUNCH_LOGS_BOOTSTRAP_CONTRACT.md` | Endpoint contract + sample response for the web client switch-over |

`docs/PUNCH_LOGS_BOOTSTRAP_FIELD_AUDIT.md` (the pre-build field-audit request) is superseded by
the contract doc above and removed.

---

## Files Changed

| File | Change |
|---|---|
| `src/controllers/Features/employmentDetailController.js` | `getMyEmploymentDetails` returns `cutoffPeriods`; delegates visibility rule to shared service |
| `src/controllers/Features/leaveController.js` | `getApprovers` delegates to `approverResolutionService` |
| `src/controllers/Account/accountSignupController.js` | `getApprover` delegates to `approverResolutionService` |
| `src/controllers/Features/locationController.js` | `getAssignedLocationsForUser` delegates to `assignedLocationsService` |
| `src/controllers/Features/punchLogsBootstrapController.js` | New — composes the 6-endpoint bootstrap payload |
| `src/routes/Features/punchLogsBootstrapRoutes.js` | New — mounts `GET /bootstrap` |
| `src/routes/index.js` | Mounts new routes at `/punch-logs` |
| `src/services/Cutoff/cutoffPeriodVisibilityService.js` | New |
| `src/services/Approvers/approverResolutionService.js` | New |
| `src/services/Locations/assignedLocationsService.js` | New |
| `docs/CLIENT_PUNCH_LOGS_BOOTSTRAP_CONTRACT.md` | New |

---

## Open Items (Not in This Release)

- Web client has not yet switched `/dashboard/employee/punch-logs` over to the new bootstrap
  endpoint — contract doc is ready to hand off.
- Possible follow-up flagged during the audit, not yet actioned: `fetchUserShifts` and
  `fetchLogs` are already both keyed off the same date-range params — could be merged into one
  filter-scoped endpoint later, separate from this bootstrap.
