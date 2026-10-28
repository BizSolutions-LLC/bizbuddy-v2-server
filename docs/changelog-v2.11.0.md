# Changelog — v2.11.0

> **BB-110** — **B. Buddy**: every company gets a hidden support admin account that BizBuddy staff use
> to work in a customer's Company panel. It never appears as a person (lists, headcounts, reports,
> payroll, notifications), can't use the employee panel, and company admins can't change it. Staff
> sign in through one shared login plus their **own staff code + PIN**, and **each staff member is
> assigned to exactly one company**. Everything done through B. Buddy is recorded with the staff
> member behind it. **Sunshine Learning is set up** (2026-10-27); other companies are pending.
>
> **System-admin accounts with 2FA** — the single env username/password is replaced by individual
> accounts (owner + admins) with a mandatory authenticator app (TOTP), recovery codes, lockout, and
> revocable sessions. Every system-admin request is logged with who made it.
>
> **Database overview** — a read-only system-admin page: storage per table, business numbers,
> growth, and a cleanup preview with adjustable retention windows. Nothing can be deleted from it.
>
> **BB-112** — Improve System Admin Functionality (umbrella for all system-admin work from here on):
> **User Activity Analytics** (active users, web vs app, sign-ins, feature usage, peak hours,
> inactive accounts) and **Security Monitor & Threat Detection** (graded signals: per-account brute
> force, credential stuffing, new-network sign-ins, reset spikes, B. Buddy and system-admin signals,
> error and flood spikes). The existing `/users` and `/security` endpoints were rewritten to count in
> the database instead of loading every log row into memory.
>
> **Live Server** (BB-112) — a watch-only page with the server's live log lines (redacted, in
> memory only) and a health card (uptime, memory, CPU, event-loop delay, database ping, request
> rate, error rate, response times). No restart/deploy/settings controls.
>
> **Capacity** (BB-112) — the Performance page gets three gauges (API server, database, API hotspots),
> each with an ok / watch / upgrade verdict and plain reasons, built on 5-minute samples kept for 30 days.
>
> **BB-108** — **Import Punch Logs: pre-filled template**: pick dates (up to 31 days) and employees,
> and fill only clock-in/clock-out. Blank rows are days off and are skipped. Limits: 2,000 rows per file, 500 with punches.
> Both import templates also start with a guide row, which is never imported. Times like `8:00 AM` are read in the
> company's time zone, and supervisors can import for their whole team (own department plus direct reports).
>
> **BB-107** — deactivated accounts receive nothing and are signed out (web and mobile). Five old
> companies were retired and renamed ZZZ–VVV, and the `test` company was deleted. **Add company** in
> the system-admin dashboard creates the company, its owner, and optionally its B. Buddy and support
> staff. Companies without B. Buddy get a **Set up B. Buddy** button. Everything inside a company is
> then set up through B. Buddy.
>
> **Security hardening** — fixed the client-IP handling behind Render's proxy (rate limiters were
> treating every user as one IP), failed-attempt limiting on `/api/account/login`, no fallback
> system-admin secret, and redaction of PINs, recovery codes and query-string passwords in request
> logs.

Minor version bump: new modules, new tables, and client contract changes on web, mobile and the
system-admin dashboard.

---

## BB-110 — B. Buddy system agent ✅ Complete (server; Sunshine Learning set up)

**Why:** support staff need to act inside customer companies (approve, edit, fix) without a fake
employee showing up in the company's data, and developers need a higher-authority trail of exactly
who did what.

### The account

- One `User` per company: `role = admin`, **`isSystemAgent = true`**, username `bbuddy-<companyId>`,
  profile "B." "Buddy", no department, no hire date. All companies share **one email**
  (`BBUDDY_EMAIL`, `bizbuddy@bizsolutions.us`); `@@unique([companyId, email])` already allowed it.
- `role = admin` is kept so every existing `authorizeRoles("admin", …)` company-panel route works
  unchanged. The company picker shows it as **Internal** instead (`isSystemAgent` on
  `GET /account/get-user-email`).
- Approvals made through it show the approver as **"B. Buddy"** — the only visible trace in the
  company.

### Hidden from everything

New `src/utils/systemAgent.js` → `HUMAN_ONLY` (`{ isSystemAgent: false }`) spread into ~65 user
queries across ~35 files: employee lists, dashboard/headcount counts, admin & superadmin analytics,
leave report, payroll lists, disbursement counts, cutoff notifications, shift assignment/schedules,
schedule/punch-log/backtrack imports, leave credit grants and setup preview, approver resolution,
supervisor validation, fixed-hours members, and every notification / morning & evening report
recipient list. Lookups by id (approver names) are untouched.

### Employee panel blocked — `blockSystemAgent` (403 `SYSTEM_AGENT_NOT_ALLOWED`)

Time in/out, coffee & lunch breaks, own time logs, today's shift, own time-log delete; own leave
submit / my leaves; own OT submit / my OT / threshold / smart-detect; punch-log request submit /
my requests / check-conflict; contest submit / my contests; presence; own employment details; own
profile, own password (`/account/change-password`, `/employee/me/password`), and
`DELETE /account/delete`.

Email-based flows never resolve to it: password reset and account-deletion requests skip
`isSystemAgent` users. `updateDeviceToken` doesn't store an FCM token for it (no push).

### Protected from company admins — `protectSystemAgentTarget` (403 `SYSTEM_AGENT_PROTECTED`)

`PUT/DELETE /employee/:id`, `PUT /employment-details/:id`,
`PUT/DELETE /employee-payroll-details/employees/:userId/payroll-details`. Only BizBuddy controls
its credentials.

### Sign-in (`POST /api/account/login`)

- After the shared password, B. Buddy also requires `agentCode` + `agentPin`:
  - missing → 401 `AGENT_IDENTITY_REQUIRED` (client opens the staff code / PIN step)
  - wrong, inactive or removed → 401 `AGENT_IDENTITY_INVALID`
  - not this staff member's company → 403 `AGENT_NOT_ASSIGNED`
  - 5 wrong PINs in a row → 429 `AGENT_LOCKED` for 15 minutes (`lockedUntil` in the body)
- The token carries `isSystemAgent` + `agentId`. `authMiddleware` re-checks the staff member on
  **every** request (`checkAgentAccess`), so suspending, removing or moving them to another company
  ends their session immediately.
- **Mobile:** B. Buddy skips the single-device lock (several staff share the account; registering one
  phone would lock out or sign out the rest).

### Support staff (`SupportAgent`)

- One staff code + PIN (6–8 digits, bcrypt) **per person**, and **one company per person**
  (`SupportAgent.companyId`; the earlier multi-company link table and "All companies" option were
  removed by user policy).
- **Remove = archive** (`archivedAt`): can never sign in again, code stays reserved, name stays on
  the audit trail. **Suspend** (`active: false`) is reversible.
- PIN reset also clears a lockout.

### Creating the accounts

- New companies: `provisionController.provisionCompany` and `accountSignupController.signUp`
  create B. Buddy in the same transaction (`services/systemAgentService.js`), from `BBUDDY_EMAIL`
  / `BBUDDY_PASSWORD_HASH`. If those aren't set it logs a warning and skips — signup never fails.
- Existing companies: `scripts/bb110-create-bbuddy-accounts.js` — `--hash` (prints a bcrypt hash),
  `--list`, `--companyId=<id>` / `--all`, dry run by default, `--apply` writes
  `backup-bb110-bbuddy-created-<timestamp>.json`.
- **Sunshine Learning** (`cmb1rn4ks0001wqdx2nqth9ra`) applied 2026-10-27 → user
  `cmvq7sfmn0000rfbi9hha2m3h`. Other companies: run `--all` once Sunshine is confirmed.

### Audit trail + monitor — `/api/system-admin/bbuddy/*` (system-admin only)

- `requestLogger` tags every B. Buddy request with `RequestLog.isSystemAgent` + `agentId`. Sign-in
  attempts (success, wrong password, wrong PIN) are tagged too, since they have no token yet.
- `GET /activity` — filter by company, staff, date range, method, writes-only, endpoint,
  failed-only; paged; readable `action` labels for approval/edit endpoints.
- `GET /summary` — totals per company and per staff member, failed sign-ins.
- `GET /accounts` — every company, its B. Buddy account (or missing), assigned staff.
- `GET|POST|PUT|DELETE /agents` — list (`?includeArchived=true`), add, edit / reset PIN /
  re-assign (`companyId`) / suspend, remove (archive).

---

## BB-110 — System-admin accounts with 2FA ✅ Complete (server)

**Why:** the system-admin tier controls everything (provisioning, request logs, B. Buddy staff) but
was one shared username/password in env with no second factor, no per-person accountability, and
no way to revoke one person.

### The model

- New `SystemAdmin` table: username, name, bcrypt password, `isOwner`, `active`, TOTP secret
  (+ pending secret during setup), last accepted step (blocks code replay), hashed one-time recovery
  codes, failed attempts / `lockedUntil`, `tokenVersion`, `lastLoginAt`.
- Three people: the owner, and two admins.
- `SYSTEM_ADMIN_USERNAME` / `SYSTEM_ADMIN_PASSWORD` env are **retired**; only
  `SYSTEM_ADMIN_JWT_SECRET` remains (required — no fallback).

### Sign-in (two steps)

1. `POST /api/system-admin/auth/login` `{ username, password }` →
   `{ mfaRequired, mfaToken }`, or on first sign-in `{ mfaSetupRequired, mfaToken, secret, otpauthUrl }`.
2. `POST /auth/2fa/setup` `{ mfaToken, code }` (first time → returns 10 recovery codes once) or
   `POST /auth/2fa/verify` `{ mfaToken, code }` / `{ mfaToken, recoveryCode }` → 8h session.

- TOTP per RFC 6238 (SHA-1, 6 digits, 30s, ±1 step) in `src/utils/totp.js` — Node `crypto`, no new
  dependency. `mfaToken` lasts 5 minutes.
- 5 wrong passwords/codes → 429 `ADMIN_LOCKED` for 15 minutes. Unknown usernames are compared
  against a dummy hash so timing doesn't reveal them.
- Sessions carry `tokenVersion`; logout, password change, 2FA reset and deactivation end **all** of
  that admin's sessions.
- `verifySystemAdmin` loads the admin on every request and stamps `RequestLog.systemAdminId`.
  `GET /api/system-admin/requests?systemAdminId=` filters by admin.

### Self-service and owner tools

- Everyone: `PUT /auth/password` (min 12 chars; signs out), `POST /auth/2fa/recovery-codes`
  (needs a current code; old codes stop working).
- Owners (`/api/system-admin/admins`): list, add (temporary password; they enroll 2FA at first
  sign-in), edit name / owner role / deactivate, `POST /:id/reset-2fa`, `POST /:id/reset-password`
  (also unlocks). Guards: can't deactivate or demote yourself, can't reset your own 2FA/password
  here, at least one active owner must remain.
- `scripts/bb110-create-system-admin.js` — `--owner` creates the first owner (hidden password
  prompt), `--list`, `--reset-2fa=<username>` emergency reset when an admin loses both phone and
  recovery codes.

---

## BB-110 — Database overview (read-only) ✅ Complete (server)

`/api/system-admin/database/*`, any system admin, every view logged under the admin's name.

- `GET /storage` — total DB size; per table: estimated rows, dead rows, table/index size, last
  vacuum/analyze (Postgres statistics, no scans); grouped into **keep** (payroll & legal records),
  **core**, **logs** (need a retention rule), **temporary** (expired OTPs, reset tokens), **legacy**
  (`Tax`, `AttendanceSummary`, `PayrollExport`, `Payroll`, `Deduction` — nothing writes to them).
- `GET /business` — companies, active employees (B. Buddy excluded), per company: employees, time
  logs in 30 days, open cutoffs, last activity.
- `GET /growth` — rows added in 7 / 30 days for the fast-growing tables.
- `GET /cleanup-candidates` — how many rows each retention rule *would* remove, with adjustable
  windows (`requestLogDays` 90, `auditLogDays` 730, `notificationDays` / `emailLogDays` /
  `activityDays` 365), plus legacy table row counts. **Counts only — no delete endpoint exists.**
  Retention windows will be chosen after seeing real sizes; cleanup will be staged scripts.

`docs/CLAUDE.md`: `AttendanceSummary` corrected to legacy.

---

## BB-112 — User Activity Analytics & Security Monitor ✅ Complete (server)

**Why:** both dashboard pages existed but were effectively dead. They loaded every `RequestLog` row
in the range into memory and counted in JavaScript (slow, then timing out as logs grow), and their
IP-based numbers were meaningless because every request looked like Render's proxy until the
`trust proxy` fix.

### Existing endpoints rewritten (same response shape)

- `GET /api/system-admin/users` — SQL `GROUP BY`; adds `is_system_agent`, `last_seen`; limit capped at 500.
- `GET /api/system-admin/security` — SQL aggregates. `failedLogins` now counts 401/403/404/429 on the
  user **and** system-admin sign-in endpoints (unknown emails return 404 and were missed);
  `unauthorizedAccess` leaves out B. Buddy's expected employee-panel 403s.

### User Activity Analytics — `/api/system-admin/activity/*`

Customer traffic only (B. Buddy, system-admin and anonymous requests excluded). Query: `days`
(default 30, max 365), optional `companyId`.

- `GET /overview` — active users (24h / 7d / 30d), daily active users, web vs mobile app (inferred
  from the user agent), sign-ins succeeded/failed per day.
- `GET /features` — per company and feature (clock in/out, time logs, leave, overtime, punch
  requests, cutoff approvals, payroll, schedules, employees, reports, notifications): actions
  (writes), views (reads), distinct users.
- `GET /peak-hours` — requests and users per hour of day in **each company's own timezone**.
- `GET /inactive` — active accounts with no sign-in or request for N days (B. Buddy excluded);
  `limit` default 200, max 1000.

### Security Monitor — `GET /api/system-admin/security/signals`

Query `timeRange`: `1h | 6h | 24h | 7d | 30d` (default 24h). Returns `counts` per severity and
`signals[]` (`type`, `severity`, `title`, `detail`, `subject`, `count`, `firstSeen`, `lastSeen`,
optional `filters` for the request-log page), critical first.

| Signal | Severity |
|---|---|
| Failed sign-ins on one account (email + company) | warning ≥5, critical ≥15 |
| One IP failing across many accounts (credential stuffing) | warning ≥5 emails, critical ≥10 |
| Successful sign-in from a network the account hasn't used in 30 days | info |
| Password reset spikes per email (≥3) / per IP (≥10) | warning |
| Repeated 403s for one signed-in user (≥10) | warning |
| B. Buddy: wrong PINs (≥3), lockout, unassigned-company attempt, sign-in outside 06:00–22:00 support time, ≥300 changes | warning / critical / warning / info / info |
| System admin: failed sign-ins per IP (≥3), lockout, recovery-code sign-in, admin account changes | warning / critical / warning / info |
| Server errors per endpoint | warning ≥10, critical ≥50 |
| Request flood: an IP's busiest hour ≥600 requests | warning |

Visibility only — blocking stays with the rate limiters, lockouts and 2FA. No alert emails.

### New / changed files

- New: `services/Analytics/userActivityService.js`, `services/Analytics/securityMonitorService.js`,
  `controllers/Analytics/insightsController.js`.
- Changed: `services/Analytics/analyticsService.js`, `routes/Analytics/systemAdminRoutes.js`,
  `docs/CLAUDE.md`.

### Environment (optional)

| Variable | Use |
|---|---|
| `SECURITY_IP_RELIABLE_SINCE` | ISO date of the v2.11.0 deploy. The new-network check ignores sign-in history before it (those IPs were the proxy's). |
| `SUPPORT_TIMEZONE` | Timezone for B. Buddy "outside support hours" (default `Asia/Manila`). |

### Known limits

- No IP-to-country lookup, so no country or impossible-travel signals.
- Web vs app is a user-agent guess.
- Day buckets are UTC.
- Regular user tokens never expire. This is noted as a known risk and intentionally **not** changed,
  because it could affect live mobile users.

---

## BB-112 — Live Server ✅ Complete (server)

**Why:** only one person could see the live logs (in Render). This gives all system admins a
watch-only view in the dashboard, behind 2FA. It can't restart, deploy, change settings or data,
or run anything.

### How it works

- `src/utils/serverMonitor.js`, installed first thing in `server.js`, copies every line the process
  prints (`console.*` and winston's Console transport) into an in-memory buffer of the last
  **2,000 lines**. The original write always runs, so Render's logs are unchanged; if capture fails
  the line is skipped and nothing breaks.
- Before a line is stored, passwords, PINs, OTPs, tokens, secrets, recovery codes, `Authorization`
  and `Bearer` values, JWTs, bcrypt hashes and database-URL credentials are replaced with
  `[REDACTED]`. Lines are cut at 2,000 characters. Colour codes are stripped.
- Nothing is written to disk or the database. The buffer resets on every deploy or restart.
- `requestLogger` feeds per-minute request counters (last 15 minutes) for the health card. The
  page's own polling is left out of those counters.

### Endpoints (all three system admins)

- `GET /api/system-admin/server/logs?after=&level=&q=&limit=&poll=` — lines with `seq` greater than
  `after` (0 = initial load). `level`: `error` | `warn` | `info` (that level and more severe).
  Returns `lines[]` (`seq`, `time`, `level`, `stream`, `text`), `lastSeq` (the next `after`), `gap`
  (lines were dropped between polls), `truncated`, `buffered`, `capacity`, `oldestAt`, `capturing`.
- `GET /api/system-admin/server/health?poll=` — `status` (`ok` | `degraded` | `down`), `warnings[]`,
  Render instance info (service, instance id, commit, branch), process (uptime, Node version,
  memory, CPU %, event-loop delay), database ping, requests (last 5 minutes: total, per minute,
  4xx/5xx, server-error rate, average and p95 response time, plus a 15-minute per-minute series),
  and buffer size.

### Files

- New: `utils/serverMonitor.js`, `services/Analytics/serverMonitorService.js`.
- Changed: `server.js` (installs capture first), `middlewares/requestLogger.js` (request counters; `poll=1` not stored),
  `controllers/Analytics/insightsController.js`, `routes/Analytics/systemAdminRoutes.js`, `docs/CLAUDE.md`.

### Audit

Opening the page is recorded in `RequestLog` with the system admin's id. Refresh polls
(`poll=1`) are **not** stored, so the page doesn't flood the request log.

### Known limits

- No build, deploy or crash output: a crash ends the process, and the buffer goes with it. Use Render for those.
- One buffer per server instance. Today there is one instance.
- Levels are inferred: winston's prefix when present, otherwise keywords and stdout/stderr.
- Emails and other non-secret data in log lines stay visible to system admins.
- Polling is limited by the global rate limit (500 requests / 15 min per IP). The UI should poll
  logs every 5 seconds and health every 15 seconds, and pause while the tab is hidden.

---

## BB-112 — Capacity (Performance page) ✅ Complete (server)

**Why:** to decide, from data, when to upgrade the Render instance or the database plan, or which
APIs to fix first. Before this, `/system-admin/performance` loaded every request-log row into
memory and had no server or database history.

### History: `ServerMetricSample` (new table, additive)

- **The sampler** (`services/Analytics/capacityService.js`, started at boot) saves one row per
  instance **every 5 minutes**:
  - CPU (as a share of the container's CPU limit), memory vs the container's memory limit,
    event-loop delay
  - **peak requests in progress at once**
  - request count, 5xx errors, average and p95 response time
  - database ping latency, connections in use vs `max_connections`
  - **connection-pool timeouts** (Prisma P2024, i.e. requests queueing for a database connection)
- **It runs only on Render** (`RENDER=true`) or with `CAPACITY_SAMPLING=true`, so a laptop pointed
  at the same database doesn't add its own samples.
- **Retention:** rows older than **30 days** are deleted once a day, **from this table only**.
- **Before the SQL script is applied:** the sampler logs one `[BB-112] Capacity sample not saved`
  warning and keeps going. The page still answers and says there's no history yet.
- **Requests in progress:** `requestLogger` counts them, and the counter goes down on
  `finish`/`close`, so aborted requests can't leak.
- **Pool timeouts:** detected from the server's own log output.
- **Container limits:** read from cgroup (`/sys/fs/cgroup`). `SERVER_MEMORY_LIMIT_MB` and
  `SERVER_CPU_LIMIT` override them.

### Endpoints (all three system admins, read-only)

- `GET /api/system-admin/capacity?days=7` (1–30). Returns `overall` (`ok` | `watch` | `upgrade`),
  a plain `recommendation`, and three gauges, each with its own `verdict` and `reasons[]`:
  - **`server`:** CPU p95, average and share of time at 80%+; memory p95 vs limit; event-loop p95
    and share of time slow; peak and p95 requests in progress; restarts; plus the live process
    stats.
  - **`database`:** latency now and p95; connections now, peak and max; pool timeouts; size vs
    `DB_STORAGE_LIMIT_MB` (when set); cache hit %.
  - **`hotspots`:** the top 25 endpoints by **total server time** (calls × time), with calls,
    average, p95, p95 vs the previous period, share of all server time, slow calls and 5xx.
- `GET /api/system-admin/capacity/history?days=7`: chart points, at 5-minute resolution up to
  2 days and hourly beyond that.
- `GET /api/system-admin/performance`: **same response shape as before**, now computed in the
  database (`percentile_disc`) instead of in memory.

### Verdict rules

| Gauge | Watch | Upgrade |
|---|---|---|
| Server CPU | p95 ≥ 60%, or ≥ 80% in under 10% of samples | ≥ 80% in 10%+ of samples |
| Server memory | p95 ≥ 70% of the limit | p95 ≥ 85% of the limit |
| Server responsiveness | event-loop delay ≥ 200 ms in 5%+ of samples | — |
| Restarts | more than 1 in the period (deploys count) | — |
| Database connections | peak ≥ 60% of max | peak ≥ 80% of max |
| Pool timeouts | 1–9 | 10+ |
| Database latency (`SELECT 1`) | p95 ≥ 50 ms | p95 ≥ 150 ms |
| Cache hit | < 95% | < 90% |
| Storage (needs `DB_STORAGE_LIMIT_MB`) | ≥ 70% | ≥ 85% |
| API hotspots | one endpoint uses ≥ 30% of server time; p95 ≥ 3 s (20+ calls); p95 50%+ slower than the previous period | — |

### Files

- New: `services/Analytics/capacityService.js`, `scripts/bb112-server-metric-samples.sql`.
- Changed:
  - `prisma/schema.prisma` (`ServerMetricSample`)
  - `utils/serverMonitor.js` (requests in progress, pool timeouts, container limits)
  - `middlewares/requestLogger.js`
  - `services/Analytics/analyticsService.js` (`/performance` in SQL)
  - `controllers/Analytics/insightsController.js`
  - `routes/Analytics/systemAdminRoutes.js`
  - `server.js` (starts the sampler; boot banner line)
  - `docs/CLAUDE.md`

---

## BB-108 — Import Punch Logs: pre-filled template ✅ Complete (confirmed and passed dev testing 2026-10-28)

**Why:** the punch-log template was blank, so admins typed every employee and date by hand. It
now works like Upload Schedule (BB-103): pick dates and employees, and get a file where only
clock-in and clock-out need filling.

### `GET /api/punch-log-import/template` (changed)

- New query: `startDate`, `endDate` (YYYY-MM-DD, up to **31 days** inclusive), and `userIds`
  (comma-separated) **or** `departmentId`. Neither means every employee in scope.
- Columns: `name, email, date, clockIn, clockOut, punchType, reason, notes`. One row per
  **active, human** employee × date, sorted by name then date. No example row.
- Supervisors: own department only. Another department or person returns 403. Over
  **2,000 rows** (employees × days) or no matching employees returns 400 with the numbers.
- Filename: `punch_logs_<startDate>_to_<endDate>.csv`.
- Without `startDate`/`endDate` it returns the original blank template, unchanged.

### `POST /api/punch-log-import/upload` (changed)

- A row with **both** clockIn and clockOut empty is a day off. It's skipped and counted, never failed.
- Only one of them empty fails with "Missing clock-in." / "Missing clock-out."
- Limits: **2,000 rows** in the file and **500 rows with punches** (was 300 rows in total). Over
  either limit returns 400 before anything is written.
- Response (207) adds `data.skipped` (number) and `name` ("Last, First", or null when unmatched) on every
  `created` / `failed` row. Message: "Import complete. X imported, Y failed, Z blank rows skipped."
- Matching, validation, cutoff locks, overnight roll-over and duplicate checks are unchanged. The
  upload still accepts inactive employees (no status filter), so former staff can be back-filled by
  adding their rows by hand.

### Files

- New: `services/Features/importTargets.js`, holding the shared `loadActor`, `displayName`,
  `resolveTargetEmployees`, `parseDateRange` and `ImportError`, moved out of `scheduleImportService`.
- Changed: `services/Features/punchLogImportService.js`, `controllers/Features/punchLogImportController.js`,
  `utils/csvPunchLogParser.js`, and `services/Features/scheduleImportService.js` (uses the shared
  helpers; `ScheduleImportError` is now an alias of `ImportError`; no behaviour change).

### Client

The client builds the setup section (date range, target employees) and shows `skipped` and `name`
in the results. **Deploy the server first.**

### Follow-up: guide rows and clock-time formats ✅

- **Guide row in both templates,** right after the header, with first cell
  `# GUIDE - not imported`:
  - **Import Punch Logs:** the pre-filled template and the old blank one. In the blank one the
    guide row replaces the example row, which used to get imported if left in. Its first column is
    `date`, so the marker goes there.
  - **Upload Schedule:** `name` holds "Mark x (or 1 / yes) under each slot to schedule", `date`
    holds `YYYY-MM-DD`, and there's one example `x` under the first slot.
- **Skipping:** any row whose **first cell starts with `#`** is skipped when the CSV is parsed
  (`csvPunchLogParser`, `csvScheduleParser`):
  - It isn't imported, failed, or counted as skipped, and it doesn't count towards the row limits.
  - It never becomes a schedule preview item, in the new or the legacy preview.
  - Other rows keep their real line numbers.
  - A file with only guide rows returns 400 "CSV file has no data rows."
- **`punchType` guide text:**
  - B&C (`BNC_COMPANY_IDS`): "REGULAR or TRAINING (blank = REGULAR)".
  - Every other company: "REGULAR | DRIVER_AIDE | DRIVER_AIDE_AM | DRIVER_AIDE_PM | TRAINING (blank = REGULAR)".
- **Clock times in Import Punch Logs** are now read strictly in the company's time zone. Before,
  `8:00`, `8:00 AM` and `8:00:00 AM`, which spreadsheets often write on save, were guessed in the
  **server's** time zone, giving "Invalid…" or a time shifted by hours.
  - **Accepted:** `08:00`, `8:00`, `08:00:00`, `20:00`, `8:00 AM`, `8:00:00 AM`, `8 AM`, `8:00AM`.
  - **Anything else** fails with `Invalid clock-in time "…". Use 08:00 or 8:00 AM.` (and the same for
    clock-out).
  - A time cell that carries its own date and offset is used as before.
  - The single punch-request flow (`parseClockTime`) is unchanged.
- **Files:** `utils/csvPunchLogParser.js`, `utils/csvScheduleParser.js`,
  `services/Features/punchLogImportService.js`, `controllers/Features/punchLogImportController.js`.

### Follow-up: supervisors import for their whole team ✅

- **Why:** the employee picker (`GET /api/employee/team`, BB-080) offers a supervisor their own
  department **plus their direct reports in other departments**. The imports only accepted the
  supervisor's own department, so picking a direct report gave a 403 and no template.
- **Change:** Import Punch Logs (template and upload) and Upload Schedule (template, preview,
  confirm, legacy preview and confirm) now use the same team rule. A supervisor's team is their own
  department **or** anyone whose `EmploymentDetail.supervisorId` is them. Admins are unchanged.
  The shared helpers `teamWhere` / `inTeam` are in `services/Features/importTargets.js`.
  - With `departmentId` (their own), the template covers that department only.
  - With neither `departmentId` nor `userIds`, it covers the whole team.
  - A supervisor with no department can still import for direct reports. Before, they got
    "You aren't assigned to a department."
- **Messages:** row errors say "Employee not found in your team." The template's 403 now says
  "N of M selected employees are inactive or outside your scope."
- **Logging:** the server logs `[BB-108] Punch log template refused …` with the query and the
  reason for each refused id. The reasons stay in the log and aren't sent to the client.
- **Client:** keep the picker on `/employee/team`, but show only `status === "active"`. That
  endpoint also returns inactive people. On a non-200 template response, show the JSON `message`.
- **Backtrack punch-log import (BB-086)** follows the same team rule:
  - **Preview:** name matching now uses the supervisor's team, **active people only**. Before, it
    used the own department and included inactive people, which commit then refused.
  - **Commit:** checks the team, and the error reads "Employee not found in your team."
  - **Not changed:** the auto-picked cutoff period is still the supervisor's own department or a
    company-wide one, because cutoff periods belong to departments.
  - **Files:** `services/Features/backtrackImportService.js`,
    `controllers/Features/backtrackPunchLogImportController.js`.

---

## BB-107 — Inactive accounts receive nothing ✅ Complete (server, part 1)

**Why:** before retiring and renaming companies, deactivated accounts must stop receiving
anything. Until now, setting a user to inactive blocked sign-in and the missed clock-in/out
emails, but the user still got push reminders, in-app and push notifications, new shifts, and
password-reset emails.

- `notificationService.createNotification`: skips inactive or deleted recipients. No in-app entry,
  socket event or push.
- `notificationService.sendEmailNotification`: skips inactive or deleted recipients (returns
  `{ success: false, skipped: true }`, no email log).
- `workers/clockInReminderWorker.js` and `workers/clockOutReminderWorker.js`: active users only.
- `jobs/generateUpcomingUserShifts.js`: no new shifts for inactive users ("assigned to all" and
  single-user schedules).
- `resetPasswordController.requestPasswordReset`: no reset email for inactive accounts. The same
  generic response is returned, so this reveals nothing.

**Deactivating signs the person out (web and mobile):**
- `authMiddleware`: a non-active account gets 401 `TOKEN_VERSION_MISMATCH` ("Your account is
  inactive…") on its next request, whatever token it holds. Web and mobile already sign out on
  that code.
- `employeeController.updateEmployee`: switching an employee from active to inactive or deleted
  bumps `tokenVersion` (so reactivating doesn't revive old sessions) and clears `deviceToken`.

Not changed: sign-in (already refused), welcome emails (only for new active users), and token
expiry (left as is by decision; this only affects non-active accounts).

## BB-107 — Retire and rename old companies ✅ Done (data, 2026-10-28)

`scripts/bb107-retire-companies.js` (one company per run, matched by id). For each company it:
- deactivates every user,
- signs everyone out (`tokenVersion` + 1) and clears push tokens,
- turns off the three notification switches,
- renames the company.

It writes a backup first, and `--restore=<backup>` undoes it. Data (time logs, payroll, leave,
cutoffs) is untouched. The companies were first renamed AAA–EEE, then renamed again so retired
companies sort last:

| Company | Now |
|---|---|
| BizMobile Development Inc. | ZZZ Company |
| BizSolutions LLC (old) | YYY Company. A new BizSolutions LLC will be created. |
| Comfort Homes | XXX Company |
| Nikey | WWW Company |
| Team Geo | VVV Company |

Kept: B&C Residential LLC, Piedmont Adult Day Program, and Sunshine Learning (test company).

**`test` deleted** with `scripts/bb107-delete-company.js`. The script is locked to that one company.
It works in one transaction and exports the rows before deleting. It removed 1 user, 1 time log, a
subscription and a few notifications. The 136 request-log rows were kept, with the company and user
link cleared. The backup is `scripts/backup-bb107-delete-cmuqfhyq70003v7obaiilslzx-2026-10-28T09-33-21-621Z.json`.

**Companies table** (`GET /api/system-admin/bbuddy/accounts`): each company now has `activeUsers`
(people, not counting B. Buddy) and `isRetired` (no active people). Retired companies are listed last.
The dashboard greys them out, shows "Not set up" instead of a red "Missing", and has a "Hide retired"
filter.

### Add company (system-admin dashboard, all three admins)

The dashboard creates only the shell: the company and its owner (admin), plus optionally its
B. Buddy and one support staff member. Everything inside the company (departments, shifts,
policies, employees) is set up through B. Buddy in the Company panel, so it's audited.
Logic: `services/Analytics/companyProvisionService.js`.

- `POST /api/system-admin/provision-company` (was "Postman only"):
  - Required: `companyName`, `ownerFirstName`, `ownerLastName`, `ownerEmail`, `ownerPassword`
    (at least 8 characters).
  - Optional: `timeZone`, `ein`, `businessEmail`, `dba`, `phoneNumber`, `addressLine1/2`, `city`,
    `state`, `postalCode`, `country`, `currency`, `ownerPhone`, `subscriptionPlanId`,
    `setupBBuddy` (default true), `supportAgentId`, `sendWelcomeEmail` (default true).
  - **The owner email may already exist in other companies.** This used to be refused globally.
    The response lists those companies in `ownerOtherCompanies`.
  - The name is checked case-insensitively. Business email and EIN are checked first and return
    409 `{ message, errors: { field } }` instead of a 500.
  - `company.userId` is now set to the owner, the same as signup.
  - Usernames follow the employee convention (`ccorcuera`, `ccorcuera1`, …).
  - Assigning a support staff member moves them to the new company (one company each);
    `supportAgent.movedFrom` says where from.
  - The welcome email never fails the request; the response's `welcomeEmail` is `sent`, `failed`
    or `skipped`.
- `POST /api/system-admin/provision-company/check`: live form validation. Takes `companyName`,
  `businessEmail`, `ein` and `ownerEmail`, and returns `{ ok, errors, ownerOtherCompanies }`.
  Nothing is written.
- `GET /api/system-admin/subscription-plans`: the plan dropdown.
- `POST /api/system-admin/bbuddy/accounts/:companyId`: **Set up B. Buddy** for an existing company.
  Returns 409 if it already has one. It replaces running the create script per company.
- Self-signup still creates B. Buddy automatically.

**Follow-ups:**
- Create the new BizSolutions LLC with **Add company** and assign BIZ-002 in the same form. Its
  business email and EIN must not match YYY Company's (both are unique).
- Viewing a retired company's old data later: use **Set up** for its B. Buddy and assign a staff
  member, or restore the company from its first backup. YYY already has a B. Buddy, which is
  inactive, so Set up returns 409 for it. Reactivating a B. Buddy isn't built yet.

---

## Security hardening

- **`app.js` — `app.set("trust proxy", 1)`** for Render. Before this, `req.ip` was Render's proxy for
  every user, so rate limiters counted all users together (e.g. the sign-up and system-admin login
  limits were effectively global).
- **`requestLogger`** logs `req.ip` instead of the raw `X-Forwarded-For` header, which clients could
  forge. **Verify after deploy:** the `ipAddress` in B. Buddy Activity should match your real IP.
- **`/api/account/login`** (the endpoint clients use) had no strict limit: new limiter, 20 **failed**
  attempts / 15 min per IP (successful sign-ins don't count, so an office sharing one IP isn't
  blocked). `/api/system-admin/auth/2fa` added to the auth limiter.
- **No fallback system-admin secret:** without `SYSTEM_ADMIN_JWT_SECRET` the tier returns 503
  instead of accepting tokens signed with a secret visible in source.
- **Request-log redaction:** `queryParams` are now sanitized (legacy `GET /account/sign-in` was
  storing plain-text passwords); `agentpin` and `recoverycode` added to the redacted fields.

---

## Schema & scripts

Run in this order, each followed by `npx prisma generate`, then restart:

| Script | Adds | Status |
|---|---|---|
| `bb110-add-system-agent.sql` | `User.isSystemAgent`, `SupportAgent`, `RequestLog.isSystemAgent/agentId` + indexes | Applied |
| `bb110-support-agent-companies.sql` | staff ↔ company link, `archivedAt` | Applied |
| `bb110-support-agent-pin-lockout.sql` | `failedPinAttempts`, `pinLockedUntil` | Applied |
| `bb110-system-admins.sql` | `SystemAdmin`, `RequestLog.systemAdminId` | Applied |
| `bb110-support-agent-single-company.sql` | `SupportAgent.companyId`; drops the link table and `allCompanies` (refuses to run while anyone has 2+ companies) | Applied 2026-10-27 (EMP-1001 kept Sunshine Learning) |
| `bb112-server-metric-samples.sql` | `ServerMetricSample` table + `createdAt` index. **Additive only:** `CREATE TABLE IF NOT EXISTS`, in a transaction, touches nothing existing. | Pending |

Per the migration workflow, each schema script is deleted once it's applied. The five `bb110-*.sql`
scripts were applied and **deleted on 2026-10-28**, and their content lives in `schema.prisma`. The data
scripts and their backup JSON stay:
- `bb110-create-bbuddy-accounts.js`
- `bb110-create-system-admin.js`
- `bb107-retire-companies.js`: applied 2026-10-28 to five companies. Keep the **first** backup
  of each company for `--restore`.
- `bb107-delete-company.js`: applied 2026-10-28, `test` deleted. Locked to that company.

BB-107 and BB-108 need no schema changes.

## Environment

| Variable | Change |
|---|---|
| `BBUDDY_EMAIL` | **New** — shared B. Buddy email |
| `BBUDDY_PASSWORD_HASH` | **New** — bcrypt hash (`bb110-create-bbuddy-accounts.js --hash`) |
| `SYSTEM_ADMIN_JWT_SECRET` | Now **required** (no fallback) |
| `SYSTEM_ADMIN_USERNAME`, `SYSTEM_ADMIN_PASSWORD` | **Retired** — remove |
| `SECURITY_IP_RELIABLE_SINCE` | Optional (BB-112). Deploy time; the new-network signal ignores older sign-in IPs. |
| `SUPPORT_TIMEZONE` | Optional (BB-112). Defaults to `Asia/Manila`. |
| `DB_STORAGE_LIMIT_MB` | Optional (BB-112 Capacity). The database plan's storage, for the storage gauge. |
| `SERVER_MEMORY_LIMIT_MB`, `SERVER_CPU_LIMIT` | Optional (BB-112 Capacity). Override the container limits if they can't be read. |
| `CAPACITY_SAMPLING` | Optional (BB-112 Capacity). `true` turns on sampling outside Render. Leave it off locally. |

## Error codes (`docs/ERROR_CODES.md`)

`SYSTEM_AGENT_NOT_ALLOWED`, `SYSTEM_AGENT_PROTECTED`, `AGENT_IDENTITY_REQUIRED`,
`AGENT_IDENTITY_INVALID`, `AGENT_NOT_ASSIGNED`, `AGENT_LOCKED`, `INVALID_CREDENTIALS`,
`MFA_INVALID_CODE`, `MFA_TOKEN_INVALID`, `ADMIN_LOCKED`.

## Client contract (web, mobile, system-admin dashboard)

- **Company picker:** `isSystemAgent` → "Internal" badge, "B. Buddy" subtitle, hide "Forgot your
  password?".
- **Sign-in:** staff code + PIN step on `AGENT_IDENTITY_REQUIRED`; messages for
  `AGENT_IDENTITY_INVALID`, `AGENT_NOT_ASSIGNED`, `AGENT_LOCKED`.
- **After sign-in:** `user.isSystemAgent` → Company panel only, employee panel and delete-company
  hidden; handle `SYSTEM_AGENT_NOT_ALLOWED` / `SYSTEM_AGENT_PROTECTED`.
- **System-admin dashboard:** two-step 2FA sign-in (QR via local `qrcode.react`, recovery-codes save
  screen), My account, System Admins (owners), Support Staff (single company dropdown, Locked /
  Not assigned states), B. Buddy Activity (+ Admin activity tab), Database page.
- **Shared `systemAdminFetch`:** Bearer token on every call (logout included), redirect on 401.
- **BB-112 dashboard pages:** User Activity Analytics (`/activity/*`), Security Monitor
  (`/security/signals`), Live Server (`/server/logs` every 5 s, `/server/health` every 15 s, both with
  `poll=1` after the first load; pause while the tab is hidden), top nav centred.
- **BB-108 Import Punch Logs (web):** setup section (date range ≤ 31 days, all / department /
  specific employees, live row count ≤ 2,000), JSON errors on template download, `skipped` and
  `name` in results, 500 punch rows per upload, longer "Importing…" state.
- **BB-108 follow-up (web):** the guide row in both templates, the accepted clock-time formats, a
  picker that shows active employees only, the template's `message` shown on any non-200 response,
  and the "…in your team" row error. Full text: `docs/client-update-BB-108-followup.md`.
- **BB-107 (web and mobile):**
  - A 401 `TOKEN_VERSION_MISMATCH` now also means "account deactivated". Sign the user out and
    show the server's `message`. No change is needed if this is already handled.
- **BB-107 (system-admin dashboard):**
  - **Companies table:** retired companies are greyed out, with a "Hide retired" filter. A grey
    "Not set up" replaces the red "Missing", with a **Set up** button
    (`POST /bbuddy/accounts/:companyId`). The "Account status" column becomes "B. Buddy status".
  - **Add company form:** live checks via `/provision-company/check`, a plans dropdown, a B. Buddy
    checkbox, a support-staff picker with a move warning, a welcome-email checkbox, and a success
    screen.
  - **Support Staff dropdown:** leave out retired companies.

## Deploy order

1. Apply the scripts above, `npx prisma generate`.
2. Create the first owner: `node scripts/bb110-create-system-admin.js --owner`.
3. Set `BBUDDY_EMAIL`, `BBUDDY_PASSWORD_HASH`, `SYSTEM_ADMIN_JWT_SECRET`; remove the retired vars.
4. **Deploy server and the dashboard's 2FA sign-in together** — the old one-step system-admin login
   no longer issues tokens, so a server-only deploy locks everyone out of the dashboard.
5. Check `ipAddress` in B. Buddy Activity matches your real IP.
6. Roll B. Buddy out to the remaining companies: `--all` dry run, then `--apply`.
7. Set `SECURITY_IP_RELIABLE_SINCE` to the deploy time (BB-112).
8. BB-108: the server must be live before the client's new Import Punch Logs screen ships.
9. BB-107: create the new BizSolutions LLC from **Add company**. Use Jhenelle's email as owner,
   with B. Buddy on and support staff BIZ-002. Its business email and EIN must differ from
   YYY Company's.
10. BB-107: use **Set up** on B&C Residential and Piedmont Adult Day Program if they should have
    B. Buddy. This replaces step 6's script for the remaining companies.
11. BB-112 Capacity: apply `bb112-server-metric-samples.sql` (additive; Render's `prisma db push` on
    start would also create it). Optionally set `DB_STORAGE_LIMIT_MB`. About 5 minutes after the
    deploy, check that the Performance page shows its first sample and that the memory limit was
    read (otherwise set `SERVER_MEMORY_LIMIT_MB`).

## Known issues / follow-ups (not in this release)

- **OTP cleanup never runs:** `jobs/cleanupExpiredOtps.js` isn't scheduled, and it calls
  `process.exit` so it can't be scheduled as-is. Expired OTPs and spent reset tokens accumulate.
- **Company self-deletion is broken:** `accountDeleteController` calls `prisma.shiftRecurrence`,
  which doesn't exist in the schema — `DELETE /account/delete` errors every time.
- **Retention:** windows to be chosen from the Database page; then staged cleanup scripts.
- **System-admin TOTP secrets** are stored unencrypted (common practice); encryption at rest is a
  possible follow-up.
- **Remote-access controls** (country lock, new-network alerts) were discussed and not built.
