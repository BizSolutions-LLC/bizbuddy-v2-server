# Changelog — v2.11.27

**Branch:** `release/v2.11.27` (pushed 2026-11-28), from `origin/master` (after PR #141).

**Tickets:**
- BB-151 follow-up: support shown as "B. Buddy (123)" in Settings History and cutoff status history. **Awaiting test.**

**Not in this version:** BB-121 (cutoff page: shift zone, approve rules, lunch, OT blocks, Sync job). It stays uncommitted until the user finishes local testing.

**Schema change:** NO database change. `schema.prisma` now lists two BB-121 columns that are **already in the database**: `TimeLogApproval.approvalMode` and `approvedShiftId`. The first deploy failed because `prisma db push` wanted to drop them, and they hold data from BB-121 testing. This version doesn't use them. **Env:** none. **Data scripts:** none.

**Client impact:** additive. New field `supportCode` and the `by.name` "B. Buddy (123)" on support rows in `GET /api/company-settings/history`, `lastReopen` (`GET /api/cutoff-periods`) and `statusHistory` (`GET /api/cutoff-periods/:id`). The web should show `by.name` for support rows. Hand-off: follow-up section in `docs/client-update-BB-151.md`.

**Mobile impact:** none.

---

# BB-151 follow-up — B. Buddy code in history

- **What:**
  - Support (B. Buddy) rows in the history only said "B. Buddy", so you couldn't tell which staff member made the change. They now show the last 3 characters of the staff code, e.g. "B. Buddy (123)". Only 3 characters, because the code is half of the B. Buddy sign-in.
  - Not shipped: skipping settings history in dev. Local and production share one database, so a local change is a real change and must be recorded.
- **Changes:**
  - `src/services/Company/companySettingsEventService.js`:
    - `listHistory` joins `SupportAgent` and returns `by.name` "B. Buddy (123)" (or "B. Buddy" with no code) plus `supportCode`.
  - `src/services/Cutoff/cutoffStatusEventService.js`:
    - `historyFor` uses the same naming and adds `supportCode`.
    - `lastReopen` adds `supportCode`.
  - `docs/client-update-BB-151.md`: follow-up section.
  - `src/prisma/schema.prisma`: `TimeLogApproval.approvalMode`, `approvedShiftId` (String?, already in the DB; BB-121 uses them).
- **Endpoints:** unchanged, with additive fields only:
  - `GET /api/company-settings/history`
  - `GET /api/cutoff-periods`
  - `GET /api/cutoff-periods/:id`
- **Order:** deploy. Nothing else.
- **Open questions:** none.
