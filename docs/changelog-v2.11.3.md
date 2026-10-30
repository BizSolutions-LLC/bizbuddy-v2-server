# Changelog — v2.11.3

**Branch:** `release/v2.11.3` (2026-10-30). No schema change, no data script.

> **BB-114 System Admin Improvement** — the heavy system-admin analytics endpoints are now served from
> a shared in-memory cache. Repeat views of the Users (activity) page went from 30 s – 2 min to instant.
>
> The client changes are in `docs/client-update-BB-114.md`. The server change is additive, so the
> current web and mobile builds keep working.

---

## BB-114 — Why

BB-114 is the umbrella ticket for API endpoint improvements. The Performance dashboard showed the
`/system-admin/activity/*` endpoints taking up to 2 minutes (30 days of `RequestLog`, aggregated on a
0.1-CPU database), and the system-admin dashboard polling `overview` / `trends` / `performance` every
30 s (~500 calls a week each). Every one of those competed with customers for database connections.

## BB-114 System Admin Improvement — cached analytics

**New:** `src/utils/ttlCache.js`
- In-memory, keyed by handler name + query params, shared by all system admins.
- Concurrent identical requests share one query (no stampede when a page fires several endpoints).
- Errors are never cached. Max 200 entries. Emptied on deploy/restart.
- `?refresh=1` forces a reload, ignored when the copy is under 30 s old.

**Cache life per endpoint** (`/api/system-admin/…`, and the `/api/analytics/system/…` aliases):

| Endpoint | Cached |
|---|---|
| `activity/overview`, `activity/features`, `activity/peak-hours`, `activity/inactive` | 15 min |
| `security/signals` | 2 min |
| `overview`, `performance`, `errors`, `users`, `companies`, `trends`, `security` | 1 min |
| `capacity`, `capacity/history` | 1 min |

Not cached: `server/logs`, `server/health`, `requests`, `logger-health`, `capacity/reports`, B. Buddy, writes.

**Response:** adds `cache: { hit, cachedAt, expiresAt }` and an `X-Cache: HIT | MISS` header. `data` is unchanged.

**Files:** `src/utils/ttlCache.js` (new), `src/controllers/Analytics/insightsController.js`,
`src/controllers/Analytics/analyticsController.js`.

**Known limit:** the first load after expiry is still slow (up to ~2 min for `activity/features`). A
daily rollup table is the permanent fix — a later BB-114 item.

---

## Docs

- Added `docs/client-update-BB-114.md` (web + mobile: "As of", Refresh button, poll by `expiresAt`).
- `docs/CLAUDE.md`: system-admin caching note.

## Deploy order

1. Merge and deploy the server. No schema change, no script.
2. Ship the client changes from `docs/client-update-BB-114.md` whenever ready (optional).
