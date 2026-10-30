// src/utils/ttlCache.js
//
// BB-114: small in-memory TTL cache for heavy, read-only system-admin
// endpoints. Results are shared by every system admin (none of the cached
// endpoints depend on who is asking) and live in this process only — a deploy
// or restart empties it.
//
// - Concurrent requests for the same key share one load (no query stampede
//   when the dashboard fires several endpoints at once, or two admins open it).
// - Failed loads are never cached.
// - ?refresh=1 forces a reload, but only when the cached copy is older than
//   MIN_REFRESH_AGE_MS, so a refresh button can't re-run a 2-minute query in a loop.

const MAX_ENTRIES = 200;
const MIN_REFRESH_AGE_MS = 30 * 1000;

const store = new Map(); // key -> { value, cachedAt, expiresAt }
const inflight = new Map(); // key -> Promise<{ value, cachedAt, expiresAt, hit }>

async function getOrLoad(key, ttlMs, load, { refresh = false } = {}) {
  const now = Date.now();
  const entry = store.get(key);
  const fresh = entry && entry.expiresAt > now;
  const refreshAllowed = refresh && (!entry || now - entry.cachedAt >= MIN_REFRESH_AGE_MS);

  if (fresh && !refreshAllowed) return { ...entry, hit: true };
  if (inflight.has(key)) return inflight.get(key);

  const pending = (async () => {
    try {
      const value = await load();
      const cachedAt = Date.now();
      const next = { value, cachedAt, expiresAt: cachedAt + ttlMs };
      store.delete(key); // re-insert so Map order stays oldest-first
      store.set(key, next);
      while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
      return { ...next, hit: false };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, pending);
  return pending;
}

// Stable key from the handler name + query params (order-insensitive, `refresh` ignored).
function cacheKey(name, query = {}) {
  const params = Object.keys(query)
    .filter((k) => k !== "refresh")
    .sort()
    .map((k) => [k, query[k]]);
  return `${name}?${JSON.stringify(params)}`;
}

/**
 * Express handler that serves `load(req)` through the cache as
 * { success: true, data, cache: { hit, cachedAt, expiresAt } }.
 * `data` keeps the endpoint's original shape; `cache` is additive.
 */
function cachedHandler(name, ttlMs, load) {
  return async (req, res, next) => {
    try {
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const result = await getOrLoad(cacheKey(name, req.query), ttlMs, () => load(req), { refresh });
      res.set("X-Cache", result.hit ? "HIT" : "MISS");
      res.status(200).json({
        success: true,
        data: result.value,
        cache: {
          hit: result.hit,
          cachedAt: new Date(result.cachedAt).toISOString(),
          expiresAt: new Date(result.expiresAt).toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  };
}

const MINUTE = 60 * 1000;

module.exports = { getOrLoad, cacheKey, cachedHandler, MINUTE };
