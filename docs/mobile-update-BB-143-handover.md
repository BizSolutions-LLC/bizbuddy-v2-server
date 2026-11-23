# Mobile hand-over: everything since your leave (BB-143)

**From:** bizbuddy-v2-server
**For:** the BizBuddy mobile app (iOS + Android)
**Covers:** server v2.11.7 → v2.11.17 (pushed 2026-11-12 to 2026-11-20), the pushes made just before, during and after your leave (2026-11-11 to 11-17).
**Written:** 2026-11-23

This file is the one list to work from. For full payloads, each item links to its own hand-off.

| Label | Meaning |
|---|---|
| **MUST CHANGE** | The app needs work for the feature to work |
| **SHOULD CHECK** | Already live. It may look wrong or show an error if the app doesn't handle it |
| **NO CHANGE** | For your information only |

> **Don't change the session, token or biometric handling** as part of any of this. That area is still under investigation. Leave it exactly as it is.

---

## Summary

| # | Ticket | What | Label | Version |
|---|---|---|---|---|
| 1 | BB-141 | Face photo on clock-out / clock-in, stored on S3 | **MUST CHANGE** | v2.11.17 |
| 2 | BB-134 | Send `deviceId` on time-in / time-out | **MUST CHANGE** (small) | v2.11.17 |
| 3 | BB-129 | Custom forms (questionnaires), answered **before** clock-out | **MUST CHANGE** | v2.11.16, v2.11.17 |
| 4 | BB-128 | GPS breadcrumbs: your upload kept, server adds flags | **SHOULD CHECK** | v2.11.17 |
| 5 | BB-125 | Leave status `reverted` | **SHOULD CHECK** | v2.11.10 |
| 6 | BB-123 | Contest submit / approve guards | **SHOULD CHECK** | v2.11.8 |
| 7 | BB-117 | One push format, `targetRoute`, reminders | **SHOULD CHECK** | v2.11.7 |
| 8 | BB-133 | `/api/analytics/employee` corrected numbers | **SHOULD CHECK** (if used) | v2.11.16 |
| 9 | BB-119 | Every time in the company zone | **SHOULD CHECK** | v2.11.7 |
| 10 | others | BB-122, BB-126, BB-137, BB-140, web/admin-only tickets | **NO CHANGE** | various |

Suggested order: 1 + 2 + 3 together (they all touch clock-in / clock-out), then the checks.

The web side of this hand-over (what the web app now does, so the app can match it) is at the end: **"Web side"**. This server part is the source for request and response details.

---

## Your own PRs, and what became of them

| PR | Date | What you built | Now |
|---|---|---|---|
| #118 | 2026-11-10 | Payslip remarks (`update/check-printing`) | Kept as is |
| #129 / #130 | 2026-11-19 | Face photo stored on the questionnaire answer (`TaskReportFormResponse.facePhoto*`), required with forms | **Replaced by BB-141.** The photo now belongs to the **punch** and goes to S3. The questionnaire ignores `facePhoto`. The old columns are unused and will be dropped later. Your multipart time-out request stays (see 1) |
| #131 | 2026-11-20 | `POST /api/timelogs/location-breadcrumbs` + `collectUntil` | **Kept as is.** Our own draft upload endpoint was removed, so yours is the only one. The server added map flags (see 4) |

---

## 1. BB-141 Face capture on punches (S3) — MUST CHANGE
Full hand-off: `docs/mobile-update-BB-141.md`.

**When a photo is required** (read `GET /api/company-settings`, refresh at sign-in, app start and before each punch):
```
taskReportEnabled === true && taskReportMode === "forms" && taskReportFaceCapture === true
```
- **Clock-out:** required whenever the rule above is true, **even when no form is assigned** to the punch.
- **Clock-in:** required when the rule is true **and** `taskReportFaceCaptureClockIn === true`.
- Free-form mode never needs a photo.

**How to send it:** on the same punch calls as today, as `multipart/form-data`:
- `POST /api/timelogs/time-in`
- `POST /api/timelogs/time-out` (plus `answers` as a JSON string when the punch has a questionnaire)

| Field | Value |
|---|---|
| `facePhoto` | the image file, JPEG or PNG, ≤ 5 MB |
| `localTimestamp`, `punchType`, `reason` | as today |
| `location`, `deviceInfo`, `remarks` | JSON strings |
| `deviceId` | see 2 |

When no photo is required, keep sending plain JSON as today. Responses add `data.facePhotoId` (or `null`).

**Errors**

| Status | `code` | App behaviour |
|---|---|---|
| 400 | `FACE_PHOTO_REQUIRED` | missing / wrong type / too big / unreadable → open the camera again |
| 400 | `TASK_REPORT_FORMS_REQUIRED` | the punch has a form and `answers` is missing → show the form |
| 502 | `FACE_PHOTO_UPLOAD_FAILED` | keep the photo, let the user retry. The punch was **not** saved |
| 503 | `FACE_PHOTO_UNAVAILABLE` | retry later. The punch was **not** saved |
| 403 | `WEB_PUNCH_DISABLED` | browsers only. The app should never see it |

**Rules:**
- Use the camera only (front camera by default), never the gallery.
- Take the photo right before sending.
- Offline punches keep their photo and send it with the same request later.
- The questionnaire save (`PUT /api/task-report-forms/me/punch/:timeLogId`) no longer takes a photo.

### Do you need a new endpoint to upload to S3? No.
The app never talks to S3. It sends the photo inside the punch request it already makes. The server then:
1. resizes it (≤ 480 px JPEG, metadata removed);
2. uploads it to the private S3 bucket;
3. saves the punch and its photo row together.

Why one request instead of a separate upload endpoint:
- **The punch and its photo succeed or fail together.** There's never a punch without its required photo, and never a stray photo without a punch. After a 502/503 the employee is simply still clocked in (or out) and retries.
- **No AWS keys or signed upload links on the phone.**
- **One call per punch.** It's the same multipart request you already build for the questionnaire.

A separate step (ask for a signed S3 link → upload → attach to the punch) would add two more calls, a linking step and cleanup of photos whose punch never arrived. It's only worth it for large files or slow uploads. Photos here are ≤ 5 MB and kept small, so that doesn't apply.

**Who sees the photo:** admins and supervisors, on the web cutoff approvals page, until the punch is approved. Employees don't see it in the app.

> Companies won't have face capture switched on until your release sends photos. Tell us when the build is ready to test in dev.

---

## 2. BB-134 Send `deviceId` on punches — MUST CHANGE (small)
Full hand-off: `docs/mobile-update-BB-134.md`.

- Add `deviceId` at the **top level** of the time-in and time-out body (or as a multipart field when sending a photo).
- It must be **exactly** the value sent to `POST /api/account/login`.
- Send it always, including offline punches sent later. Leave it out if the app has none (never `"unknown"`).
- Don't put a `proof` key in `deviceInfo`. The server writes its own.
- A punch is never refused because of it. Responses don't change.

Why: phones don't expose a real MAC address (iOS returns a fixed value, Android 10+ a random one). The server compares this ID with the phone registered at sign-in instead.

---

## 3. BB-129 Custom forms (answered before clock-out) — MUST CHANGE
Full hand-off: `docs/client-update-BB-129-forms-phase2.md` (sections 4–7 and 10). **Section 3 there (pop-up after clock-out) is out of date.** Use the flow below.

Companies pick **one** mode: free-form daily report **or** custom forms. In forms mode, free-form writes are refused (`403 TASK_REPORT_MODE_FORMS`).

**Changed since phase 2 was written:** when a form is assigned to the open punch, the form is answered **before** clock-out. Since v2.11.17, `POST /api/timelogs/time-out` returns `400 TASK_REPORT_FORMS_REQUIRED` ("Finish the end-of-shift form before clocking out.") when that punch has a form and no `answers` are sent. The answers are checked as a submit (required questions must be answered) and saved with the clock-out.

**Clock-out flow (the web already works this way):**
1. Before clocking out, ask for the open punch's form: `GET /api/task-report-forms/me/open` →
   - `data = { required: false, timeLogId }`: no form, clock out as today.
   - `data = { required: true, timeLogId, assignedVia, shift: { id, name } | null, form: { id, name, description, questions[] } }`: show the form first.
2. **"Submit and time out"** sends `POST /api/timelogs/time-out` with `answers` (`{ [questionId]: value }`, value types in phase 2 section 5). **"Stay clocked in"** cancels.
3. When face capture applies (1), the same request is multipart: `facePhoto` + `answers` as a JSON string.
4. Invalid or missing required answers → `400 INVALID_ANSWER` / `REQUIRED_ANSWER` with a `message` naming the question. The punch stays open.

**Other screens:**

| Screen | Endpoint | Section |
|---|---|---|
| "Answer questionnaire" icon + badge (auto clock-outs, punches added later) | `GET /api/task-report-forms/me/pending` | 4 |
| Answer one of those (draft / submit) | `GET` / `PUT /api/task-report-forms/me/punch/:timeLogId` | 5 |
| Own history | `GET /api/task-report-forms/me/responses?from&to` | 6 |
| View one | `GET /api/task-report-forms/responses/:id` | 7 |
| PDF (optional) | `GET /api/task-report-forms/responses/:id/pdf` (submitted only) | 10 |

Notes:
- `time-out` still returns `taskReportForm`, but in forms mode the answers already came with the clock-out, so it's normally `null`. Don't rely on it as the main way in.
- Pending questionnaires stay open for `taskReportFormWindowHours` after clock-out (default 14 days). After that a draft shows as **Incomplete** and can't be edited.
- Show times in the response's `timeZone` (company zone).
- Not needed on mobile: settings, assignments, the Employee Report page.

---

## 4. BB-128 GPS breadcrumbs — SHOULD CHECK
Your endpoint `POST /api/timelogs/location-breadcrumbs` (`{ samples }`, 1–50, each with `timeLogId`) and `collectUntil` on time-in / `GET /timelogs/user` are **unchanged**.

What the server added:
- **Company settings** on `GET /api/company-settings`: `breadcrumbsEnabled` (default `false`) and `breadcrumbIntervalMinutes` (1–60, default 5). Please collect only while `breadcrumbsEnabled` is true, at that interval.
- **Retention:** points older than 90 days are deleted nightly.
- **Impossible-travel flags** on the web map, after the spoofing test (Cali → Australia while the app sent `isMocked: false`):
  - a jump faster than 120 mph over more than 1 km between points;
  - a clock-in / clock-out pin far from the route.
  Flagged points are still stored; nothing is rejected.

Our old draft `docs/mobile-update-BB-128-breadcrumbs.md` is **superseded**. Ignore it.

---

## 5. BB-125 Leave status `reverted` — SHOULD CHECK
Details: `docs/client-update-BB-125.md` (server contract, sections 1–3).

When a punch is honored over an approved leave, that leave day goes back to the balance:
- `Leave.status` can now be **`"reverted"`** (every day was worked).
- A leave can stay `"approved"` with some days reverted. Show it as **"Partly reverted"** (`status === "approved" && reversion != null`).
- Every leave in the lists has `reversion`: `null`, or `{ revertedAt, dates, returnedHours, automatic, performedBy, note }`.
- `GET /api/leaves/:id/days` adds `reverted` and `revertedAt` per day.
- A reverted leave has no paid/unpaid outcome. `actualPaidHours` / `actualUnpaidHours` drop to 0 when fully reverted.

**Check:** the app must not crash or hide the row on an unknown status.

---

## 6. BB-123 Contest guards — SHOULD CHECK
Contest submit and approve can now return **400 `{ message, code? }`** for requests that were already wrong:
- an invalid date;
- a clock-out not after the clock-in (for example an overnight shift built on one date);
- 24 hours or longer;
- `CUTOFF_LOCKED`: the punch is in a locked or processed cutoff;
- `CONTEST_PENDING` (submit only): the punch already has a pending contest.

A correct contest works exactly as before.

**Check:**
- An overnight clock-out must be on the **next day**.
- Requested times must be built in the **company** zone.
- Show the server's `message`.
- Don't auto-retry a submit that got `CONTEST_PENDING`.

---

## 7. BB-117 Notifications — SHOULD CHECK
- **One push format** for every type: `data { notificationId, type, companyId, targetRoute, payload }`, Android channel `default`.
- `targetRoute` follows the route table you sent (`src/services/notificationTargets.js`). Types not in your table go to `/(tabs)/notifications`.
- `GET /api/notifications` rows include `targetRoute`. Deleting hides the row.
- "Shift starting soon" (30 min) is now an inbox entry (`CLOCK_IN_REMINDER`); the `clockInReminder` socket event is kept. The 10-minute "Shift ending soon" push is retired.
- Duplicates are gone: missed clock-in/out is no longer repeated every 2 hours.
- Device tokens: with a login header, `POST /api/account/device-token` uses the signed-in user (a body `userId` is ignored). A token registered again is removed from any other account.

---

## 8. BB-133 `/api/analytics/employee` — SHOULD CHECK (only if the app calls it)
Same URL, old fields kept, values corrected:
- company zone;
- range stops at today;
- net hours, grace, overnight;
- leave and holidays don't count as absent;
- OT = approved OT.

If the app shows these numbers, they may differ from before. That's expected. Details: `docs/client-update-BB-133.md` section 1.

---

## 9. BB-119 Company time zone — SHOULD CHECK
The server builds reports and dates in the **company** zone, and the web now shows every time in the company zone (the viewer's own zone was removed everywhere).

**Check:** the app shows punches, schedules, leave and contests in the company zone, not the phone's zone. Where a response has `timeZone`, use it.

---

## 10. No app change (for your information)
- **BB-122:** auto clock-out now uses the shift's own time zone.
- **BB-126:** `GET /api/timelogs` adds `row.display` and `meta`. Additive only, nothing removed or renamed.
- **BB-137:** the server records sign-ins on its side. Keep sending `deviceId` on login as today. Nothing is shown to employees, and no app screen is needed.
- **BB-140:** every email is now logged on the server. No app impact.
- **Web or System Admin only:** BB-119 (reports), BB-120, BB-121, BB-124, BB-132, BB-135, BB-139.
- **Web punches:** while face capture applies (1), browsers can't clock in or out. Employees are told to use the app.

---

## Open questions for you
Short answers or "don't know" are fine. They decide follow-up work.

**A. BB-114 endpoint usage** (full text: `docs/BB-114-mobile-questionnaire.md`)
1. When and how often does the app call `GET /api/account/profile`, and which fields does it read?
2. What is the polling interval for `/notifications` and `/unread-count`? Does it poll in the background?
3. How often is `PUT /api/presence` sent, and is it sent in the background?
4. Does the app use `/company-setup/checklist`?
5. Does the app load `/leaves`, `/timelogs` or `/cutoff-periods/:id/approvals`? With what page size, and on a timer?

**B. BB-123 contests**
1. Are requested times built in the device's zone or the company's?
2. Does a clock-out after midnight move to the next day?
3. Does the app show the server's 400 `message`? Does it retry a failed submit?
4. Is there an approver screen? If so, are its times in the company zone?
5. Does the app ever file a contest for **someone else's** punch? This decides an ownership check we're holding.
6. Does it show contest status per punch, and block a second contest while one is pending?

**C. BB-125 leave**
1. How does the app show a status it doesn't know (crash, hide, raw text)?
2. Does it compute Paid/Unpaid from `isPaid` or from `actualPaidHours`?
3. Does it show the day-by-day outcome (`/api/leaves/:id/days`)?

**D. BB-117 notifications**
1. Does the app register the FCM token again after a biometric sign-in or on app start? This decides clearing the token on sign-out.
2. Do older app versions send the login header on `device-token`?

**E. BB-128 breadcrumbs**
1. Does the app read Android `Location.isMock()` / iOS `CLLocation.sourceInformation.isSimulatedBySoftware` for `isMocked`?

**F. BB-134 / BB-141 devices and offline**
1. What is the `deviceId` source on iOS and Android? Does it survive a reinstall or update?
2. Are offline punches sent later? If so, can they carry the same `deviceId` and the photo?

**G. Your releases**
1. Did you ship any mobile app releases during 2026-11-11 → 11-17? Please list them so we can check them against this file.

---

## Coming next
**BB-114 batch 1** (around 2026-11-28) is a server-speed update:
- shared database connection;
- checklist cache;
- fewer queries on `/timelogs` and `/leaves`.

Responses stay exactly the same, so no app update is needed. We'll let you know when it's live.

---
---

# Web side

*Written by the web side; checked against the server on 2026-11-23. Request and response details: the server part above. This part covers a wider range (from the last mobile hand-off, server v2.11.0, 2026-10-28).*

**Web versions:** v2.15.1 → v2.16.0. **Server needed:** v2.11.17 or later.

## W1. At a glance

| Ticket | Web version | What changed on web | Mobile |
|---|---|---|---|
| BB-141 Face capture | v2.16.0 | Face photo on punches. Web is view only for punching, and the form is answered **before** clock-out | **Required** |
| BB-129 Custom clock-out forms | v2.15.6, v2.15.9, v2.16.0 | Questionnaires per shift/employee/department | **Required** |
| BB-134 Record punch device | v2.16.0 | Punch details show the phone that punched | **Required** (small) |
| BB-128 Employee Map (part 2) | v2.16.0 | Routes and suspicious movement from GPS points | **Required** (your upload) + 1 question |
| BB-119 Company time zone only | v2.15.4 | All times in the company zone; viewer zone removed | **Check parity** |
| BB-123 Contest time requests | v2.15.5 | Contest times in company zone, overnight fix, server errors shown | **Check parity** + 4 questions |
| BB-125 Leave "Reverted" | v2.15.7 | New leave status `reverted` | **Check parity** + 4 questions |
| BB-120 B. Buddy no payroll | v2.15.6 | B. Buddy can't open payroll | Check, only if B. Buddy is on mobile |
| BB-126 Punch Logs from server | v2.16.0 | Hours/OT/breaks come from the server | Optional |
| BB-133 Overview redo | v2.15.9 | Corrected numbers, new fields | Only if the app calls `/api/analytics/employee` |
| BB-116 Leave Ledger | v2.15.2 | Ledger shows leave dates and approver | Optional |
| BB-112, 113, 114, 118, 132, 139, 140 | v2.15.1–v2.16.0 | System Admin dashboard | None |
| BB-106, 115, 121, 130, 135, 097 | v2.15.3–v2.16.0 | Company web pages / docs | None |
| BB-137 | v2.16.0 | Admin tools (web) | None |

## W2. Required for mobile

Suggested order: **BB-141 + BB-129 + BB-134 together** (they all touch clock-in/out), then BB-128.

### BB-141 — Face capture
What the web does now:
- When face capture applies, the web **can't punch**. The Punch page hides Time In/Out and breaks and says "Clock in and out from the BizBuddy mobile app". The server answers browser punches with `403 WEB_PUNCH_DISABLED`. **So when it's on, the app is the only way to punch.**
- Admins and supervisors see the photos on the web cutoff approvals page (In / Out camera icons). Employees never see them.

What the app needs: server part, section 1.

### BB-129 — Custom clock-out forms
What the web does now (match this):
1. Before clock-out, check the open punch: `GET /api/task-report-forms/me/open`.
2. If there's a form, show it first. **"Submit and time out"** sends the answers with the clock-out (`/time-out` with `answers`). **"Stay clocked in"** cancels.
3. With face capture on, the same `/time-out` request carries the photo too (multipart, `answers` as a JSON string).
4. The "Answer questionnaire" list is still there for auto clock-outs and punches added later.

What the app needs: server part, section 3.

### BB-134 — Record punch device
On web, admins see "✓ Registered phone" or "⚠ Other phone" in the punch details when the company turns on "Record punch device". Without `deviceId`, every phone punch shows "Device not identified". What the app needs: server part, section 2.

### BB-128 part 2 — GPS points while clocked in
- The web turns it on under Trial Features → "Track location during shifts" (`breadcrumbsEnabled`, `breadcrumbIntervalMinutes` 1–60).
- The web Employee Map shows routes per employee, gaps, **fake-GPS points in red** and impossible jumps (e.g. "4,862 mi in 1 min").
- The red fake-GPS dots depend on the app sending `isMocked` from Android `Location.isMock()` / iOS `isSimulatedBySoftware` (question E1).

## W3. Check parity (the web changed how something shows)

- **BB-119:** the web shows **every** time in the company's zone (from Company Configurations). "Detected", "Your timezone" and dual times were removed everywhere. See server part section 9.
- **BB-123:** the web builds contest times in the **company zone**, moves an after-midnight clock-out to the **next day**, and shows the server's 400 `message`. See server part section 6.
- **BB-125:** the web shows **Reverted**, and **Partly reverted** when `status === "approved"` and `reversion` is set. See server part section 5.
- **BB-120:** only if B. Buddy (support login) is used on mobile. Payroll endpoints return `403 SYSTEM_AGENT_NOT_ALLOWED` for a B. Buddy session. Hide payroll for B. Buddy, or show the server's message.
- **BB-126 (optional):** the web punch logs read each `GET /api/timelogs` row's `display` object and `meta.summary`. They come from the same calculation as the reports, so the numbers match the PDF/Excel. If the app works out hours/OT itself, switching to `display` keeps the app's numbers the same as the web's.
- **BB-133 (only if used):** see server part section 8.
- **BB-116 (optional):** ledger rows now include the leave's dates and who approved it.

## W4. Your work in this period (web + server git)

| When | What | Where it stands now |
|---|---|---|
| 2026-11-10 | Payslip remarks; qty × rate earnings type (server PR #118, web `f60f73a`) | Merged |
| ~2026-11-12 | Fixed the app's `/contest-policy/my-requests` path (404 gone) | Thanks, done |
| 2026-11-19 | Face captures on task reports, schema (server PRs #129/#130) | **Replaced by BB-141** (server part, section 1) |
| 2026-11-20 | Location crumbs endpoint (server PR #131) | **Kept** as the BB-128 upload (server part, section 4) |

No commits from you are in the web or server repos during 2026-11-11 → 11-17 (question G1).

## W5. No mobile change (web side)

Listed so you know each one was checked.
- **BB-112 / BB-113:** System Admin Performance page (capacity bands, reports).
- **BB-114:** System Admin cached analytics. Endpoint questions: server part, question A.
- **BB-118:** System Admin sign-in redo and "Running since".
- **BB-132:** System Admin Subscription Plans.
- **BB-139:** System Admin onboarding workbook.
- **BB-140:** System Admin Emails page.
- **BB-106:** Leave Report workbook (web export).
- **BB-115:** "Set up your business" guide for admins. The server works out the steps from the data, so steps done on mobile tick off too.
- **BB-121:** Cutoff page type (List / Calendar), web only.
- **BB-130:** auto clock-out pill on web Cutoff Review.
- **BB-135:** Schedules Roster view and Employee Schedule merge, web only.
- **BB-097:** in-app documentation text.
- **BB-137:** web admin tools only. The app's sign-in is unchanged. Keep sending `deviceId` at sign-in as today, since it's the one-phone lock.

All open questions (web and server) are in one list in the server part: **"Open questions for you"**, A–G.
