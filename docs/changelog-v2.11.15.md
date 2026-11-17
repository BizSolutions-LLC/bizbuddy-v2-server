# Changelog — v2.11.15

**Branch:** `release/v2.11.15` (pushed 2026-11-17), from `origin/master` (after PR #126). **Tickets:** BB-132 Subscription Plans in the System Admin Dashboard: **COMPLETE 2026-11-17** (user confirmed). Also: the release workflow (`/push`, one version per push, sync with master). **Schema change:** none. **Client:** web System Admin Dashboard, see `docs/client-update-BB-132.md`. **Mobile:** no change.

---

# BB-132 — Subscription Plans in the System Admin Dashboard

## What
The System Admin Dashboard gets a read-only Subscription Plans page: every plan with its full details and features, and which companies are on each plan. It's a showcase only: plans can't be created, edited or deleted from System Admin. Those endpoints still exist only under the old `superadmin` user role at `/api/subscription-plans`, where deleting a plan also deletes every company's subscription to it.

Counting rules:
- Only active subscriptions count, and each company is counted once, under its latest active plan.
- "Retired" means a deactivated company (`Company.isActive = false`). Retired companies are counted separately, not as active.
- `activeEmployees` counts active human users only. B. Buddy is excluded (`HUMAN_ONLY`).

## Changes
- `src/services/Analytics/subscriptionPlanOverviewService.js` (new): read-only.
  - `getOverview()` returns plans sorted by price, each with `companies { active, retired }` and `activeEmployees`.
  - It also returns totals (plans, subscribed companies, retired companies, active companies without a plan, `estimatedMonthly`) and `featureKeys`, the union of every plan's feature keys.
  - `getPlanDetail(id, { includeRetired })` returns the same plan fields plus `companyList`.
  - It runs three grouped queries, with no N+1. Price comes back as a number.
- `src/controllers/Analytics/subscriptionPlanOverviewController.js` (new): `{ success, data }`, and a 404 for an unknown plan.
- `src/routes/Analytics/systemAdminRoutes.js`: two routes, with `/overview` registered before `/:id`.
- `docs/CLAUDE.md`: route reference row.

## Endpoints (`verifySystemAdmin`, any system admin)
- `GET /api/system-admin/subscription-plans/overview`
- `GET /api/system-admin/subscription-plans/:id[?includeRetired=true]`
- Unchanged: `GET /api/system-admin/subscription-plans` (the "Add company" dropdown).

## Order of steps
Merge the PR → deploy → send `docs/client-update-BB-132.md` to the client. There's no SQL and no `prisma generate`.

## Open questions
None. Editing plans from System Admin would be a new ticket (owner only, with delete blocked while companies are on the plan).

---

# Release workflow (no ticket)

## What
- A version is now a push, not a ticket. Every push gets one version, one branch, one changelog, and a `package.json` version bump.
- Every fix and module starts from the latest `master`.

## Changes
- `.claude/commands/push.md` (new): `/push` prepares the release with one approval checkpoint. It never merges, deploys, or runs tests, Prisma or SQL.
- `.claude/commands/fix.md`, `.claude/commands/module.md`: new step 0, sync with master.
- `CLAUDE.md`:
  - new sections "Sync with master before starting" and "Versioning & releases"
  - "Current state" trimmed to the latest push plus open tickets (history lives in the changelogs)
- `package.json`, `package-lock.json`: `"version"` goes from `1.0.0` to `2.11.15`, the first time the field has been bumped.
