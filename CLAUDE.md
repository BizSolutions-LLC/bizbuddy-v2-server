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

## Current state (as of 2026-11-12)

**v2.11.7: pushed 2026-11-12 on branch `release/v2.11.7`** (commit a73be23) with BB-119 (closed), BB-117 (complete) and BB-120 (pushed before the user's test). Changelog: `docs/changelog-v2.11.7.md`. Client hand-offs: `docs/client-update-BB-119.md`, `docs/client-update-BB-120.md`. The two test PDFs in `docs/` stay uncommitted.

**v2.11.8: pushed 2026-11-12 on branch `release/v2.11.8`** with BB-122 (complete), BB-123 (server side, awaiting test) and BB-114 (planning docs only). Changelog: `docs/changelog-v2.11.8.md`, which ends with every open question for the mobile developer (on leave). Client hand-off: `docs/client-update-BB-123.md`. `docs/Screenshots/` and the two test PDFs stay uncommitted.

Open follow-ups:
- BB-120: the user's test (client applies the hand-off).
- BB-117: the sign-out token clear and the unlisted routes wait for the mobile developer; retired companies not yet `isActive = false`.
- BB-121 (new cutoff page): server work reverted 2026-11-12, not in v2.11.7.
- BB-114 (Improvement of API Endpoints): **OPEN, do not close.** Plan of record: `docs/BB-114-endpoint-plan.md`; mobile questions: `docs/BB-114-mobile-questionnaire.md` (written 2026-11-12, user sends it). Batch 1 (shared Prisma client, checklist cache, timelogs count, leaves N+1) is planned only, no code yet; release right after BB-113 Period 1 ends (~2026-11-28). On resume, read the plan file first and follow it unless the user changes it.
- BB-123 (Employee Page update; the punch-logs table is done on the client): contest dialog bug. The server rejects backwards or 24h+ requested times in submit + approve; read-only `scripts/check-bb123-contest-requested-times.js` for the user to run. Contest check run (no corrupted logs; reject 4 pending in the UI); Contests blocked on locked/processed cutoffs (CUTOFF_LOCKED); Robert Ramirez data confirmed fine. Ownership check in submit held for the mobile dev (on leave); questions in the changelog. Client hand-off `docs/client-update-BB-123.md` (dialog + approver page), applied by the client-side session. Uncommitted, awaiting the user's test. Logged in `docs/changelog-v2.11.8.md`.
- BB-122 (Carlo Corcuera / BizSolutions LLC early auto clock-out): COMPLETE 2026-11-12. `liveUserService.createLiveUser` now honours `Shift.timeZone`; logged in `docs/changelog-v2.11.8.md`, uncommitted (push with the next ticket). OT in `timeLogComputeService` still reads shifts in the company zone (declined for now); bad logs fixed via appeals.

Remove or update this section as tickets close.
