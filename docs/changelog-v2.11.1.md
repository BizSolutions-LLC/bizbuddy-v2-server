# Changelog — v2.11.1

**Branch:** `release/v2.11.1` (2026-10-29). **Still to do after merge:** set the Render variables,
save the Baseline, and ship client v2.15.1 (see Deploy order).

> **BB-112** — The system-admin Performance page explains its numbers:
> - Every metric gets a band (excellent / good / watch / terrible).
> - "Upgrade" names the Render plan to move to and what it costs.
> - Upgrade verdicts stay provisional until there are 14 days of samples.
>
> **BB-113** — **Performance reports** as PDFs, so we can check whether changes (database URL, plan
> upgrades, endpoint fixes) actually helped:
> - A **Baseline** covers the 30 days before the database URL switch.
> - After it comes a report for **every 30 days**, each compared with the period before and with the
>   Baseline.
> - Each report is frozen once: numbers, verdicts, and the Render plans and prices in effect.
>
> **Operations (BB-112)** — Production's `DATABASE_URL` was switched from Render's **External** URL to
> the **Internal** one (2026-10-29). Database latency "now" dropped from **54 ms to 1 ms**.
>
> Ships with client **v2.15.1**.

---

## BB-112 — Performance: bands, plan-aware advice, data coverage

**Why:**
- The page said "upgrade the database" on `SELECT 1` latency alone, after only about 2 days of
  samples.
- It had no reference numbers.
- It couldn't name which plan to move to.

**Bands.** Every metric now has a band: excellent, good, watch or terrible. The tables below are
also returned as `thresholds`, so the client draws its legend from the same numbers.

| Metric | Excellent | Good | Watch | Terrible |
|---|---|---|---|---|
| Server CPU p95 | < 40% | < 60% | < 80% | ≥ 80% |
| Server memory p95 (of limit) | < 50% | < 70% | < 85% | ≥ 85% |
| Event-loop delay p95 | < 20 ms | < 50 ms | < 200 ms | ≥ 200 ms |
| DB `SELECT 1` p95 (same region) | < 5 ms | < 20 ms | < 50 ms | ≥ 50 ms |
| DB connections peak (of max) | < 50% | < 60% | < 80% | ≥ 80% |
| Pool timeouts | 0 | — | 1–9 | 10+ |
| Cache hit | > 99% | > 95% | > 90% | ≤ 90% |
| Storage (of `DB_STORAGE_LIMIT_MB`) | < 50% | < 70% | < 85% | ≥ 85% |
| Light endpoint p95 | < 200 ms | < 1 s | < 3 s | ≥ 3 s |
| Heavy endpoint p95 (approvals, timelogs, leaves, reports, payroll, system-admin) | < 1 s | < 3 s | < 5 s | ≥ 5 s |
| Long action p95 (sync, imports, bulk, PDFs, exports) | < 2 s | < 10 s | < 20 s | ≥ 20 s |
| p95 change vs previous period | faster | < +20% | < +50% | ≥ +50% |

**Verdicts.**
- Server and database verdicts use these bands. The old Watch/Upgrade limits are unchanged except
  for database latency.
- Slow `SELECT 1` on its own is now **Watch**. The reason points at the Internal vs External
  `DATABASE_URL`.
- It becomes **Upgrade** only when it is in the terrible band and either the database plan has
  ≤ 0.1 CPU or another database signal (connections, cache, storage, timeouts) is also bad.
- An endpoint is called slow when its band is watch or terrible for its class. This replaces the
  flat 3 s rule.

**Plan-aware advice.**
- `config/renderPlans.js` holds Render's web and Postgres plan tables (codes, CPU, RAM, $/mo).
  They were copied from the Render dashboard on 2026-10-29.
- With `RENDER_WEB_PLAN` / `RENDER_DB_PLAN` set, an Upgrade names the cheapest plan that adds the
  missing resource. Example: "Upgrade the database 0.1c-256mb → 0.5c-1g for more CPU (+$13/mo)".
- A storage problem says to grow the disk instead.

**Coverage.**
- A new `coverage` field reports samples, covered days vs requested days, and total history.
- Until 14 days of history exist (one cutoff cycle), a server or database **Upgrade** is shown as
  **Watch** with `provisional: "upgrade"`. The recommendation starts "Only N of 14 days of history
  so far — treat this as provisional."

**Response additions (all additive):**
- top level: `coverage`, `thresholds`, `plans.{web,db}`;
- server and database metrics: `band`, plus `poolTimeoutsBand` and `cacheHitBand`;
- `upgradeFor` and `provisional` on the server and database gauges;
- on each hotspot: `class`, `band` and `changeBand`.

**Files:**
- new: `config/renderPlans.js`;
- changed: `services/Analytics/capacityService.js`, `.env.example`.

**Client:**
- a legend, plus band colours per row;
- the gauge colour taken from the band of the metric the needle shows (connections on the database
  card), not the card verdict;
- a "Based on N of M days" note;
- the provisional marker;
- the plan line in the banner.

---

## BB-113 — Performance reports: Baseline + 30-day periods (PDF)

**Why:** the Performance page only looks back from today, and its 5-minute samples are deleted after
35 days. Without a saved record, there is no way to show that a change improved things.

**Why not calendar months:** the first draft used calendar months, and was reworked the same day:
- October mixes **before and after** the database URL switch (Oct 1–28 External, Oct 29–31 Internal).
- Month lengths differ, so totals can't be compared.
- September has no samples at all.

### How reports are cut
- **Baseline (report 0):** the 30 days ending at the production deploy that moved `DATABASE_URL` to
  the Internal URL. The admin enters that moment once (`endsAt`).
- **Periods 1, 2, 3…:** consecutive **30-day** windows from the Baseline's end. Every period has the
  same length, so all figures compare directly.
- **Comparisons:** every period is compared with the **period before it** and with the **Baseline**.
- **The Baseline's data:** server and database figures come from the ~1.5 days of samples before the
  switch (Oct 27–28), the only "before" samples there are. The coverage line says so. Endpoint and
  traffic figures cover the full 30 days from `RequestLog`.
- **Deadline:** the Baseline must be saved before its samples expire (about 2026-12-01).

### Snapshots (`CapacityReport`)
- **One row per report** (`number` 0 = Baseline). Each row holds:
  - start, end and planned end, with `isPartial` while still running;
  - the gauges, verdicts and recommendation;
  - the plans and prices in effect, and the thresholds;
  - a daily series (Los Angeles days): CPU and memory p95, database latency p95 and connections from
    the samples, plus requests, p95 and 5xx errors from `RequestLog`.
- **The same calculation as the live page:** `capacityService.computeCapacity({ …, report: true })`,
  with these differences:
  - **No live readings.** The live `SELECT 1` and connection count depend on where the report is saved
    from. A test report saved from a laptop in Manila showed 454 ms "now" over the External URL.
    Connections come from samples only.
  - **Coverage is judged inside the window,** e.g. "No 5-minute samples in this period — server and
    database verdicts are provisional", not by all-time history.
  - **Up to 5 slow endpoints in the findings,** not 3.
- **Point-in-time figures:** cache hit and size are database-wide and labelled "when saved".
- **Rebuilds:** a saved report can be rebuilt while it's running, while all its samples are still kept,
  or if it had none. Otherwise **409**, so a worse copy can't replace the original.
- **The Baseline's end can't move** once any period is saved (409), because periods are counted from it.

### Scheduled job
- **When it runs:** daily at 00:20 Los Angeles time, and once two minutes after boot.
- **What it does:** saves the **last finished period** if it's missing or still partial, so it also
  catches up after downtime.
- **Where it runs:** wherever the sampler runs (`RENDER=true` or `CAPACITY_SAMPLING=true`). The boot
  banner has a line for it.
- **The Baseline is never saved automatically,** because only a person knows the switch time.
- **Sample retention:** `ServerMetricSample` is now kept **35 days** instead of 30, so a period is
  still whole the day after it ends. The page's longest window stays 30 days.

### PDF (`utils/generateCapacityReportPDF.js`, PDFKit, US Letter)
- **First page:**
  - **Header:** logo, "Baseline Report" or "Performance Report · Period N", the dates, who saved it,
    and the data coverage.
  - **Summary:** the verdict, the recommendation, and four figure boxes (API CPU p95, DB latency p95,
    endpoints flagged, hosting per month), each with its **change vs the Baseline**.
  - **Comparison table:** this report | previous period | change | Baseline | change. Improvements are
    green and regressions red.
- **Hosting plans & cost:**
  - each service's plan, CPU, memory, disk and price, plus the total;
  - any plan change since the previous report;
  - the suggested upgrade with its price difference, or a note that it's provisional.
- **API server and Database sections:** metric tables with a rating and target, findings, and daily
  charts with dashed Watch and Terrible lines.
- **Traffic & API hotspots:**
  - requests per day;
  - the top 15 endpoints with kind, calls, p95 (by band), change **vs the prior 30 days**, change
    **vs the Baseline**, and share of server time.
- **Appendix:** how to read the report, and the thresholds used.
- **Every page:** a header with the logo (from page 2), and a footer with "Page X of Y".
- **Logo:** read from **`src/assets/bizbuddy-logo.png`**. Without it, the header uses a text
  "BizBuddy" wordmark.

### Fixes found in the first test PDF (draft September report)
- The laptop's live latency and connections no longer appear (see Snapshots).
- **Restarts** shows "—" when there are no samples, instead of "0".
- **Endpoint kinds:**
  - `…-import/preview` and `…-import/confirm` count as **Long**. The rule matched only `/import`.
  - The `cutoff-periods` and `employee` lists count as **Heavy**.
- **Layout:**
  - shorter KPI labels, no longer cut off;
  - the period on one line, with the time zone in the time;
  - a chart axis that fits the data (10k, not 20k, for a ~10k peak).

### Routes (system admin)
| Route | |
|---|---|
| `GET /api/system-admin/capacity/reports` | `{ timezone, periodDays: 30, baseline, current: { number, label, periodStart, plannedEnd }, reports: [...] }`, newest first |
| `POST /api/system-admin/capacity/reports/baseline` | Body `{ endsAt }` (ISO date-time of the switch deploy). Saves or rebuilds the Baseline. |
| `POST /api/system-admin/capacity/reports/current` | Saves the running period to date. **409** until the Baseline exists. |
| `POST /api/system-admin/capacity/reports/periods/:number` | Saves or rebuilds one period. **400** for a future period; **409** when it can't be rebuilt. |
| `GET /api/system-admin/capacity/reports/:number/pdf` | The PDF (`0` = Baseline): `bizbuddy-performance-baseline.pdf` / `-period-N[-to-date].pdf`. **404** if not saved. |

Every save is recorded with the admin's name. A report item is:
`{ number, kind, label, periodStart, periodEnd, plannedEnd, isPartial, overall, recommendation, samples, generatedBy, updatedAt }`.

### Files
- New:
  - `services/Analytics/capacityReportService.js`
  - `utils/generateCapacityReportPDF.js`
  - `src/assets/bizbuddy-logo.png` (the PDF header logo)
  - `scripts/bb113-capacity-reports.sql`: applied to the production database on 2026-10-29 and then
    removed, per the migration-script convention. Its contents are under Schema below.
- Changed:
  - `services/Analytics/capacityService.js` (start and end windows, `computeCapacity` with report mode,
    35-day retention, kind rules, restarts)
  - `controllers/Analytics/insightsController.js`
  - `routes/Analytics/systemAdminRoutes.js`
  - `server.js` (starts the job; boot banner line)
  - `src/prisma/schema.prisma` (`CapacityReport`)

---

## Operations — production database on Render's Internal URL (2026-10-29) ✅

**Why:** the BB-112 Performance page showed a trivial `SELECT 1` taking 54 ms ("now") and 221.8 ms
at p95, so it recommended upgrading the database. The API service and the database are both on
Render in **Oregon**. In the same region that query should take about 1–5 ms, which pointed at the
connection route rather than the database plan.

**Cause:** the Render web service's `DATABASE_URL` was the **External** URL
(`…@dpg-…-a.oregon-postgres.render.com/…`). Every query left Render's network, crossed the public
internet with encryption, and came back into the same data centre.

**Change (Render dashboard only, no code):**
- The web service → Environment → `DATABASE_URL` was set to the **Internal Database URL**
  (`…@dpg-…-a/…`) from the database's Connect panel. Render redeployed on save.
- Same database, user and data; only the route changed.
- The old External value is kept privately for rollback.

**Result:**

| | Before (External) | After (Internal) |
|---|---|---|
| `SELECT 1` "now" | 54 ms | **1 ms** |
| `SELECT 1` p95, 30-day view | 221.8 ms | 282.4 ms right after the switch: still almost all pre-switch samples (see below) |
| Connections peak | 36 of 103 | 45 of 103: most likely the redeploy overlap, harmless |
| Pool timeouts | 0 | 0 |

**Still to confirm:**
- **Latency p95:** judge it on the **1-day** view from 2026-10-30. The 30-day p95 only settles as the
  pre-switch samples drop out.
- **Upgrade verdict:** expected to clear once the p95 falls. On v2.11.0 it says Upgrade at 150 ms or
  more.
- **Slow endpoints:** the hotspots (approvals 9.9 s, leaves 8.9 s, timelogs 4.6 s p95, 30-day) should
  drop over the next days, since each one runs many queries in sequence. The **November report**
  (BB-113) is the first full month on the Internal URL. October's report is the "before".
- **If 1-day p95 stays high while "now" is about 1 ms:** the remaining cause is the database's
  **0.1 CPU** (`0.1c-256mb`), and the `0.5c-1g` upgrade (+$13/mo) is the next step.

**Rules from here:**
- **Production (Render):** Internal URL only.
- **Local `.env`:** stays on the **External** URL. The Internal host doesn't resolve outside Render
  (confirmed: "unable to connect" locally). Local dev, `prisma db execute` and scripts all need
  External.
- **Password resets:** the Connect panel on Render holds the original URLs, and the web service's
  variable is a copy. If the database password is ever reset, paste the new Internal URL into the web
  service.
- **Optional hardening:** restrict the database's External access (Access Control) to the team's IP
  addresses, since production no longer uses it.

---

## Schema

`CapacityReport` (new) replaces the draft `CapacityMonthlyReport`, which held only a test report and
was dropped. Applied by hand on 2026-10-29 with the now-removed `scripts/bb113-capacity-reports.sql`:

```sql
BEGIN;
DROP TABLE IF EXISTS "CapacityMonthlyReport";
CREATE TABLE IF NOT EXISTS "CapacityReport" (
  "id" TEXT NOT NULL, "number" INTEGER NOT NULL, "kind" TEXT NOT NULL,
  "periodStart" TIMESTAMPTZ(6) NOT NULL, "periodEnd" TIMESTAMPTZ(6) NOT NULL, "plannedEnd" TIMESTAMPTZ(6) NOT NULL,
  "isPartial" BOOLEAN NOT NULL DEFAULT false, "data" JSONB NOT NULL,
  "generatedById" TEXT, "generatedBy" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CapacityReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CapacityReport_number_key" ON "CapacityReport"("number");
COMMIT;
```

Render's start command (`prisma db push`) would also create the table from `schema.prisma` on
deploy.

---

## Environment

| Variable | Change |
|---|---|
| `RENDER_WEB_PLAN` | **New**, optional. Render plan code of the API service (today `0.5c-512mb`). |
| `RENDER_DB_PLAN` | **New**, optional. Render plan code of the Postgres instance (today `0.1c-256mb`). |
| `DB_STORAGE_LIMIT_MB` | Existing, now documented: the database disk in MB (5 GB → `5120`). |

Without these, the page works as before, with generic Upgrade text and no storage percentage.

## Deploy order

1. ✅ `CapacityReport` table created in the production database (2026-10-29, see Schema). Locally,
   run `npx prisma generate` and restart the dev server.
2. ✅ Logo at `src/assets/bizbuddy-logo.png`.
3. Set the three variables on the Render web service.
4. Deploy the server, then client v2.15.1. The old client ignores the new fields.
5. **Save the Baseline** from Performance → Reports, with the time of the production deploy that
   switched `DATABASE_URL` to the Internal URL (Render → web service → Events). Do it before about
   2026-12-01, while its samples still exist. Period 1 runs 30 days from that moment, and the job
   saves it the day after it ends.

## Notes

- **Database URL:** done; production now uses the Internal URL (see Operations above). Re-check it
  before paying for a bigger database.
- **BB-113 setup errors:** until the SQL script and `prisma generate` have both run, every reports
  route answers **503**: *"Performance reports aren't set up on this server yet. Create the CapacityReport
  table (docs/changelog-v2.11.1.md, Schema), then run npx prisma generate and restart the server."* Before this
  change, the routes returned a raw 500 (`Cannot read properties of undefined (reading 'findMany')`, or
  `The table … does not exist`). The scheduled job logs the same message instead.
- **Reports saved from a local server** freeze that server's environment (the plans). They no longer
  include live readings. The local `.env` reads the production database (confirmed from the test PDF's
  traffic), so local saves land in production's `CapacityReport`.
- **Request log grouping:** `normalizeEndpoint` doesn't replace prefixed IDs like `cutoff_cmnf…`, so
  `GET /api/cutoff-periods/<id>` is split into one row per period in the hotspots. The same applies to
  `approval_` / `leave_` / `schedule_` IDs. This is outside BB-113 and proposed as a separate ticket.
- The plan tables in `src/config/renderPlans.js` are copied from the Render dashboard
  (2026-10-29). Update them when Render's prices change.
