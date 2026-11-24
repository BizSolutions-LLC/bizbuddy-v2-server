---
description: Show which server version(s) shipped a ticket
argument-hint: [one or more ticket numbers, e.g. BB-125 BB-134]
---
Look up which server versions include these tickets: $ARGUMENTS

This is read-only. Do not edit files, switch branches, commit, or run the app.

1. If no ticket number was given, ask for one. Accept `BB-125`, `bb-125` or `125`, and always write it as `BB-###`.
2. Run `git fetch origin` (sync only) so the latest pushes are included. If it fails, continue with the local refs and say so.
3. For each ticket, collect both sources and match the whole ticket number (`BB-12` must not match `BB-125`):
   - Release commits on `origin/master` that name the ticket in their subject (`git log origin/master --format='%s'`). Take the `v2.X.Y` from each one.
   - Changelogs that mention it (`docs/changelog-v*.md`), sorted by version.
4. Read the lines that mention the ticket in each matching changelog and sort every version into one of two groups:
   - **Shipped:** the version changed code, schema or a doc for this ticket (it has its own section, or the release commit names it).
   - **Mentioned only:** the version names the ticket without shipping anything for it, such as a hand-over doc, a CLAUDE.md note, a status note, or another ticket using it.
5. Reply with:
   - A table: Ticket | Server version | What shipped (one short line per shipped version; a ticket shipped in several versions gets one row per version).
   - Below the table, a short note on each "mentioned only" version and why it doesn't count.
   - **For the tracker:** one version per ticket, the latest shipped version.
   - If no release commit or changelog names the ticket, say "not in any release". If CLAUDE.md "Current state" explains why (for example, done on the client only), add that in one line.
6. Answer only from the commits and changelogs. Never guess a version from memory. If the two sources disagree, show both and say so.
