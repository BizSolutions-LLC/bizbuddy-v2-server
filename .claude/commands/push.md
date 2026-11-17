---
description: Prepare and push a release (one version per push)
argument-hint: [minor] [optional note, e.g. which tickets to include]
---
Prepare a release push. Arguments: $ARGUMENTS

Follow "Versioning & releases" in CLAUDE.md exactly. A version is a push, not a ticket: everything ready now ships as ONE version.

## 1. What's ready (read-only)
- Read the "Current state" section of CLAUDE.md. List every ticket that is done but not pushed yet, plus any built-but-awaiting-test work the user says to include. That list is this version's content. If unsure about a ticket, ask.
- Run `git status`. Split the files into **goes in** and **stays out**. Stays out: test/report PDFs and xlsx in `docs/`, `docs/Screenshots/`, schema SQL scripts (`scripts/add-*.sql` and others the user runs by hand), and anything git-ignored. Never use `git add -A` or `git add .`.

## 2. Sync with master (read-only until the checkpoint)
- `git fetch origin`.
- Check the last release branch is merged: `git branch -r --merged origin/master | grep release/`. If the latest `origin/release/*` is NOT merged into `origin/master`, stop and ask: wait for the merge, or stack on it.
- The new branch will start from `origin/master`. If carrying the working changes over would conflict, stop and report. No stash juggling or forced moves without asking.

## 3. Pick the version
- Current = the highest of `origin/release/v*` branch names and `docs/changelog-v*.md` files (compare as numbers).
- Next = PATCH + 1. If the arguments say `minor`: MINOR + 1, PATCH = 0. MAJOR only when the user says so. Never skip a number.
- Already pushed today and merged? Still the next PATCH. A fix to a pushed branch that is NOT merged yet goes on that same branch and version: don't open a new one, and stop and ask which applies.

## 4. Prepare (file edits only; nothing committed)
- **Changelog** `docs/changelog-vX.Y.Z.md`:
  - Header: `**Branch:** release/vX.Y.Z (pushed YYYY-MM-DD)`, every ticket with its status (complete / awaiting test / planning only), schema change yes/no (+ the SQL file and order), client impact + hand-off files, mobile impact.
  - Then one `# BB-### — title` section per ticket: What, Changes (file by file), Endpoints, Order of steps, Open questions.
  - Reuse an existing per-ticket draft changelog if there is one, and merge it in. One file per version.
- **Version field:** set `"version"` to `X.Y.Z` (no `v`) in `package.json` and in `package-lock.json` (top level and `packages[""]`). Edit by hand. Never run `npm version`.
- **CLAUDE.md "Current state":** replace the "Latest push" paragraph with this one and update the tickets in "Open follow-ups" (pushed in vX.Y.Z).
- **Commit message:** `<type>: vX.Y.Z — BB-### short, BB-### short` (type = feat if any feature, else fix / docs / chore). No Co-Authored-By or other AI attribution lines.

## 5. Checkpoint (wait here)
Show: version, base (`origin/master` or stacked), branch name, the goes-in / stays-out file lists, the commit message, and the changelog header. Wait for the user's explicit go.

## 6. Push (after the go)
Explain the commands in plain words first, as their own message, then:
1. `git switch -c release/vX.Y.Z origin/master` (carries the working changes; if git refuses, stop and report)
2. `git add <each file by name>`
3. `git commit` with the message above
4. `git push -u origin release/vX.Y.Z`
5. PR into `master`: if `gh` is installed and signed in, run `gh pr create --base master --head release/vX.Y.Z --title "<commit subject>" --body "<changelog summary>"` (no AI attribution line). Otherwise give the link `https://github.com/biz-admin-carlo/bizbuddy-v2-server/compare/master...release/vX.Y.Z?expand=1`.

## 7. Report and stop
Report the branch, commit, PR link, and the next steps in order: merge the PR → SQL (if any) → `prisma generate` → deploy → data scripts (if any) → send the client hand-offs.

Never: merge the PR, deploy, run tests, run Prisma / SQL / scripts, force-push, `git reset --hard`, or rewrite pushed history.
