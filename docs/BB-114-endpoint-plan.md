# BB-114 — Improvement of API Endpoints: plan of record

**Status:** OPEN, deliberately not closed. Planning only: **no code changed yet.** Written 2026-11-12 from the system-admin Performance page (7-day Capacity + 30-day Endpoints screenshots, `docs/Screenshots/`).

Earlier sub-item (done, v2.11.3): "BB-114 System Admin Improvement", the `ttlCache` for system-admin analytics (`docs/client-update-BB-114.md`).

---

## Timing (agreed 2026-11-12)
- **Wait for the current 30-day performance period to finish:** BB-113 Period 1, which runs from the 2026-10-29 Internal-URL switch to about **2026-11-28** (check the exact end on the Reports tab).
  - Why: batch 1 doesn't depend on more data. The wait gives a clean "before" period, so Period 2 can show what the fixes achieved. It also lets the mobile 404 drop and puts the Nov 10–11 database slowdown in context.
- **Release batch 1 right after Period 1 ends.** Judge it with Period 2 against Period 1 and the Baseline.
- **Send the mobile questionnaire now** (`docs/BB-114-mobile-questionnaire.md`). The answers feed the profile and polling decisions, which come after batch 1.

## Schedule for batch 1 (agreed 2026-11-12)
| When | Step | Who |
|---|---|---|
| ~2026-11-23 to 11-25 | Build batch 1 on a `release/` branch, uncommitted | Claude |
| Same days | Write the side-by-side check script for `/leaves` requested hours (old vs new) and run it | Claude writes it, the user runs it |
| ~2026-11-26 to 11-27 | Local testing. Nothing deployed | User |
| ~2026-11-28 to 11-29 | After the Period 1 report is saved (daily job at 00:20 LA, the day after the period ends): commit, push, deploy | User approves, Claude commits/pushes |
| ~2026-12-28 onwards | Read the Period 2 report against Period 1 + Baseline, then decide the next steps (profile, approvals, DB upgrade) | Together |

- Check the exact Period 1 end time on the Reports tab: it is 30 days after the Oct 29 Internal-URL switch.
- Don't deploy batch 1 before the Period 1 report is saved, or the "before" period gets mixed.

## What the screenshots showed (as of 2026-11-12)
- **API server:** fine (CPU 1.3%, memory 201/512 MB). Restarts are deploys.
- **Database:**
  - It's the pressure point: connections peaked at 56/103, with **2 requests timed out waiting for a connection**.
  - Ping spikes of up to 1.4 s on Nov 10–11 match a 47.6 s response peak.
  - Plan is 0.1 CPU.
- **30 days:** 105,287 calls, 495 ms average, 1,685 errors (1.6%).
- **Error notes:**
  - `GET /api/contest-policy/my-requests` (729 calls, 100% 404) was a mobile wrong path, **already fixed by the mobile side**. Expect it to drop.
  - About 76 identical errors appear on `/leaves`, `/overtime`, `/usershifts/company-stats`, `/view-allContestTimeLogs` and `/cutoff-periods`. That points to one shared cause (an incident, or one page loading them all). **To check:** a read-only RequestLog look.
  - Probably normal, not yet checked: `/account/login` 50% (wrong passwords), `/account-deletion/get-request` 30% (404 when there is none), `/disbursements/payout-provider` 47% (possibly the BB-120 B. Buddy block), `PUT /employee/:id` 26%.

## The five endpoints scanned (code read, nothing changed)
| # | Endpoint | Share / speed | What the code does | Improvement idea |
|---|---|---|---|---|
| 1 | `GET /api/account/profile` (`accountSigninController.getUserProfile`) | 18.5% of server time, ~630 calls/day, 447 ms typical | User + profile + **full Company row** + department + supervisor + subscription. Most users then run a 2nd query for the company subscription | Select only the fields used. Cache the company + subscription part per company. **Client:** fetch once per session (needs the questionnaire answers) |
| 2 | `GET /api/company-setup/checklist` (`setupGuideService.getChecklist`) | 11.6%, ~1 s typical | **15 queries per call** (14 parallel counts + company), so a burst of connections each time | Short per-company cache, cleared on guide actions. ~~Early return when dismissed~~ **dropped:** the web card still shows "Setup guide (36%)" when dismissed, so the counts are needed |
| 3 | `GET /api/cutoff-periods/:id/approvals` (`cutoffPeriodController.getCutoffApprovals`) | 2,438 calls, 3.1 s average, worst 1 min 9 s | **Writes on read** (sync, segment backfill, orphan cleanup, fixed hours, sequential auto-resolve), then about 15 mostly sequential queries | Move the writes to where data changes (clock-out, leave approval) or to the Sync button. Run the independent reads in parallel. **Payroll logic:** own design, staged (see the staged-backfill preference) |
| 4 | `GET /api/timelogs` (`timeLogController.getCompanyTimeLogs`) | +365% slower (maybe the incident) | Paginated and parallel, but runs a **redundant `count`**. TimeLog has no `companyId`, so it joins to User | Drop the count (batch 1). Later: `TimeLog.companyId` + `(companyId, timeIn)` index, a raw-SQL schema change |
| 5 | `GET /api/leaves` (`leaveController.getLeavesForApprover`) | 2.9 s typical | **N+1:** `calcRequestedHours` per leave, up to 200 at once, all in parallel, which can flood the pool | Batch-load the shifts in one query and calculate in memory, or store requested hours at submit time |

**Cross-cutting (item 0):** there are 12 `new PrismaClient()` instances, each with its own connection pool: `config/connection.js`, `middlewares/requestLogger.js`, `utils/notificationFunction.js`, `jobs/cleanupExpiredOtps.js`, `controllers/Features/requestAccountDeletionController.js`, `controllers/Cutoff/{cutoffSettingsController,cutoffGenerationService,cutoffApprovalsController}.js`, `services/Cutoff/{scheduleMatchingService,cutoffGenerationService}.js`, `services/Analytics/analyticsService.js`, and `prisma/seed.js` (leave this one alone). This is likely the main reason requests queue for a connection.

Also on the list (not in the five): the system-admin analytics first loads (20–27 s, needs the daily summary table), `POST /cutoff-periods/:id/sync` (20 s), `punch-log-import/upload` (32 s), and `/notifications` + `PUT /presence` polling (33.6k and 16k calls, load rather than speed).

---

## Batch 1: release right after Period 1 ends
Server only, with the **same responses**, so no web or mobile release is needed.

| Item | Change | Safety notes |
|---|---|---|
| 0 | Replace the 11 extra `new PrismaClient()` with the shared `prisma` from `@config/connection` (not `seed.js`) | Internal only. Straight swap in each file. Check that none of them relies on its own `$disconnect` or middleware |
| 2 | Per-company cache for `getChecklist` (`utils/ttlCache.js`, ~60 s), cleared on `updateGuide` actions | Same response. A step finished elsewhere can show up to ~60 s late. **No** early return |
| 4 | Drop `prisma.timeLog.count({ where })` and take the total from the summary query | The summary SQL **ignores the `status` filter**. Total = `activeCount` when status=active, `completedCount` when status=completed, else the sum. Both run the same User join |
| 5 | Replace the per-leave `calcRequestedHours` with one batched shift load | `requestedHours` must match exactly. **Before switching:** a side-by-side comparison on real leaves (old vs new), as done for the BB-119 reports |

**After the release:** read Period 2 against Period 1. Watch connection waits, connection peak, and each endpoint's typical and slow-call times.

## Later decisions (not batch 1)
- Profile: per-session fetch (needs the mobile answers + a web hand-off) and field slimming (needs to know which fields the clients read).
- Approvals: stop writing on read, a design proposal first.
- Polling: socket events instead of polling (mobile answers).
- `TimeLog.companyId` + index (schema change, raw SQL run by the user).
- Database plan upgrade: decide after Period 2 shows what batch 1 did.
- The ~76-error cluster: a read-only RequestLog check, written only when asked.
