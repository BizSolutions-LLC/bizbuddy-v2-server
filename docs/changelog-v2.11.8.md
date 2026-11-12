# Changelog — v2.11.8

**Branch:** `release/v2.11.8` (2026-11-12). **Schema change:** none. **Tickets:** BB-122 (complete), BB-123 (server side built, awaiting the user's test), BB-114 (planning docs only, ticket stays open).

**Deploy note:** release the server together with the web contest-dialog fix (`docs/client-update-BB-123.md`). If the server goes first, web users with overnight shifts get a 400 from the old dialog until the web fix ships. **Mobile:** no app change is needed. Only contests that were already wrong are refused (see BB-123 → Mobile impact). The mobile developer is on leave; their questions are collected at the end of this file.

---

# BB-122 — Early auto clock-out after a company time zone change

**Status:** BB-122 — complete (signed off 2026-11-12). No client change.

> BizSolutions LLC started on Manila time and later changed its company zone to Los Angeles. Shifts created
> before the switch still mean Manila hours (8:00–5:00 Manila). The auto clock-out read those clock times in the
> company's *current* zone, so an 8:00 AM Manila clock-in (4:00 PM LA) was treated as one hour before
> 5:00 PM LA. Sessions were warned and closed within about an hour, with the clock-out recorded as 5:00 PM LA.

## Cause
- When a shift is created, `Shift.timeZone` is set to the company zone at that moment (`shiftController.js`). The client has no field to change it later.
- The cutoff strategies and `clockInReminderWorker` already read a shift's times in `shift.timeZone || company.timeZone`.
- `liveUserService.createLiveUser`, which sets `LiveUser.scheduledEnd`/`warnAt`/`closeAt` for the auto clock-out job, used `company.timeZone` only.

## Fix
- `createLiveUser` now resolves the shift end in the shift's own zone. It falls back to the company zone when the shift has no zone or an invalid one.
- The day window used to find the shift is unchanged (company zone).

## Who is affected
- Only shifts whose `timeZone` differs from their company's: BizSolutions LLC shifts created before the Manila → LA switch.
- Companies whose shift and company zones match get exactly the same result as before.
- It takes effect from the next clock-in after deploy. A session already open keeps its old close time.

## Not changed (agreed)
- **Reports** stay in the company zone (LA). A Manila 8:00–5:00 day therefore shows as about 4:00 PM–1:00 AM LA, listed under the previous LA date. This is intended.
- **OT / segment calculation** (`timeLogComputeService.js`) still reads shift times in the company zone. Affected logs can show false OT of about 8h with a "Request" button. These are left unrequested; the fix is a possible follow-up.
- **Wrong logs already saved** (Nov 10–11) are corrected through time-log appeals: approving one writes the requested times and recalculates the log. No data script.
- `src/jobs/autoClockOutSafeguard.js` is not scheduled anywhere (dead code). It was left as is.

## Files
- `src/services/liveUserService.js`: `createLiveUser` uses `latestShift.timeZone` (checked with `moment.tz.zone`) and falls back to the company zone.

---

# BB-123 — Employee Page: contest request times

**Status:** server side built 2026-11-12, awaiting the user's test. The client fix is in the client repo (client-side session), not in this repo.

> BB-123 is the Employee Page update (the `/dashboard/employee/punch-logs` table, done on the client). Testing it
> showed the **contest dialog** saves wrong requested times:
> - it builds them in the browser's zone instead of the company's;
> - it puts an overnight clock-out on the same day.
>
> For an LA company viewed from Manila, a 4:00 PM → 1:00 AM correction became a backwards request 16 hours early.
> The server accepted it, and approving writes the requested times straight to the time log.

## Server change
- `POST /api/contest-policy/submit` now returns **400** with a message when:
  - the requested clock-in or clock-out is not a valid date;
  - the clock-out is not after the clock-in;
  - the requested shift is 24 hours or longer.
- `PATCH /api/contest-policy/approve/:id` runs the same check before writing to the time log. On failure it returns 400 and asks the approver to reject. This covers requests submitted before the submit check existed.
- **Locked cutoffs (decided 2026-11-12):** submit and approve also return **400 `{ code: "CUTOFF_LOCKED" }`** when the punch is in a `locked` or `processed` cutoff. That covers:
  - the cutoff the log is reviewed in (TimeLogApproval);
  - the cutoff covering the recorded or requested clock-in date (company-zone calendar day; department or company-wide).

  Approving used to change the time log while the reviewed cutoff rows kept the old times.
- **One pending contest per punch:** submit returns **400 `{ code: "CONTEST_PENDING", message, contestId }`** when the same `timeLogId` already has a `PENDING` contest. Rejected or approved contests don't block a new one. The data already had a duplicate: Miguel Carl Alviar, 2 pending on one log, 7 minutes apart.
- Limit: the server sees only two instants, so a plausible wrong-zone request (for example 8:00–17:00 typed instead of 16:00–01:00) still passes. The client dialog's company-zone hint and the approver's recorded-vs-requested view cover that.

## Client (BB-123, client repo; hand-off `docs/client-update-BB-123.md`)
**Contest dialog (Employee Page):**
- build times in the company zone;
- move the clock-out to the next day when it is earlier than the clock-in;
- show the overnight hours preview correctly, rounded to the minute;
- show the dropdown date in the company zone;
- show a zone hint line from `companyTimezone` (never hard-coded);
- warn, without blocking, when the requested **clock-in** moves 12h+ or to another date, never for an overnight clock-out;
- disable punches in locked cutoffs (`log.cutoffApproval?.cutoffPeriod?.status`);
- block shifts of 24h or longer;
- show the server's 400 message.

The user tested the dialog on 2026-11-12: the Nov 10 request now shows 16:00 → 01:00 (next day), Los Angeles (PST), "No change from recorded".

**Contest Requests (approver page):**
- times in the company zone (they were in the approver's browser zone);
- a "change from recorded" highlight, including the "moved, same length" zone-mistake signature;
- a "Cutoff locked" badge with Approve disabled;
- the server's error message instead of the generic one.

**Punch-logs rows:** a contest status badge (pending / approved / rejected) from `GET /api/contest-policy/view-contestTimeLogs`, matched by `timeLogId`. Contest is disabled while one is pending, and the list reloads after submit. No server change for this part.

**Client impact:** submit and approve can return **400 `{ message }`**, plus `code: "CUTOFF_LOCKED"` or `code: "CONTEST_PENDING"` (submit only).

## Mobile impact (mobile developer on leave as of 2026-11-12)
**What changes for mobile:** only the contest endpoints, and only for requests that were already wrong. A correct contest (forward, under 24h, open cutoff) behaves exactly as before, with the same success response. The new 400s are:
- an invalid date;
- a clock-out not after the clock-in (for example an overnight shift built on one date);
- a shift of 24h or longer;
- a punch in a locked or processed cutoff (`CUTOFF_LOCKED`).
- a second contest on a punch that already has a pending one (`CONTEST_PENDING`). Worst case: an app that retries a submit gets "already pending", and the first contest is still there.

Before, these were saved, and approving them could corrupt a time log or a locked cutoff.

**Worst case on mobile:** if the app builds overnight times on one date, or files contests on locked cutoffs, the user now gets an error instead of a bad request. Workaround until the app is checked: file those contests on the web.

**Not built, waiting on mobile:** an ownership check in submit (the punch must belong to the person submitting). Today any signed-in user who knows a `timeLogId` can contest a coworker's punch. It is held until the mobile developer answers question B5 (see the end of this file).

The questions are listed under "Questions for the mobile developer" at the end of this file.

## Data check
- **New** `scripts/check-bb123-contest-requested-times.js` (read-only, the user runs it):
  - Lists contests flagged BACKWARDS, TOO_LONG, FAR (requested clock-in 12h+ from recorded) or MISSING.
  - For approved ones, shows whether the time log holds the requested times and flags LOG_BACKWARDS.
  - Any fixes follow as narrow scripts, one confirmed record first.

## Check results (user ran it 2026-11-12: 38 contests, 8 flagged)
- **No corrupted time log** (LOG_BACKWARDS 0).
- **Pending flagged requests:** all on the test company (Sunshine Learning: the +16h zone-bug signature) or on now-inactive companies (WWW, YYY). No real pending request needs action.
- **Robert Ramirez (PadPro), checked with `scripts/check-bb123-robert-ramirez-oct29.js`:**
  - His Thu Oct 29 log was contested on Fri Oct 30 into Fri 6:30–2:30, a misuse of contest for a missing day.
  - Approved Nov 10 (after his cutoff was already approved on Nov 3). An admin re-created Thursday on Nov 11 (new log, approved 12:09 PM), and the moved log's clock-out was set to 2:45 PM at 2:19 PM.
  - Now: one log each for Tue–Fri, 8h net each, so the total hours are right.
  - **Left over:** the moved log's 3 cutoff rows (driver_am/regular/driver_pm) still carry **Thursday** times, in the **locked** Oct 28–Nov 10 cutoff (pay Nov 13). Date-based views show Thu twice and no Fri.
  - **The user confirmed his data is fine: no fix.** The finding (approving a contest doesn't touch the cutoff rows) is now prevented by the locked-cutoff block.
- **No action:** Uncles Sammies (WWW, Oct 2025): one rejected, one approved but its log was never changed. Carlo (BizSolutions, Nov 5): rejected.

## Files
- `src/controllers/Features/contestPolicyController.js`: `validateRequestedTimes()` and `findLockedCutoffForContest()` in `submitContestPolicy` and `approveContestRequest`, and the pending-contest check (`CONTEST_PENDING`) in `submitContestPolicy`
- **New** `scripts/check-bb123-contest-requested-times.js`
- **New** `scripts/check-bb123-robert-ramirez-oct29.js` (read-only)
- **New** `docs/client-update-BB-123.md`: client hand-off covering the dialog fixes, the approver page, the punch-logs contest badges, the server's error codes and the mobile questions.

---

# BB-114 — Improvement of API Endpoints: plan and mobile questionnaire

**Status:** OPEN, not closed. **No code change in this release:** planning documents only.

> The Performance page (7-day capacity, 30-day endpoints) showed the API server is fine and the database
> is the pressure point (2 requests timed out waiting for a connection). Five endpoints were scanned in code
> and improvement ideas recorded. Batch 1 is planned for release right after BB-113 Period 1 ends, so Period 2
> can show its effect against a clean "before" period.

## Findings recorded
- `GET /api/account/profile`: heavy joins + a second subscription query.
- `GET /api/company-setup/checklist`: 15 queries per call.
- `GET /api/cutoff-periods/:id/approvals`: writes on read.
- `GET /api/timelogs`: a redundant count query.
- `GET /api/leaves`: an N+1 hours calculation.
- 12 separate Prisma clients, each with its own connection pool.
- The mobile `/contest-policy/my-requests` 404 is already fixed by the mobile side.

## Batch 1 (planned, not built)
1. Shared Prisma client.
2. Checklist cache.
3. Drop the timelogs count.
4. Batch the leaves hours, with a side-by-side check first.

Server only, with the same responses: no web or mobile release needed. Schedule: build ~2026-11-23 to 11-25, test ~11-26 to 11-27, deploy ~11-28 to 11-29 after the Period 1 report is saved.

## Files
- **New** `docs/BB-114-endpoint-plan.md`: plan of record (findings, batch 1 details and safety notes, schedule, later decisions)
- **New** `docs/BB-114-mobile-questionnaire.md`: questions for the mobile developer (profile usage, polling, checklist, list page sizes)

---

# Questions for the mobile developer (on leave since 2026-11-12)

Send these on their return. Nothing in v2.11.8 needs an app update. These decide follow-up work.

## A. BB-114: endpoint usage (full text: `docs/BB-114-mobile-questionnaire.md`)
1. **`GET /api/account/profile`:**
   - When is it called (start, every screen, resume, timer)?
   - Which fields are used?
   - Could it be fetched once per session?
   - Is it cached locally?
2. **`/notifications` and `/notifications/unread-count`:**
   - What is the polling interval, and on which screens?
   - Does it poll in the background?
   - Could socket events or push replace the polling?
3. **`PUT /api/presence`:** when and how often is it sent? Is it sent in the background?
4. **`/company-setup/checklist`:** does mobile use it?
5. **Lists** (`/leaves`, `/timelogs`, `/cutoff-periods/:id/approvals`): are they used, with what page size, and are they reloaded on a timer?
6. Any other timer-based calls, and anything slow to look at.

## B. BB-123: contests
1. Does the contest screen build the requested times in the **device's** zone or the **company's**?
2. Does it move a clock-out after midnight to the **next day**?
3. Does it show the server's 400 `message`, including `CUTOFF_LOCKED` and `CONTEST_PENDING`? Does it retry a failed submit automatically?
4. Is there an **approver screen** for contests? If yes, are its times in the company zone?
5. Does the app ever submit a contest for **someone else's** punch (an admin or supervisor filing for an employee)? This decides the ownership check in submit (not built yet).
6. Does the app show contest status on punches (pending / approved / rejected), and does it stop a second contest while one is pending?

## C. Already done by mobile (for the record)
- `/contest-policy/my-requests` wrong path (404): fixed by mobile. Expect it to drop from the error list.

## D. Still waiting from earlier tickets
- BB-117: sign-out device-token clear and the unlisted routes (see `CLAUDE.md`).
