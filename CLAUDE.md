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
