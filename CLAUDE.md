# Working Agreement — BizBuddy v2 Server

These are standing collaboration rules for this repo. Follow them on every task, regardless of how the request is phrased.

## Cross-repo context

This server repo has a companion client repo (separate repository, not merged) that communicates with it via a shared API/contract. Whenever a task touches something the client depends on — endpoints, payloads, event names, shared types — flag that explicitly so the user knows the client repo also needs changes.

## Ticket tracking

There is no external ticket tracker (no GitHub Issues, Linear, Jira). A "ticket number" is just a label the user attaches verbally for their own reference — do not attempt to look it up anywhere.

## The four workflow types

Classify every task into one of these before starting, and follow its steps.

### 1. Fix a ticket
1. Ask for the concern and a ticket number if not already given.
2. Investigate and discuss the affected files/modules first. Do **not** edit anything yet.
3. Report what's damaged/included, a rough effort/impact estimate, and flag any client-side impact.
4. Wait for explicit go-ahead before making any changes.
5. After changes, summarize exactly what was changed and why — file by file if more than trivial.
6. Do **not** run the app, run tests, or verify the fix. The user does manual, functional, and non-functional testing themselves.
7. If the user reports something failed, return to step 2 with their findings. Only treat the ticket as complete once the user confirms.

### 2. Create or redo a module
Same gate as above (discuss → estimate → wait for go-ahead → change → summarize), but before estimating, explicitly consider the overall concept on **both** server and client sides — this usually has a bigger footprint than a single fix. Call out any cross-repo contract changes clearly in the estimate.

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

## Related reference

Architecture, stack, routes, and module conventions are documented separately in `docs/CLAUDE.md`. This file is about *how we work*; that one is about *what the system is*.

## Current state (as of 2026-11-06)

**v2.11.4: pushed on branch `release/v2.11.4`** with BB-106, BB-115 and BB-118 (changelog: `docs/changelog-v2.11.4.md`). Client hand-offs: `docs/client-update-BB-106.md`, `docs/client-update-BB-115.md`, `docs/client-update-BB-118.md`.

**BB-119 Company zone + report redo: CLOSED 2026-11-11, uncommitted.** All reports are built on the server (shared PDF layout + Excel template); changelog `docs/changelog-v2.11.7.md`, client hand-off `docs/client-update-BB-119.md` (items 1–14). To ship: create `release/v2.11.7` and commit when the user asks, leaving out the two test PDFs in `docs/`. (The BB-117 proposal, BB-119 notes and `docs/BB-121/` designs were deleted 2026-11-12.)

**BB-117 Optimize Notifications: complete 2026-11-11 (user confirmed), uncommitted.** Server only, one phase; schema applied. Details in `docs/changelog-v2.11.7.md` (BB-117 section); mobile route table in `src/services/notificationTargets.js`. Retention is report-only until `NOTIFICATION_RETENTION=on`. Waiting for the mobile developer (on leave): clearing the FCM token on sign-out (biometric re-register question), routes for unlisted types, old app versions and the login header. Retired companies are not yet set `isActive = false`.

**BB-120 B. Buddy, remove access to payroll: built 2026-11-11, awaiting the user's test, uncommitted.** Server guard on all payroll prefixes + setup guide hides the payroll step for B. Buddy; client hand-off `docs/client-update-BB-120.md`. Cutoff review and hours reports stay. In `docs/changelog-v2.11.7.md`.

Remove or update this section as tickets close.
