# Working Agreement — BizBuddy v2 Server

These are standing collaboration rules for this repo. Follow them on every task, regardless of how the request is phrased.

## Cross-repo context

This server repo has a companion client repo (separate repository, not merged) that communicates with it via a shared API/contract. Whenever a task touches something the client depends on — endpoints, payloads, event names, shared types — flag that explicitly so the user knows the client repo also needs changes.

## Ticket tracking

There is no external ticket tracker (no GitHub Issues, Linear, Jira). A "ticket number" is just a label the user attaches verbally for their own reference — do not attempt to look it up anywhere.

## The four workflow types

Classify every task into one of these before starting, and follow its steps.

### 1. Fix a ticket
0. Sync with master (below).
1. Ask for the concern and a ticket number if not already given.
2. Investigate and discuss the affected files/modules first. Do **not** edit anything yet.
3. Report what's damaged/included, a rough effort/impact estimate, and flag any client-side impact.
4. Wait for explicit go-ahead before making any changes.
5. After changes, summarize exactly what was changed and why — file by file if more than trivial.
6. Do **not** run the app, run tests, or verify the fix. The user does manual, functional, and non-functional testing themselves.
7. If the user reports something failed, return to step 2 with their findings. Only treat the ticket as complete once the user confirms.

### 2. Create or redo a module
Sync with master first (below), then the same gate as above (discuss → estimate → wait for go-ahead → change → summarize), but before estimating, explicitly consider the overall concept on **both** server and client sides — this usually has a bigger footprint than a single fix. Call out any cross-repo contract changes clearly in the estimate.

### 3. Script writing (database)
- Never run scripts against the database. Never execute migrations, seeders, or queries directly.
- Only write script files when explicitly asked for one. The user runs it themselves.
- This applies regardless of task type or mode — no exceptions.

### 4. Test script creation
- Only manual/visual testing exists today — no automated functional or non-functional testing.
- When asked for tests on a piece of code, don't assume the type — propose which kinds make sense (unit, integration, e2e, load/stress, performance) and briefly say why, then let the user choose.
- Write the test scripts/files only. Do not execute them against anything, including local runs, unless explicitly told to.
- The user runs them and brings back results for interpretation/fixes.

## General rules across everything

- Never read or display contents of `.env` files, secrets, credentials, or key files.
- Never force-push or run destructive git commands (`git reset --hard`, `git clean -f`, `rm -rf`, etc.) without explicit approval each time.
- Don't run or verify code on your own initiative — always stop after making changes and give a summary, then wait.
- When in doubt about scope or intent, ask — don't assume the safer-sounding interpretation and proceed.

## Permission enforcement (`.claude/settings.local.json`)

The rules above are backed by actual tool permissions, not just instructions:
- `defaultMode: "plan"` — nothing runs without conscious approval each time.
- Hard `deny` (zero exceptions, not even prompted): all `prisma migrate`/`db push`/`db seed`/`generate` variants, `node scripts/*`, `node src/prisma/seed.js`, `npm run seed`/`prisma:sync`/`start`, `npm start`, `psql`, `pg_dump`, `pg_restore`.
- `npm run dev` and `npm test`/`npm run test` are intentionally **not** hard-denied — only gated by `defaultMode: plan` — so the user can still explicitly ask for a test run per workflow 4. Never run these on your own initiative.

## Sync with master before starting

To avoid PR conflicts, every fix (workflow 1) and module (workflow 2) starts from the latest `master`:
- `git fetch origin`. If no uncommitted tracked work is in progress: `git switch master && git pull --ff-only origin master`.
- If uncommitted tracked work exists, or the pull isn't a fast-forward, stop and ask. Untracked files (test PDFs, screenshots, SQL) can stay.
- These are read-only/sync git commands. Never `reset --hard`, force, or discard work to make a pull succeed.

## Versioning & releases (`/push`)

**A version is a push, not a ticket.** Everything ready at push time ships as ONE version, whether that's one ticket or five. The number is chosen when the push is prepared (`/push`), never while a ticket is being built. Avoid what happened on 2026-11-16: v2.11.12, .13 and .14 in one day should have been one v2.11.12.

- **Number:** `v2.MINOR.PATCH`. Each push raises PATCH by 1 and never skips a number. MINOR goes up only when the user decides (a large batch or a new module), and then PATCH resets to 0. A second push the same day, after the first is merged, is simply the next PATCH. A fix for a pushed branch that isn't merged yet goes on that same branch and version.
- **Branch:** `release/vX.Y.Z`, created from the latest `origin/master` and merged into `master` through a PR. Never commit directly to `master`. Remote stays `biz-admin-carlo/bizbuddy-v2-server`.
- **Commit:** `<type>: vX.Y.Z — BB-### short, BB-### short`, listing every ticket in the push.
- **Changelog:** one `docs/changelog-vX.Y.Z.md` per version.
  - **Header:** branch + push date, every ticket with its status, schema change yes/no, client and mobile impact.
  - **Body:** one section per ticket.
  - The header is final at push time, never left saying "uncommitted".
- **Version field:** `"version"` in `package.json` and `package-lock.json` = `X.Y.Z` on every push, edited by hand in the release commit. Never `npm version`. No git tags.
- **Client hand-off:** stays per ticket (`docs/client-update-BB-###.md`). The changelog links to it.
- **Never committed:** test/report PDFs and xlsx in `docs/`, `docs/Screenshots/`, schema SQL the user runs by hand (`scripts/add-*.sql`), and git-ignored backups. Add files by name, never `git add -A`.
- **DB order** when a push has a schema change: the user runs the SQL → `prisma generate` → deploy → only then data scripts (old Prisma clients break on unknown enum values).
- `/push` (`.claude/commands/push.md`) does all of this with one approval checkpoint before commit + push. It never merges the PR, deploys, or runs tests, Prisma or SQL.

## Related reference

Architecture, stack, routes, and module conventions are documented separately in `docs/CLAUDE.md`. This file is about *how we work*; that one is about *what the system is*.

## Current state (as of 2026-11-17)

Release history lives in `docs/changelog-v*.md`. This section holds only the latest push and the open tickets.

**Latest push: 2026-11-17, v2.11.15** on branch `release/v2.11.15` (from `origin/master` after PR #126): BB-132 Subscription Plans showcase (complete) + the release workflow (`/push`, versioning section, sync-with-master step). First push under the one-version-per-push rule; `package.json` version now tracks releases. Changelog: `docs/changelog-v2.11.15.md`. No schema change. Uncommitted on purpose: `scripts/add-company-cutoff-page-view.sql`, `scripts/add-daily-task-report.sql`, the test PDFs/xlsx and `docs/Screenshots/`.

Open follow-ups:
- BB-132 (Subscription Plans in System Admin Dashboard): COMPLETE 2026-11-17 (user confirmed), pushed in v2.11.15 (`docs/changelog-v2.11.15.md`). Read-only showcase (no edit): `GET /api/system-admin/subscription-plans/overview` + `/:id[?includeRetired=true]`; active companies only (retired counted separately), human active employees. No schema change. Client hand-off `docs/client-update-BB-132.md` (send after deploy).
- BB-128 (GPS Breadcrumbs): part 1 Employee Map COMPLETE 2026-11-16 (user confirmed), pushed in v2.11.14 (`docs/changelog-v2.11.14.md`), no schema change. `GET /api/employee-map` (date or from/to ≤ 31 days, type in|out|both, department, employee; SV team / admin company) reads existing `TimeLog.location.start/end`: heat bins + points + work sites + without-location counts. Client hand-off `docs/client-update-BB-128.md` written but NOT sent (user informs the client after). Part 2 breadcrumbs waits for the mobile dev; response already has `layers.breadcrumbs: null`.
- BB-129 (Clock-out documentation / Daily Task Report, TRIAL): COMPLETE 2026-11-16 (user confirmed), pushed in v2.11.13 (`docs/changelog-v2.11.13.md`). One report per employee per day (company-zone clock-in date), optional, no deadline, past days allowed; draft → submitted, PDF only after submit (on request, template `docs/BizBuddy_DailyTaskReport_John_Doe_2026-11-16.pdf`); SV/admin view submitted only. Setting `Company.taskReportEnabled` (default false). Endpoints `/api/task-reports`. Web only; mobile untouched. Order: user runs `scripts/add-daily-task-report.sql` → `prisma generate` → deploy. Client hand-off `docs/client-update-BB-129.md` written but NOT sent (user wants server first). Later: deadline (shift end/clock-out + grace), mobile.
- BB-120: the user's test (client applies the hand-off).
- BB-117: the sign-out token clear and the unlisted routes wait for the mobile developer; retired companies not yet `isActive = false`.
- BB-121 (Cutoff page List / Calendar type): rescoped 2026-11-16. Company-wide setting `Company.cutoffPageView` ("list" default | "calendar") on `GET`/`PATCH /api/company-settings`, admin only. BUILT, pushed in v2.11.12 (`docs/changelog-v2.11.12.md`). SQL + `prisma generate` DONE 2026-11-16; next: deploy, the client works from the hand-off. Client hand-off: `docs/client-update-BB-121.md`. Calendar Type uses the same endpoints; no API changes before BB-114 batch 1 (~11-28). Earlier reverted items wait until after that. v2.11.12 also has the exclude-note fix (`buildExcludeNote`, reason + note kept) and supervisor may save `cutoffPageView` alone (dev; decide before prod). 2026-11-16 plan: Calendar ships to prod VIEW-ONLY (client hides actions, labels hours "Preview", links to List to approve); approvals stay on List. Client audit `docs/BB-121-client-computation-audit.md` (client repo) checked: accurate; add edited-punch (originalTimeIn) preview gap. Parked: Q2 regular approval doesn't deduct lunch (payroll, List too: own ticket, read-only check first); Q1 early-minutes policy (user call); actionable Calendar after BB-114 batch 1 with a server-side preview.
- BB-114 (Improvement of API Endpoints): **OPEN, do not close.** Plan of record: `docs/BB-114-endpoint-plan.md`; mobile questions: `docs/BB-114-mobile-questionnaire.md` (written 2026-11-12, user sends it). Batch 1 (shared Prisma client, checklist cache, timelogs count, leaves N+1) is planned only, no code yet; release right after BB-113 Period 1 ends (~2026-11-28). On resume, read the plan file first and follow it unless the user changes it.
- BB-123 (Employee Page update; the punch-logs table is done on the client): contest dialog bug. The server rejects backwards or 24h+ requested times in submit + approve; read-only `scripts/check-bb123-contest-requested-times.js` for the user to run. Contest check run (no corrupted logs; reject 4 pending in the UI); Contests blocked on locked/processed cutoffs (CUTOFF_LOCKED); Robert Ramirez data confirmed fine. Ownership check in submit held for the mobile dev (on leave); questions in the changelog. Client hand-off `docs/client-update-BB-123.md` (dialog + approver page), applied by the client-side session. Uncommitted, awaiting the user's test. Logged in `docs/changelog-v2.11.8.md`.
- BB-122 (Carlo Corcuera / BizSolutions LLC early auto clock-out): COMPLETE 2026-11-12. `liveUserService.createLiveUser` now honours `Shift.timeZone`; logged in `docs/changelog-v2.11.8.md`, uncommitted (push with the next ticket). OT in `timeLogComputeService` still reads shifts in the company zone (declined for now); bad logs fixed via appeals.

- BB-124 (Josie Soriano Nov 9, DA punch vs approved sick leave): data fix COMPLETE 2026-11-13 (`scripts/fix-bb124-josie-nov9-exclude-punch.js` applied: punch excluded, leave kept, cutoff re-locked; backup JSON git-ignored, kept locally). Payroll Grid change (all-excluded days don't block SL) awaiting the user's test. Pushed in v2.11.9 (`docs/changelog-v2.11.9.md`). Declined for now:
  - `resolveConflict` isn't segment-aware for DA, and the BB-073 leave lookup still fails silently.
  - The cutoff review page still skips the leave row on a day with only excluded punches (Josie shows 72h there; the payroll export counts the 8h).
  - Conflict rows show the leave policy id instead of its name.
- BB-125 (Punch-vs-leave revert; started from Marites Fernandez 10-30): BUILT 2026-11-14, uncommitted, awaiting the user's test. Honor Punch (auto or manual) now reverts only the punched leave day (new status `reverted`, `LeaveDay.revertedAt`), matches leaves by calendar date, and handles Driver/Aide per segment (Raw). Changelog `docs/changelog-v2.11.10.md`; client hand-off `docs/client-update-BB-125.md` (incl. settings copy + mobile questions). Order: user runs `scripts/bb125-leave-revert.sql` + `prisma generate` → deploy → client → client. SQL + `prisma generate` done; client update sent. Marites's revert APPLIED 2026-11-14 (leave reverted, balance 13 → 18.5; the first try timed out and rolled back, so the scripts now use a 2-min transaction timeout). Relabel APPLIED 2026-11-14: 5 leaves cancelled → reverted (WWW Uncles Sammies, Albert Dalere, Violeta Ardevela, Evelyn Garnace ×2); backup `scripts/backup-bb125-relabel-reverted-leaves.json`, `--revert` undoes it. Pushed as v2.11.10. Multi-day leaves reverted whole under the old rule (Violeta Ardevela, Evelyn Garnace, Albert Dalere) were not re-checked per day; the user can decide.

- BB-125 audit correction (2026-11-14). Read-only audit: `scripts/check-bb125-punch-wins-history.js` (+ `.sql`). User decisions: already-paid dates stay as paid; Albert's excluded segments are trusted, no change; Evelyn's leaves are already `reverted` (relabel), nothing to return.
  - DONE: Elizabeth Pabilona 8-07 leave day reverted, +5.5h, balance 9 (`scripts/fix-bb125-elizabeth-aug07-revert-leave.js`); ledger notes reworded to "(BB-125 audit correction)" (`scripts/fix-bb125-ledger-note-wording.js`).
  - DONE: Josie Soriano's excluded Nov 9 TimeLog deleted (`scripts/fix-bb124-josie-nov9-delete-punch.js`; backup `scripts/backup-bb124-josie-nov9-delete-punch.json`, `--restore`). Nov 9 is now a plain 8h Sick Leave day. The old exclude-punch `--revert` no longer applies.
  - DONE: Robert Ramirez 9-04 segments corrected, AM 1.25 + Regular 5.5 = 6.75h, PM excluded, clock-in back to 6:38 (`scripts/fix-bb125-robert-sep04-segments.js`, backup + `--revert`). His unpaid Sick Leave stays Approved (user: fine, no pay impact).
  - DONE: Elizabeth Pabilona 8-25 leave day reverted, +5.5h, balance 14.5 (`scripts/fix-bb125-elizabeth-aug25-revert-leave.js`).
  - Code fix pushed in v2.11.11 (`docs/changelog-v2.11.11.md`): the regular daycare Honor Punch now sets `actualHours` and syncs `netWorkedHours`; before this it exported 0h. Already-paid past records are not backfilled (user decision).
  - Open: proposed feature to block leave on an already-punched day (label TBD, not BB-124).

Remove or update this section as tickets close.
