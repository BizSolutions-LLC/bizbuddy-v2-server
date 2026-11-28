# Changelog — v2.11.27

**Branch:** `release/v2.11.27` (pushed 2026-11-28), from `origin/master` (after PR #141).

**Tickets:**
- BB-151 follow-up: support shown as "B. Buddy (123)" in Settings History and cutoff status history; no settings history written in dev/local. **Awaiting test.**

**Not in this version:** BB-121 (cutoff page: shift zone, approve rules, lunch, OT blocks, Sync job). It stays uncommitted until the user finishes local testing.

**Schema change:** NO. **Env:** none. **Data scripts:** none.

**Client impact:** additive. New field `supportCode` and the `by.name` "B. Buddy (123)" on support rows in `GET /api/company-settings/history`, `lastReopen` (`GET /api/cutoff-periods`) and `statusHistory` (`GET /api/cutoff-periods/:id`). The web should show `by.name` for support rows. Hand-off: follow-up section in `docs/client-update-BB-151.md`.

**Mobile impact:** none.

---

# BB-151 follow-up — B. Buddy code + no dev history

- **What:**
  - Support (B. Buddy) rows in the history only said "B. Buddy", so you couldn't tell which staff member made the change. They now show the last 3 characters of the staff code, e.g. "B. Buddy (123)". Only 3 characters, because the code is half of the B. Buddy sign-in.
  - Settings changes made while testing locally filled the history with noise. With `NODE_ENV=development` no settings history row is written. The save itself works as usual.
- **Changes:**
  - `src/services/Company/companySettingsEventService.js`:
    - `recordSettingsChange` returns early in development.
    - `listHistory` joins `SupportAgent` and returns `by.name` "B. Buddy (123)" (or "B. Buddy" with no code) plus `supportCode`.
  - `src/services/Cutoff/cutoffStatusEventService.js`:
    - `historyFor` uses the same naming and adds `supportCode`.
    - `lastReopen` adds `supportCode`.
    - Cutoff status events are still recorded in dev, because reopen depends on them.
  - `docs/client-update-BB-151.md`: follow-up section.
- **Endpoints:** unchanged, with additive fields only:
  - `GET /api/company-settings/history`
  - `GET /api/cutoff-periods`
  - `GET /api/cutoff-periods/:id`
- **Order:** deploy. Nothing else.
- **Open questions:** none.
