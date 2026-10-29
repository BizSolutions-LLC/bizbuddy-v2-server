# Server reply — BB-112 Performance rework + BB-113 Performance reports

**From:** bizbuddy-v2-server (v2.11.1)
**For:** bizbuddy-v2-client-web (system admin → **Performance**), target **v2.15.1**
**Ship:** server first, then client. Every new field is **additive**: the current client keeps working
against the new server, it just doesn't show the new information.

What changed on the server:
1. **BB-112:** the Capacity tab's numbers come with ratings, data coverage and plan-aware upgrade
   advice.
2. **BB-113:** Performance reports as PDFs. A **Baseline** covers the 30 days before the production
   database URL switch, then there's a report for **every 30 days** after it. Each report is saved once
   and compared with the period before it and with the Baseline.

---

## 1. Client changes needed

| # | Where | Change |
|---|---|---|
| 1 | Capacity: every figure row | Show the figure's **band** (Excellent / Good / Watch / Terrible) as a coloured dot and text colour. Show its ranges on hover (see 3). |
| 2 | Capacity: the three gauges | Colour each **arc by the band of the number it shows**, not by the card verdict. Today the Database card is red while its needle shows a healthy 35%, because the red comes from latency. |
| 3 | Capacity: under the cards | Add a collapsible **"What the colours mean"** legend built from `thresholds`. Don't hard-code the numbers. |
| 4 | Capacity: top banner | Add a **coverage** line and a **plans** line (see 4). |
| 5 | Capacity: server and database cards | If `provisional === "upgrade"`, keep the **Watch** badge and add "Would be Upgrade — not enough history yet". |
| 6 | Capacity: hotspots card and table | "Flagged" uses the server's bands. Add a **Kind** column, colour **p95** by `band` and **Change** by `changeBand` (see 5). |
| 7 | Performance: new third tab | **Reports**: the Baseline and saved periods, save actions and a PDF download (see 6). |
| 8 | `lib/systemAdminFetch.js` | A way to **download a file** with the session token. Today every call parses JSON (see 7). |

---

## 2. `GET /api/system-admin/capacity` — new fields (all optional)

```jsonc
{
  "days": 30,
  "overall": "watch",
  "recommendation": "Only 2.1 of 14 days of history so far — treat this as provisional. Upgrade the database 0.1c-256mb → 0.5c-1g for more CPU (+$13/mo).",

  "coverage": {
    "samples": 608, "from": "...", "to": "...",
    "coveredDays": 2.1,        // days of samples inside the chosen window
    "requestedDays": 30,       // the window asked for
    "historyDays": 2.1,        // all samples ever
    "minimumDays": 14,
    "enough": false            // false → Upgrade verdicts are held back as Watch
  },

  "thresholds": {
    "bands": ["excellent", "good", "watch", "terrible"],
    "server":   { "cpuP95Percent": { "unit": "%", "bounds": [40, 60, 80] }, "memoryP95Percent": {...}, "eventLoopP95Ms": {...} },
    "database": { "latencyP95Ms": {...}, "connectionsPeakPercent": {...}, "poolTimeouts": {...},
                  "cacheHitPercent": { "unit": "%", "bounds": [99, 95, 90], "higherIsBetter": true }, "storagePercent": {...} },
    "endpoints": { "light": {...}, "heavy": {...}, "long": {...}, "changePercent": {...} }
  },

  "plans": {
    "web": { "current": { "code": "0.5c-512mb", "cpu": 0.5, "ramMb": 512, "monthly": 7 }, "upgradeFor": null, "next": null, "monthlyDelta": null },
    "db":  { "current": { "code": "0.1c-256mb", "cpu": 0.1, "ramMb": 256, "monthly": 6 }, "upgradeFor": "cpu",
             "next": { "code": "0.5c-1g", "cpu": 0.5, "ramMb": 1024, "monthly": 19 }, "monthlyDelta": 13, "storageMb": 5120 }
  },

  "server": {
    "verdict": "ok", "upgradeFor": null, "provisional": undefined,     // "upgrade" when held back
    "cpu":       { "p95Percent": 22.3, "band": "excellent", ... },
    "memory":    { "p95PercentOfLimit": 33, "band": "excellent", ... },
    "eventLoop": { "p95Ms": 24, "band": "good", ... }
  },
  "database": {
    "verdict": "watch", "upgradeFor": "cpu", "provisional": "upgrade",
    "latency":     { "nowMs": 54, "p95Ms": 221.8, "band": "terrible" },
    "connections": { "peakPercent": 35, "band": "excellent", ... },
    "poolTimeouts": 0,            "poolTimeoutsBand": "excellent",
    "cacheHitPercent": 98.61,     "cacheHitBand": "good",
    "storage": { "sizeMb": 1014, "limitMb": 5120, "percent": 20, "band": "excellent" }
  },
  "hotspots": {
    "endpoints": [
      { "method": "GET", "endpoint": "/api/cutoff-periods/:id/approvals",
        "class": "heavy",          // "light" | "heavy" | "long"
        "p95Ms": 9914, "band": "terrible",
        "p95ChangePercent": 67, "changeBand": "terrible", ... }
    ]
  }
}
```

- **Bands:** `bounds` are the upper limits of Excellent, Good and Watch. Anything past the last one is
  Terrible. With `higherIsBetter` (cache hit) they're lower limits instead.
- **Empty bands:** two equal bounds mean that band is empty. Pool timeouts `[1, 1, 10]` have no Good,
  so show "—".
- **Missing band:** `band` is `null` when the figure is missing, e.g. storage without a disk size.
  Show no dot.

---

## 3. Bands — colours and copy

| Band | Label | Suggested colour |
|---|---|---|
| `excellent` | Excellent | green-600 |
| `good` | Good | green-400 (text stays the normal foreground) |
| `watch` | Watch | amber-500 / amber-600 text |
| `terrible` | Terrible | red-600 |

**Hover text** on a figure row, built from its `thresholds` entry:
`Excellent < 5 ms · Good < 20 ms · Watch < 50 ms · Terrible ≥ 50 ms`
(For cache hit, use `>` and `≤`.)

**Gauge caption:** add the band after the caption, e.g. `Connections peak: 36 of 103 · Excellent`.

**Legend** (collapsible, closed by default):
- **Title:** **What the colours mean**, with the four coloured dots and labels beside it.
- **Body:** one row per metric with its ranges:

| Row label | thresholds key |
|---|---|
| API server CPU, 95th percentile | `server.cpuP95Percent` |
| API server memory, 95th percentile of limit | `server.memoryP95Percent` |
| API server event-loop delay, 95th percentile | `server.eventLoopP95Ms` |
| Database trivial query (SELECT 1), 95th percentile | `database.latencyP95Ms` |
| Database connections peak, of max | `database.connectionsPeakPercent` |
| Database pool timeouts | `database.poolTimeouts` |
| Database cache hit | `database.cacheHitPercent` |
| Database storage, of disk | `database.storagePercent` |
| Light endpoint p95 (profile, settings, simple lists) | `endpoints.light` |
| Heavy endpoint p95 (approvals, timelogs, leaves, reports, payroll) | `endpoints.heavy` |
| Long action p95 (sync, imports, bulk, PDFs, exports) | `endpoints.long` |
| Endpoint p95 change vs the period before | `endpoints.changePercent` |

**Database "Size" row hint** (when `storage.limitMb` is set): *Database only; Render's disk figure
also counts logs*.

---

## 4. Banner — coverage and plans

Keep the verdict badge and `recommendation` as they are. The recommendation text already names the
plan move. Add a small second line with up to four parts:

- **Coverage:** `Based on 2.1 of 30 days of samples`
  - When `coverage.enough` is false, add in amber:
    ` · Upgrade verdicts wait for 14 days of history (2.1 so far)`
- **API server plan:** `API server: 0.5c-512mb · 0.5 CPU, 512 MB · $7/mo`
- **Database plan:** `Database: 0.1c-256mb · 0.1 CPU, 256 MB · $6/mo`
  - When `plans.db.next` is set, add in red: ` → 0.5c-1g (+$13/mo)`. The same applies to `web`.
- **Disk:** `Disk: 5,120 MB` (from `plans.db.storageMb`)

Hide a plan part when its `current` is `null`, which means the plan isn't configured on the server.

**Held-back card** (`provisional === "upgrade"`): under the badge, in small amber text,
*Would be Upgrade — not enough history yet*.

---

## 5. API hotspots

- **Card:**
  - "Endpoints flagged" counts endpoints with 20+ calls where `band` is watch or terrible, or
    `changeBand` is terrible.
  - New hint: *Slow for its kind, or 50%+ slower, 20+ calls*.
  - If `band` is absent (an older server), keep today's rule: p95 ≥ 3 s or +50%.
- **Table:**
  - A new **Kind** column after Endpoint: Light / Heavy / Long, from `class`.
  - **p95:** coloured by `band`, bold when terrible, with the class's ranges on hover.
  - **Change:** red when `changeBand` is terrible, amber for watch, green when negative.
  - **Description:** add *p95 is judged by kind: a light read should be far faster than a long sync.*

---

## 6. New tab: Performance → Reports (BB-113)

Tabs become **Capacity · Endpoints · Reports**.

**How reports work** (for the copy and empty states):
- **Report 0 is the Baseline:** the 30 days ending at the production deploy that switched the
  database connection. An admin saves it once and enters that moment.
- **Periods:** Period 1, 2, 3… are consecutive 30-day windows from the Baseline's end. The server
  saves each one automatically the day after it ends.
- **Running period:** it can be saved "to date" at any time as a preview.
- **Finished reports don't change,** so they stay comparable.

### Endpoints

| Call | Returns |
|---|---|
| `GET /api/system-admin/capacity/reports` | `{ timezone: "America/Los_Angeles", periodDays: 30, baseline: Report \| null, current: { number, label, periodStart, plannedEnd } \| null, reports: Report[] }`. `reports` is newest first, Baseline last; `current` is `null` until a Baseline exists. |
| `POST /api/system-admin/capacity/reports/baseline` | Body `{ "endsAt": "2026-10-29T01:40:00.000Z" }`: the switch time as an ISO date-time. Saves or rebuilds the Baseline and returns a `Report`. **400** for a missing, invalid or future time; **409** when periods already exist and the time differs, or the Baseline can no longer be rebuilt. |
| `POST /api/system-admin/capacity/reports/current` (no body) | Saves the running period to date and returns a `Report`. **409** "Save the Baseline first…" until there is one. |
| `POST /api/system-admin/capacity/reports/periods/:number` (no body) | Saves or rebuilds one period. **400** for a future period; **409** when it can no longer be rebuilt. |
| `GET /api/system-admin/capacity/reports/:number/pdf` | `application/pdf` (`0` = Baseline), with `Content-Disposition: attachment; filename="bizbuddy-performance-baseline.pdf"` or `…-period-3[-to-date].pdf` (exposed through CORS). **404** `{ message }` if not saved. |

`Report` = `{ number, kind: "baseline" | "period", label: "Baseline" | "Period 3", periodStart,
periodEnd, plannedEnd, isPartial, overall, recommendation, samples, generatedBy, updatedAt }`.

Saving takes a few seconds. All errors come back as `{ message }`. **503** means the reports aren't set up on that server yet; show the message as-is.

### Layout and copy

**Intro text (left):**
*A PDF every 30 days to check whether changes actually helped: plans and cost, the API server, the
database and the slowest endpoints — each compared with the period before and with the Baseline.*

**When there is no Baseline yet** (`baseline === null`), show a setup panel instead of the table:
- **Title:** **Set the Baseline**
- **Body:** *The Baseline is the 30 days before production's database connection moved to Render's
  Internal URL. Every later report is compared with it. Enter the time of that deploy (Render → web
  service → Events).*
- **Field:** a date-time input labelled **Switch time**, shown in the admin's local time and sent as
  ISO UTC (`endsAt`).
- **Button:** **Save Baseline** → `POST …/reports/baseline`, then reload.

**Once the Baseline exists:**
- **Button (right), primary:** `Save Period 3 to date`, using `current.label`. Once that period is in
  the list as partial, the label becomes `Update Period 3 to date`. It calls `POST …/reports/current`,
  then reloads.
- **Card title:** **Saved reports**
- **Card description:** *Each report covers 30 days from the Baseline (Oct 29, 2026). Finished periods
  are saved automatically the day after they end and don't change afterwards; the running period can be
  saved as a preview.* Format the date from `baseline.plannedEnd`.
- **Disabled state:** disable buttons while any request is running.

**Table columns:**
- **Report:** "Baseline" or "Period 3", from `label`. Give the Baseline a small "reference" tag.
- **Dates:** `periodStart` – `plannedEnd`, e.g. "Oct 29 – Nov 28, 2026".
- **Status:** a blue **To date** badge when `isPartial`, otherwise a grey **Final** badge.
- **Verdict:** the same OK / Watch / Upgrade badge as Capacity.
- **Saved:** the date and time of `updatedAt`, with "by {generatedBy}" below when present. Scheduled
  saves come back as "Scheduled job".
- **Report:** a `PDF` button with a download icon, calling `…/reports/{number}/pdf`.

**Empty table** (a Baseline exists, nothing else yet): the Baseline row alone is fine, no empty state
needed.

**Errors:** show the server's `message` in the red error box used elsewhere on the page.

---

## 7. Downloading the PDF

`systemAdminFetch` always parses JSON, so the PDF needs a small download helper:
- **Request:** send `Authorization: Bearer <system-admin token>`, the same as `systemAdminFetch`.
- **Success:** read the response as a blob and save it under the `Content-Disposition` filename
  (fallback `bizbuddy-performance-{number}.pdf`).
- **Failure:** read the JSON `{ message }` and throw it like `systemAdminFetch` does, including the
  401 → sign-in redirect.

---

## 8. Deploy order

1. **Server v2.11.1.** First run the BB-113 SQL script and `prisma generate`, set the Render plan
   variables, and add the logo.
2. **Client v2.15.1.**

**Against a v2.11.0 server**, every addition above must fall back quietly:
- no bands, so no dots and verdict-coloured gauges as today;
- no coverage or plan line;
- no Kind column.

The Reports tab will show the server's error message, since those routes don't exist there.

After deploying, a system admin saves the **Baseline** once (section 6), before about 2026-12-01.
