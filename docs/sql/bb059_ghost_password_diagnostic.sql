-- ============================================================
-- BB-059 — "Ghost Password" diagnostic
-- Read-only (SELECT only). No writes, no fixes here.
--
-- Symptom: existing users' passwords suddenly stop working
-- ("Invalid credentials" / 401 on login). Client-side ruled out.
-- Code audit found no static bug in hashing/compare/write paths.
-- This script mines RequestLog for a runtime pattern instead.
--
-- Notes on RequestLog:
--   - populated for every request, post-response, via global middleware
--   - "requestBody" has sensitive keys (password, token, etc.) redacted
--     to the literal string "[REDACTED]" — the KEY is preserved, so we
--     can detect "a password field was sent" without seeing the value
--   - "endpoint" is the normalized route (e.g. /api/employee/:id);
--     "url" retains the real path/id
-- ============================================================


-- ── 1. Failed-login volume by day ──────────────────────────────
-- Look for a spike/step-change that lines up with a deploy date.
SELECT
  date_trunc('day', "createdAt")                                   AS day,
  COUNT(*)                                                         AS failed_logins,
  COUNT(DISTINCT "userId")                                         AS distinct_users
FROM "RequestLog"
WHERE "endpoint" IN ('/api/account/login', '/api/account/sign-in')
  AND "statusCode" = 401
  AND "createdAt" >= now() - interval '60 days'
GROUP BY 1
ORDER BY 1 DESC;


-- ── 2. Per-user: most recent password-mutating event before a failed login ─
-- If most affected users show a change/reset-password success shortly
-- before their failures start, that endpoint is the likely culprit.
--
-- NOTE: a failed-login request has NO Bearer JWT yet, so RequestLog's
-- "userId" (populated from decoding the Authorization header) is always
-- NULL for these rows — confirmed by query 1's distinct_users column
-- reading 0 on every day. So we recover the user via the unredacted
-- "email" field in the login requestBody instead, joined to User.email.
--
-- v2 fixes over the first pass:
--   - email alone isn't unique across companies (multi-tenant), so joining
--     on email only fanned out to every company sharing that email. Now
--     also matching on companyId pulled from the login requestBody itself
--     (the top-level RequestLog.companyId column is NULL here too, same
--     reason userId is NULL — no JWT yet on a login request).
--   - password_events now also includes /api/employee/:id PUT calls that
--     carried a "password" key (per query 3's finding), correlated by the
--     TARGET employee id parsed out of the url column — NOT RequestLog's
--     "userId", which for that endpoint is the ACTING ADMIN, not the
--     employee being edited.
--   - capped to gaps <= 24h so we're only looking at plausible causes,
--     not "this user changed their password 3 months ago" noise.
WITH failed_logins AS (
  SELECT
    lower("requestBody"->>'email')                                 AS email,
    "requestBody"->>'companyId'                                    AS company_id,
    "createdAt"                                                    AS failed_at
  FROM "RequestLog"
  WHERE "endpoint" IN ('/api/account/login', '/api/account/sign-in')
    AND "statusCode" = 401
    AND "requestBody" ? 'email'
    AND "createdAt" >= now() - interval '60 days'
),
failed_logins_with_user AS (
  SELECT DISTINCT
         u.id                                                      AS "userId",
         fl.email,
         u."companyId",
         fl.failed_at
  FROM failed_logins fl
  JOIN "User" u
    ON lower(u.email) = fl.email
   AND (fl.company_id IS NULL OR u."companyId" = fl.company_id)
),
password_events AS (
  SELECT
    CASE
      WHEN "endpoint" = '/api/employee/:id'
        THEN regexp_replace("url", '^/api/employee/', '')
      ELSE "userId"
    END                                                             AS target_user_id,
    "endpoint",
    "createdAt"                                                     AS event_at
  FROM "RequestLog"
  WHERE (
      "endpoint" IN (
        '/api/account/change-password',
        '/api/employee/me/password',
        '/api/account/reset-password'
      )
      OR (
        "endpoint" = '/api/employee/:id'
        AND "method" = 'PUT'
        AND "requestBody" ? 'password'
      )
    )
    AND "isFailed" = false
)
SELECT
  flu."userId",
  flu.email,
  flu."companyId",
  flu.failed_at,
  pe."endpoint"                                                    AS last_password_event,
  pe."event_at"                                                    AS last_password_event_at,
  flu.failed_at - pe."event_at"                                    AS gap
FROM failed_logins_with_user flu
JOIN LATERAL (
  SELECT "endpoint", "event_at"
  FROM password_events pev
  WHERE pev.target_user_id = flu."userId"
    AND pev."event_at" <= flu.failed_at
  ORDER BY pev."event_at" DESC
  LIMIT 1
) pe ON true
WHERE flu.failed_at - pe."event_at" <= interval '24 hours'
ORDER BY gap ASC;


-- ── 3. Admin update-employee calls that actually included a password field ─
-- Re-checks "does an update-employee request ever carry a password the
-- caller didn't intend" against real traffic (client code already ruled
-- this out for the known web client — this checks all callers).
--
-- v2: added userAgent + a rough platform guess. We've now directly
-- reproduced (via browser Network tab) that the WEB client only ever
-- sends "password" when someone actually types into that field — no
-- leakage, no stale carryover between employees in the same session.
-- So these historical rows are genuine non-empty submissions from
-- SOME client. This checks whether they're actually coming from the
-- mobile app instead of web, which would point the investigation at
-- an entirely different, unaudited codebase.
SELECT
  "id",
  "userId"                                                         AS acting_admin_user_id,
  "companyId",
  "url",
  "statusCode",
  "userAgent",
  CASE
    WHEN "userAgent" ILIKE '%okhttp%'
      OR "userAgent" ILIKE '%CFNetwork%'
      OR "userAgent" ILIKE '%Dalvik%'
      OR "userAgent" ILIKE '%BizBuddy%'
      OR "userAgent" ILIKE '%iPhone%' AND "userAgent" NOT ILIKE '%Safari%'
      OR "userAgent" ILIKE '%Expo%'
      OR "userAgent" ILIKE '%ReactNative%'
      THEN 'likely mobile app'
    WHEN "userAgent" ILIKE '%Mozilla%' OR "userAgent" ILIKE '%Chrome%' OR "userAgent" ILIKE '%Safari%'
      THEN 'likely web browser'
    ELSE 'unknown'
  END                                                               AS platform_guess,
  "createdAt"
FROM "RequestLog"
WHERE "endpoint" = '/api/employee/:id'
  AND "method" = 'PUT'
  AND "requestBody" ? 'password'
  AND "createdAt" >= now() - interval '60 days'
ORDER BY "createdAt" DESC;


-- ── 4. Rapid repeated password-mutation calls per user (possible race) ─
-- Same user hit by 2+ password-mutating requests within a short window.
-- Candidate for a last-write-wins race (e.g. admin edit + employee
-- self-service change landing close together).
--
-- "userId" here is the ACTING caller (e.g. the admin), not necessarily
-- the target of /api/employee/:id — two quick calls from the same admin
-- could just be them editing two different employees back-to-back, which
-- is normal and not evidence of anything. "url" (has the real target id)
-- and both statusCodes are included so that can be told apart from an
-- actual same-target double-submit / race.
WITH pw_events AS (
  SELECT
    "id", "userId", "endpoint", "url", "method", "statusCode", "createdAt",
    LAG("createdAt")  OVER (PARTITION BY "userId" ORDER BY "createdAt") AS prev_at,
    LAG("endpoint")   OVER (PARTITION BY "userId" ORDER BY "createdAt") AS prev_endpoint,
    LAG("url")        OVER (PARTITION BY "userId" ORDER BY "createdAt") AS prev_url,
    LAG("statusCode") OVER (PARTITION BY "userId" ORDER BY "createdAt") AS prev_status
  FROM "RequestLog"
  WHERE "endpoint" IN (
      '/api/account/change-password',
      '/api/employee/me/password',
      '/api/account/reset-password',
      '/api/employee/:id'
    )
    AND "method" IN ('PUT', 'POST')
    AND "userId" IS NOT NULL
    AND "createdAt" >= now() - interval '60 days'
)
SELECT
  "userId",
  prev_endpoint,
  prev_url,
  prev_status,
  prev_at,
  "endpoint"                                                       AS next_endpoint,
  "url"                                                            AS next_url,
  "statusCode"                                                     AS next_status,
  "createdAt"                                                      AS next_at,
  "createdAt" - prev_at                                            AS gap,
  (prev_url = "url")                                               AS same_target
FROM pw_events
WHERE prev_at IS NOT NULL
  AND "createdAt" - prev_at <= interval '10 seconds'
ORDER BY gap ASC;


-- ── 5. Any API call in the 5 minutes AFTER a successful password change ─
-- Different angle from query 2 (which looked backward from a failure).
-- This looks forward from a legitimate, successful password-mutating
-- event and lists everything that happened next for that same target
-- user, from any endpoint/actor. Rationale: if some retry/sync/offline-
-- queue mechanism (mobile app is a candidate per query 3's findings)
-- replays a stale form submission shortly after the real one already
-- went through, this is where it would show up — e.g. a second
-- /api/employee/:id PUT for the same target a few seconds/minutes
-- later, still carrying a "password" key with old/placeholder content.
WITH pw_mutations AS (
  SELECT
    "id",
    "userId"                                                         AS actor_id,
    CASE
      WHEN "endpoint" = '/api/employee/:id'
        THEN regexp_replace("url", '^/api/employee/', '')
      ELSE "userId"
    END                                                               AS target_user_id,
    "endpoint"                                                        AS password_event,
    "userAgent"                                                       AS password_event_user_agent,
    "createdAt"                                                       AS event_at
  FROM "RequestLog"
  WHERE (
      "endpoint" IN (
        '/api/account/change-password',
        '/api/employee/me/password',
        '/api/account/reset-password'
      )
      OR (
        "endpoint" = '/api/employee/:id'
        AND "method" = 'PUT'
        AND "requestBody" ? 'password'
      )
    )
    AND "isFailed" = false
    AND "createdAt" >= now() - interval '60 days'
)
SELECT
  pm.target_user_id,
  pm.password_event,
  pm.password_event_user_agent,
  pm.event_at                                                        AS password_changed_at,
  rl."endpoint"                                                       AS subsequent_endpoint,
  rl."method"                                                         AS subsequent_method,
  rl."userId"                                                         AS subsequent_actor_id,
  rl."statusCode"                                                     AS subsequent_status,
  rl."requestBody" ? 'password'                                       AS subsequent_carries_password,
  rl."userAgent"                                                      AS subsequent_user_agent,
  rl."createdAt"                                                      AS subsequent_at,
  rl."createdAt" - pm.event_at                                        AS gap
FROM pw_mutations pm
JOIN "RequestLog" rl
  ON rl."createdAt" > pm.event_at
 AND rl."createdAt" <= pm.event_at + interval '5 minutes'
 AND rl."id" <> pm."id"
 AND (
   rl."userId" = pm.target_user_id
   OR (
     rl."endpoint" = '/api/employee/:id'
     AND regexp_replace(rl."url", '^/api/employee/', '') = pm.target_user_id
   )
 )
ORDER BY pm.event_at DESC, gap ASC;


-- ── 6. Query 5, narrowed to ONLY the confirmed incidents from query 2 ─
-- Query 2 already found the real cases: a target user's failed login
-- within 24h of a password-mutating event touching them. Instead of
-- scrolling through every password event in 60 days (query 5), this
-- rebuilds that same confirmed incident list, then shows just those
-- incidents' request timeline in the 5 minutes after the password
-- event — i.e. "what led up to each of the ~30 real cases we found."
WITH failed_logins AS (
  SELECT
    lower("requestBody"->>'email')                                   AS email,
    "requestBody"->>'companyId'                                      AS company_id,
    "createdAt"                                                      AS failed_at
  FROM "RequestLog"
  WHERE "endpoint" IN ('/api/account/login', '/api/account/sign-in')
    AND "statusCode" = 401
    AND "requestBody" ? 'email'
    AND "createdAt" >= now() - interval '60 days'
),
failed_logins_with_user AS (
  SELECT DISTINCT
         u.id                                                        AS "userId",
         fl.email,
         u."companyId",
         fl.failed_at
  FROM failed_logins fl
  JOIN "User" u
    ON lower(u.email) = fl.email
   AND (fl.company_id IS NULL OR u."companyId" = fl.company_id)
),
pw_mutations AS (
  SELECT
    "id",
    "userId"                                                         AS actor_id,
    CASE
      WHEN "endpoint" = '/api/employee/:id'
        THEN regexp_replace("url", '^/api/employee/', '')
      ELSE "userId"
    END                                                               AS target_user_id,
    "endpoint"                                                        AS password_event,
    "createdAt"                                                       AS event_at
  FROM "RequestLog"
  WHERE (
      "endpoint" IN (
        '/api/account/change-password',
        '/api/employee/me/password',
        '/api/account/reset-password'
      )
      OR (
        "endpoint" = '/api/employee/:id'
        AND "method" = 'PUT'
        AND "requestBody" ? 'password'
      )
    )
    AND "isFailed" = false
),
confirmed_incidents AS (
  SELECT DISTINCT
    flu."userId"                                                     AS target_user_id,
    flu.email,
    flu.failed_at,
    pe.password_event,
    pe.event_at                                                      AS password_changed_at
  FROM failed_logins_with_user flu
  JOIN LATERAL (
    SELECT pm.password_event, pm.event_at
    FROM pw_mutations pm
    WHERE pm.target_user_id = flu."userId"
      AND pm.event_at <= flu.failed_at
    ORDER BY pm.event_at DESC
    LIMIT 1
  ) pe ON true
  WHERE flu.failed_at - pe.event_at <= interval '24 hours'
)
SELECT
  ci.target_user_id,
  ci.email,
  ci.password_event,
  ci.password_changed_at,
  ci.failed_at                                                       AS login_failed_at,
  rl."endpoint"                                                      AS subsequent_endpoint,
  rl."method"                                                        AS subsequent_method,
  rl."userId"                                                        AS subsequent_actor_id,
  rl."statusCode"                                                    AS subsequent_status,
  rl."requestBody" ? 'password'                                      AS subsequent_carries_password,
  rl."userAgent"                                                     AS subsequent_user_agent,
  rl."createdAt"                                                     AS subsequent_at,
  rl."createdAt" - ci.password_changed_at                            AS gap
FROM confirmed_incidents ci
JOIN "RequestLog" rl
  ON rl."createdAt" > ci.password_changed_at
 AND rl."createdAt" <= ci.password_changed_at + interval '5 minutes'
 AND (
   rl."userId" = ci.target_user_id
   OR (
     rl."endpoint" = '/api/employee/:id'
     AND regexp_replace(rl."url", '^/api/employee/', '') = ci.target_user_id
   )
 )
ORDER BY ci.password_changed_at DESC, gap ASC;
