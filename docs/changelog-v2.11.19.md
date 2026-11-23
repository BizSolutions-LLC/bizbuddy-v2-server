# Changelog — v2.11.19

**Branch:** `release/v2.11.19` (pushed 2026-11-23), from `origin/master` (after PR #133).

**Tickets:**
- BB-124 follow-up: a leave request that overlaps a punch is refused. **Built; the block was confirmed by the user in dev on 2026-11-23. The time-zone wording fix made after that test is awaiting retest.**
- BB-141: status note only (prod S3 upload works after the AWS env values were fixed; no code change).

**Schema change:** none. **Deploy:** needed (server code change). No SQL, no `prisma generate`, no data scripts.
**Client impact:** yes. The web leave form and the approver dialog should show the new 409 / warnings. Hand-off `docs/client-update-BB-124.md` (not sent).
**Mobile impact:** yes. The leave form must show the 409 message. Hand-off `docs/mobile-update-BB-124.md` (not sent).

---

# BB-124 — Block a leave request that overlaps an existing punch

- **What:** Josie Soriano (PadPro) clocked in Nov 9 at 6:51 AM, then filed a full-day Sick Leave for the same morning. It was accepted and approved, and payroll counted both. The server now refuses a leave request that covers time the employee already punched, including while they are still clocked in.
- **Rule** (user decisions, 2026-11-23):
  - The leave time compared is what is actually charged (same branches as `calcDailyHours`):
    - shift day: the shift times, minus unticked shifts, in the shift's own zone; the entered From/To is ignored there;
    - no-shift day: the entered From/To, or the whole day;
    - unscheduled Sat/Sun with "include weekends" off: nothing.
  - An open punch counts as running until now.
  - A punch whose cutoff approvals are all `excluded` is ignored.
  - Touching times are allowed (punch ends 12:30, leave starts 12:30).
  - One overlapping day refuses the whole request.
  - Approvers get a **warning only**; approval is never blocked.
- **Display:** conflict times are written in the zone the day's leave time belongs to (shift zone on shift days, else company zone), with `timeZone` and `zoneLabel`. Found in testing: BizSolutions LLC's company zone is Los Angeles but its shifts are Manila, so company-zone times showed the day before the leave date.
- **Changes:**
  - `src/utils/leaveUtils.js`: new `findLeavePunchOverlaps()` and `describeLeavePunchOverlaps()`.
  - `src/controllers/Features/leaveController.js`:
    - `submitLeaveRequest` returns 409 `LEAVE_OVERLAPS_PUNCH` (`message`, `conflicts`) before saving.
    - `previewApproval` adds `data.punchOverlaps`.
    - The final `approveLeave` response adds `punchOverlaps`. A failed check returns `[]`, so it never breaks approval.
    - `getAffectedSchedules` returns `{ data, punchOverlaps }`.
  - `docs/client-update-BB-124.md` and `docs/mobile-update-BB-124.md` (new).
  - `CLAUDE.md`: BB-124 / BB-125 notes, latest push.
- **Endpoints:**
  - `POST /api/leaves/submit`: new 409.
  - `GET /api/leaves/affected-schedules`: `punchOverlaps` added.
  - `GET /api/leaves/:id/preview`: `data.punchOverlaps` added.
  - `PUT /api/leaves/:id/approve` (final): `punchOverlaps` added.
  - All additions are additive except the new 409.
- **Order of steps:** merge → deploy → send the client and mobile hand-offs.
- **Open / not covered:**
  - Leave first, punch later is not blocked; approvers see a warning while the leave is pending.
  - The `affected-schedules` preview doesn't know which shifts were unticked.
  - A partial-day leave on an already-punched shift day isn't possible (the leave covers the whole shift; that is how leave is charged, own ticket if wanted).
  - Pre-existing, client: the form's shift card shows company-zone times under the shift's own date.

# BB-141 — Status note

- `CLAUDE.md` only. The first prod upload failed with `SignatureDoesNotMatch` (wrong AWS env values, fixed by the user); upload + 5-minute signed link now work.
- Kept as is: direct S3 signed links (no CloudFront for now).
- Open: whether supervisors should see face photos company-wide or team-only.
