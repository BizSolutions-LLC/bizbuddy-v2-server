---
description: Start workflow 1 — fix a ticket
argument-hint: [concern and ticket number if available]
---
Treat the following as a ticket to fix: $ARGUMENTS

Follow workflow 1 from CLAUDE.md exactly:
0. Sync with master first (see "Sync with master before starting" in CLAUDE.md): `git fetch origin`; if there's no uncommitted tracked work in progress, `git switch master && git pull --ff-only origin master`. If there is uncommitted tracked work, or the pull isn't a fast-forward, stop and ask. Untracked files (PDFs, screenshots, SQL) are fine to leave.
1. If no ticket number was given, ask for one (it's just a label, no tracker to check).
2. Investigate and discuss the affected files/modules only — do not edit yet.
3. Report scope, effort estimate, and any client-side impact.
4. Wait for explicit go-ahead before changing anything.
