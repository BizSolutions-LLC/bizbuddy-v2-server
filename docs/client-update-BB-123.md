# Client update — BB-123: contest request times (Employee Page + Contest Requests)

**For:** the client-web session (bizbuddy-v2-client-web). The server side is done in the server repo; **don't touch the server repo.** Mobile: see the questions at the end.

BB-123 is the Employee Page update. The `/dashboard/employee/punch-logs` table is already done. Testing it showed the contest flow saves and shows times in the **viewer's browser zone** instead of the **company zone**.

---

## What the data showed (server checks, 2026-11-12)
- **No time log is corrupted.**
- **The zone bug** shows in test data:
  - Sunshine Learning (test company): a pending request moved **exactly +16h, same length**. The server's new check **can't** catch this, because it is forward and short.
  - Carlo's BizSolutions test: 16:00 → 01:00 became a backwards request 16 hours early ("−24.00h from recorded").
  - The WWW / YYY requests belong to companies that are now inactive.
- **A real case, Robert Ramirez (Piedmont):**
  - He contested his **Thursday** log to make it **Friday** (+24h), when he should have requested a new punch for Friday.
  - It was approved after his cutoff was locked. An admin then re-created Thursday by hand. His hours are fine now.
  - This showed that contests could change punches in locked cutoffs, so the server now **blocks** that (see below).
- **Lesson:** the server can stop impossible times but not believable wrong ones. The two screens below have to make the zone, the date and the size of the change obvious.

## Server contract change (live with v2.11.8)
- `POST /api/contest-policy/submit` and `PATCH /api/contest-policy/approve/:id` now return **400 `{ message }`** when:
  - a requested time is invalid;
  - the clock-out is not after the clock-in;
  - the shift is 24h or longer.
- The approve message ends with "Reject this request and ask the employee to resubmit."
- **Locked cutoffs:** both endpoints also return **400 `{ code: "CUTOFF_LOCKED", message }`** when the punch is in a `locked` or `processed` cutoff. That covers:
  - the cutoff the log is already reviewed in;
  - the cutoff covering the recorded date or the requested date, so a punch can't be moved into or out of a locked period.
- Submit message: "This punch is in a locked cutoff period (Oct 28, 2026 – Nov 10, 2026), so it can't be contested. Please contact your admin."
- Approve message: "…Reopen the cutoff before approving, or reject this request."
- **One pending contest per punch:** submit returns **400 `{ code: "CONTEST_PENDING", message, contestId }`** when the punch already has a pending contest. Rejected or approved ones don't block.

---

## 1. Employee Page: contest dialog
`components/Dashboard/DashboardContent/EmployeePanel/TimeKeeping/ContestDialog.jsx` (+ `PunchLogs.jsx` submit)

| # | Problem | Fix |
|---|---|---|
| 1.1 | `buildISO` does `new Date("YYYY-MM-DDTHH:MM:00")`, which reads the time in the **browser's** zone | Build both times as wall-clock times in `companyTimezone` (use the project's time zone library) |
| 1.2 | No overnight handling: 01:00 lands before 16:00 on the same date | If the clock-out ≤ the clock-in, move the clock-out to the **next day** |
| 1.3 | `netHours` assumes a same-day shift, which showed −24.00h | Add 24h when the result ≤ 0 |
| 1.4 | The punch log dropdown date uses the browser's zone ("Wed, Nov 11" for the Tue Nov 10 log) | Format the dropdown date in `companyTimezone` |
| 1.5 | Nothing tells the user which zone to type in | Add a hint line under the time fields: **"All times are in the company time zone ({label})"**. Build the label from `companyTimezone`; **never hard-code it**. Use `date-fns-tz` (already a dependency): `formatInTimeZone(selectedLog.timeIn, companyTimezone, "zzz")` gives e.g. "PST"/"PDT", or combine it with the city taken from the IANA name ("Los Angeles"). Show the same label on the Recorded / Requested strip |
| 1.6 | A large change is easy to miss | Compare the **requested clock-in with the recorded clock-in only**. Warn when it moves **12h or more, or to another calendar date** (company zone): "This moves the punch to another day / by about N hours. Check the times are in {zone}." **Never warn because the clock-out falls on the next day**: that's a normal overnight shift (item 1.2). Don't block submit, because a real "wrong day" correction can be large. When the clock-in date changes, add: "To add a missing day, use Request Punch Log instead of contesting another day's punch." |
| 1.6b | The employee can pick a punch in a locked cutoff, and only finds out on submit | Use the field the punch-logs table already has: **`log.cutoffApproval?.cutoffPeriod?.status`** (set in `PunchLogs.jsx`, shown by `V3CutoffBox`). When it is `"locked"` or `"processed"`, label the option **"Locked (cutoff closed)"** and disable it. **Don't add a new lookup.** A log in a locked period that has no `cutoffApproval` yet can't be detected on the client. The server still refuses it with `CUTOFF_LOCKED`, so show that message under the dropdown (not only as a toast) |
| 1.7 | Shifts of 24h or longer are only caught by the server | Block submit with an inline error |
| 1.8 | Server errors | Already OK: `PunchLogs.jsx` shows `j.message` in a toast. Keep it |

**Done when** (LA company, browser in Manila): picking the Tue Nov 10 log and entering 16:00 / 01:00 gives:
- a positive hours preview (9h), **with no 1.6 warning**: the clock-in moves 8h on the same date, and the clock-out on the next day is a normal overnight shift;
- a payload of `requestedClockIn = 2026-11-11T00:00:00.000Z` and `requestedClockOut = 2026-11-11T09:00:00.000Z`.

## 2. Company panel: Contest Requests (approver page)
`app/dashboard/company/contest-requests/page.jsx`

| # | Problem | Fix |
|---|---|---|
| 2.1 | `formatDateTime`, `formatTimeOnly` and `formatDateOnly` use `toLocale…String` **without `timeZone`**, so approvers see times in **their browser's** zone. A Manila approver sees Manila times for an LA company | Pass `timeZone: companyTimezone` in all three (the page already uses a `tz` for the cutoff date). Label the zone once on the page |
| 2.2 | Approvers can't see how big the change is | For each request, show the **change from recorded**: hours moved for clock-in and clock-out, and the new length vs the old. Highlight it when the clock-in moves **12h+ or to another date**, and when the length is unchanged but both times moved the same amount (the zone-shift signature, like the Sunshine Learning +16h test). Suggested label: "Moved +16h, same length: possible time zone mistake" |
| 2.3 | The server now refuses to approve a contest in a locked cutoff (`CUTOFF_LOCKED`). Pending requests submitted before this still appear with an active Approve button | On a pending request whose punch date is in a locked or processed cutoff, show a **"Cutoff locked"** badge and disable Approve, with the tooltip "Reopen the cutoff to approve, or reject." Reject stays available. If the page can't know the lock state, handle `CUTOFF_LOCKED` from the approve response the same way (item 2.4) |
| 2.4 | The approve error is generic: `toast.error(\`Failed to ${action} contest request.\`)` hides the server's message | Show `json.message` (the server's 400 explains why and says to reject) |

## 3. Pending requests
No real pending request needs action. The flagged ones are on the test company (Sunshine Learning) or on inactive companies (WWW, YYY). Reject or ignore them as you like.

## 4. Mobile: questions for the mobile developer
1. Does the mobile contest screen build the requested times in the device's zone or the company's?
2. Does it move a clock-out after midnight to the next day?
3. Does it show the server's 400 `message`?
4. Does mobile have an approver screen for contests? If yes, are its times in the company zone (same as 2.1)?

## 5. Punch-logs page: contest status on rows (client plan, approved)
- Read the employee's contests from `GET /api/contest-policy/view-contestTimeLogs` (own contests, newest first, `limit` default 50, `offset`, `hasMore`) and match them to rows by `timeLogId`. No server change.
- **Paging:** keep loading pages (or ask for a bigger `limit`) until the contests are older than the punch-logs window being shown. Otherwise older rows can miss their badge.
- Row badge "Contest pending / approved / rejected". Expanded-row section showing the latest contest + "+N earlier".
- Disable Contest while one is pending. The server also enforces it (`CONTEST_PENDING`), so show its message if it comes back.
- Reload the list after a successful submit.
