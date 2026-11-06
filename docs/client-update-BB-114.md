# Server reply — BB-114 System Admin Improvement: cached analytics endpoints

**From:** bizbuddy-v2-server
**For:** bizbuddy-v2-client-web (system-admin pages) and any mobile screen that calls the same endpoints
**Ship:** server first, then client. Every change is **additive** — `data` keeps its exact shape, so the
current web and mobile builds keep working with no change.

---

## 1. Why

The system-admin analytics endpoints aggregate `RequestLog` on a small database. `/activity/features`
and `/activity/peak-hours` took up to 2 minutes, and the dashboard's 30-second polling of
`/overview`, `/trends` and `/performance` ran ~500 times a week — all competing with customers for
database connections. The server now caches these results, shared by every system admin.

## 2. Which endpoints, and for how long

| Endpoint (`/api/system-admin/…`) | Cached for |
|---|---|
| `activity/overview`, `activity/features`, `activity/peak-hours`, `activity/inactive` | 15 min |
| `security/signals` | 2 min |
| `overview`, `performance`, `errors`, `users`, `companies`, `trends`, `security` | 1 min |
| `capacity`, `capacity/history` | 1 min |

The same applies to the older `/api/analytics/system/…` aliases (they share one cache).

**Not cached (unchanged):** `server/logs`, `server/health`, `requests`, `logger-health`,
`capacity/reports` and every POST/PUT. B. Buddy Activity is not cached either.

A cache entry is per endpoint **and** per query (`days`, `timeRange`, `companyId`, `limit`…), so
switching a filter can still be a slow first load. A server deploy/restart empties the cache.

## 3. Response — new `cache` field

```jsonc
{
  "success": true,
  "data": { /* unchanged */ },
  "cache": {
    "hit": true,                              // false = this request ran the query
    "cachedAt": "2026-10-30T10:42:05.120Z",   // when `data` was computed
    "expiresAt": "2026-10-30T10:57:05.120Z"   // when the server will compute it again
  }
}
```

Also sent as a header: `X-Cache: HIT | MISS`.

## 4. Forcing a refresh — `?refresh=1`

Add `refresh=1` to any cached endpoint to recompute now. To protect the database, the server
**ignores** it when the cached copy is younger than 30 seconds (the response then has `hit: true`).
If someone else's identical request is already running, the refresh waits for that one instead of
starting another.

## 5. What the client should do (web and mobile)

Same rules for both — they only use the JSON body, so React (web) and React Native (mobile) code
can share one helper.

1. **Show "As of …"** from `cache.cachedAt` (e.g. "As of 10:42 AM · 3 min ago") on each section,
   instead of the time the browser/app received the response. Use the oldest `cachedAt` when one
   card combines several endpoints (dashboard, Capacity).
2. **Refresh button** → call the same endpoint with `refresh: 1` added to `query`. Disable it for
   30 s after `cachedAt` (the server ignores it in that window anyway). Keep the slow-load state —
   a refresh of `activity/features` can still take ~2 min.
3. **Poll by `expiresAt`, not a fixed timer.** Polling faster than the cache life only returns the
   same data:
   - `app/system-admin/dashboard/page.jsx` polls `overview` / `trends` / `performance` every
     **30 s** → change to **60 s**, or schedule the next poll at the latest `cache.expiresAt` + ~2 s.
   - Pages that don't poll today (Users/activity, Security, Capacity) don't need to start.
   - Pause polling while the tab/app is in the background (`document.visibilityState` on web,
     `AppState` on mobile).
4. **Don't pass `refresh: 1` on automatic loads or polls** — only on a user's explicit tap.
5. `cache` may be missing on endpoints listed as "not cached" — treat it as optional.

Suggested shared helper (pseudo):

```js
// returns { data, cachedAt, expiresAt, hit }
async function fetchCached(path, query, { refresh = false } = {}) {
  const json = await systemAdminFetch(path, { query: refresh ? { ...query, refresh: 1 } : query });
  return { data: json.data, ...(json.cache ?? {}) };
}
```

`useSystemAdminSection` in `components/system-admin/shared.jsx` currently keeps only `json.data`;
it would need to also keep `json.cache` and let `reload()` pass `refresh: 1`.

## 6. Contract summary

- Added: top-level `cache: { hit, cachedAt, expiresAt }` (cached endpoints only), header `X-Cache`.
- Added: optional query param `refresh=1` (or `true`).
- Unchanged: `success`, `data`, status codes, auth, error responses (errors are never cached).
