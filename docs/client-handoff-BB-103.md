# Server reply — BB-103 Upload Schedule

**Status:** Built on the server (first pass, for BNC). Your draft is followed, with the answers and the
differences listed below. Nothing changes for the old client: preview and confirm without `mode` still
run the old flow, and the old `weekStart` template link still works.

---

## Answers to your questions

1. **Shift column headers.** Send the same `shiftIds` to `/template` and `/preview`. The server builds
   the headers from that list both times (`Morning (10:00 AM - 5:00 PM)`, with ` #2`, ` #3` added when a
   header repeats) and requires an exact match. Spacing and letter case are ignored. A missing, renamed or
   extra column returns **400**: "…The template is out of date — download it again." The header uses a
   plain hyphen, not an en dash, because Excel garbles en dashes in CSVs.
2. **Replace deletes the old assignment.** It does not cancel it. Most screens, including the schedule
   calendar, missed-clock-in alerts, clock-in reminders and the reports, don't filter out cancelled
   assignments. A cancelled shift would still show up and still raise "missed clock-in". The manual
   Replace in shift assignments already deletes, so this matches it. The record of what was removed is:
   - `replaced[].removed` in the confirm response
   - the employee's **`SCHEDULE_REPLACED`** notification ("Shift Changed", the existing code), sent once
     per removed assignment

   **Replace is blocked** when the existing assignment:
   - is `completed`
   - belongs to an employee who already has punches on that date (company timezone)
   - falls on a date in a **locked or processed** cutoff for the employee's department, or a
     company-wide one

   We think that list is complete.
3. **Row limit: 2,000 rows** per file. The template refuses to build more than that (employees × days).
4. **Reusing a matching Shift in `time_blocks` mode: yes.** A company Shift is reused when the start, the
   end, the overnight flag and the name (ignoring case) all match. Otherwise a new one is created, once per
   import. Note that a reused Shift keeps its own auto-lunch and coffee-break settings.

## Changes from your draft

- **Template**
  - The columns are `email,name,date,…`. Rows match on **email**, and `name` is for reading only. There
    is no `employeeId` column. An older file with an `employeeId` column still matches on it.
  - The file starts with a UTF-8 BOM so Excel keeps accented names intact.
  - The filename is `schedule_<mode>_<start>_to_<end>.csv`.
  - `overnight` has no effect on the template any more, because there is no example row.
- **Dates:** `YYYY-MM-DD` and `M/D/YYYY` are both accepted, because Excel re-saves dates that way.
- **Preview range:** if you send `startDate`/`endDate`, rows outside them are `error` items. If you
  don't, the file's own dates must fit within 14 days, or the whole file is rejected with 400.
- **`range`** in the response is `{ startDate, endDate }`. If the file has no dated rows, it is `null`.
- **Item keys**
  - `r14:c2`: row 14, shift column 2 (columns numbered from 1 in `shiftIds` order).
  - `r14:b1`: row 14, the first run of time blocks.
  - `r14`: a row-level `error` item (one per row). Its `shift` is `null` and `employee` may be partial
    (`userId: null`).
- **`conflict_file`**
  - `conflicts[]` entries are `{ key, date, shiftName, startTime, endTime, crossesMidnight }`.
  - It takes priority over `conflict_existing`. An item that clashes with the file isn't also checked
    against the database.
- **Summary counts:** `ready`, `conflictExisting`, `conflictFile` and `error` count **items**, not rows.
  `rows` and `blankRows` count CSV rows.
- **`time_blocks` items**
  - `shift.shiftId` is set and `isExisting` is `true` when an existing Shift matches the default name and
    times.
  - If the admin renames it, send the new `shift.shiftName`. Confirm re-matches by name and times.
- **Confirm**
  - Send `mode`, `decisions` and `items` (the preview items as returned).
  - An item with no decision is ignored.
  - An unknown or duplicate key, or an unknown action, goes to `failed`.
  - A `replace` whose conflicts have disappeared since the preview is simply created, and appears in
    `created`.
  - A `replace` that now overlaps an assignment **not** listed in its `conflicts` fails with "The
    schedule changed since the preview. Upload the file again."
  - Items are applied in order. A later item that overlaps one created earlier in the same request fails.
- **`employee`** on preview items is `{ userId, email, name }`. There is no `employeeId`.
- **Response entries:**
  - `created[]` and `replaced[]`: `{ key, userId, date, shiftId, shiftName, startTime, endTime, userShiftId }`.
  - `replaced[]` also has `removed: [{ userShiftId, shiftId, shiftName, date, startTime, endTime }]`.
  - `skipped[]`: `{ key }`.
  - `failed[]`: `{ key, reason }`.
- **Notifications**
  - New assignments send **`SCHEDULE_ASSIGNED`**, as today.
  - Replacements send **`SCHEDULE_REPLACED`** instead of an assigned notification.
  - Management gets one **`SCHEDULE_ASSIGNED_MANAGEMENT`** per shift, counting both.

## Fixed along the way (these affected the old flow too)

- **Supervisors:** uploads failed at confirm and the preview showed the whole company, because the
  supervisor's department was never loaded. Fixed. Supervisors now see only their own department, and
  anything outside it returns 403.
- **Overnight overlaps:** these were never detected, because a 19:00–05:00 shift never overlapped
  anything. They are now detected, including spill into the next date.
- **Conflict checks:** cancelled assignments no longer count as conflicts.
- **Inactive employees:** they are now `error` items in the preview, instead of failing at confirm.
- **Blank rows:** these are skipped silently, in the old flow too.

## Errors

- **400:**
  - a bad `mode`
  - a missing or invalid date
  - a range over 14 days
  - `shifts` mode without `shiftIds`, or duplicate `shiftIds`
  - a CSV shape problem
  - a file over 2,000 rows
  - a template over 2,000 rows
  - no decisions sent
- **403:**
  - a shift, department or employee outside the caller's company or scope
  - a supervisor with no department
  - `userIds` containing an inactive employee

Error bodies are `{ "message": "..." }`.

## Quick test calls

```
GET  /api/schedule-import/template?mode=shifts&startDate=2026-10-26&endDate=2026-11-08&shiftIds=<id1>,<id2>
GET  /api/schedule-import/template?mode=time_blocks&startDate=2026-10-26&endDate=2026-11-01&departmentId=<dept>
POST /api/schedule-import/preview   (multipart: file, mode=shifts, shiftIds=<id1>,<id2>)
POST /api/schedule-import/confirm   { mode, decisions, items }
```
