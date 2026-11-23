# Changelog — v2.11.18

**Branch:** `release/v2.11.18` (pushed 2026-11-23), from `origin/master` (after PR #132).

**Tickets:**
- BB-143 Mobile hand-over after the mobile developer's leave (2026-11-11 → 11-17): **written, awaiting the user's review before sending**.

**Schema change:** none. **Code change:** none (docs only). **Deploy:** not needed for this version.
**Client impact:** none. The web part of the hand-over was written by the client-side session and is included in the same file.
**Mobile impact:** `docs/mobile-update-BB-143-handover.md` is the hand-off (not sent yet).

---

# BB-143 — Mobile hand-over (one file for everything since the leave)

- **What:** one hand-over for the mobile developer covering server v2.11.7 → v2.11.17 (2026-11-12 to 11-20), plus the web side (from server v2.11.0), so the app can match the web.
  - **Must change:** BB-141 face photo on punches, BB-134 `deviceId` on time-in/out, BB-129 custom forms.
  - **Should check:** BB-128 breadcrumbs (their upload kept, flags added), BB-125 `reverted` leave status, BB-123 contest guards, BB-117 push format, BB-133 analytics, BB-119 company zone.
  - **No change:** BB-122, BB-126, BB-137, BB-140, web/admin-only tickets.
  - **Their PRs:** #118 kept, #129/#130 photo moved to the punch (BB-141), #131 kept. Git shows no server or web commits from them during 2026-11-11 → 11-17.
  - **Open questions:** all in one list (A–G).
- **Correction recorded in the hand-over:** BB-129 forms are answered **before** clock-out (`GET /api/task-report-forms/me/open`, then `/time-out` with `answers`; without them `400 TASK_REPORT_FORMS_REQUIRED`). Section 3 of `docs/client-update-BB-129-forms-phase2.md` (pop-up after clock-out) is out of date.
- **Face upload question answered:** no new endpoint. The photo goes in the existing multipart `time-in` / `time-out` and the server uploads it to S3, so the punch and its photo are saved together and the app never holds AWS keys.
- **Changes:**
  - `docs/mobile-update-BB-143-handover.md` (new): server part (sections 1–10, questions A–G) + "Web side" (W1–W5).
  - `CLAUDE.md`: BB-143 status, latest push.
- **Endpoints:** none added or changed.
- **Order of steps:** user reviews the hand-over → sends it to the mobile developer. Per-ticket hand-offs (`mobile-update-BB-134.md`, `mobile-update-BB-141.md`, `client-update-BB-129-forms-phase2.md`, `client-update-BB-125.md`) stay and are linked.
- **Open:** the mobile developer's answers (questions A–G) decide follow-ups: BB-123 ownership check, BB-117 sign-out token clear, BB-114 batch 1 details.
