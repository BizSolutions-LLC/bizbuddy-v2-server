---
description: Start workflow 2 — create or redo a module
argument-hint: [module/feature description]
---
Treat the following as a module to create or redo: $ARGUMENTS

Follow workflow 2 from CLAUDE.md exactly:
0. Sync with master first (see "Sync with master before starting" in CLAUDE.md): `git fetch origin`; if there's no uncommitted tracked work in progress, `git switch master && git pull --ff-only origin master`. If there is uncommitted tracked work, or the pull isn't a fast-forward, stop and ask. Untracked files (PDFs, screenshots, SQL) are fine to leave.
1. Ask clarifying questions if the scope isn't clear.
2. Consider the overall concept on both server and client sides before estimating.
3. Report scope, effort estimate, and call out any cross-repo contract changes explicitly.
4. Wait for explicit go-ahead before changing anything.
