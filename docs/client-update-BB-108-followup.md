# Server reply — BB-108 follow-up (guide rows, clock times, supervisor scope)

**From:** bizbuddy-v2-server
**For:** bizbuddy-v2-client-web (Import Punch Logs, Upload Schedule, Backtrack import)
**Ship:** server and client together.

The guide-row request is done as specified. Two related fixes came out of testing, and both need
small client changes:

1. **Clock times:** more formats are accepted, and the error messages are new.
2. **Supervisor scope:** the import refused employees the picker offered. That was the cause of the
   "template doesn't download" 403.

---

## 1. Client changes needed

| # | Where | Change |
|---|---|---|
| 1 | Import Punch Logs and Upload Schedule: employee picker | Keep using `GET /api/employee/team`, but **show only `status === "active"`**. That endpoint also returns inactive people, and the imports refuse them. Send **user ids** (`user.id`) in `userIds`, not employee codes or emails. |
| 2 | Both: template download | **Check the response status before saving the file.** 200 is the CSV. Any other status is JSON `{ message }`, so **show the `message`**. Today a refusal downloads nothing and shows nothing. |
| 3 | Both: department option | For "everyone in scope", **leave `departmentId` out** (don't send `"all"` or `""`). Supervisors should only be offered **their own department**. |
| 4 | Import Punch Logs: dialog copy | The guide-row line is now accurate. Add the accepted time formats (see 3). |
| 5 | Results tables | New row error texts (see 5). Row numbers are the real line numbers in the file: the **first employee row is row 3** (header = 1, guide = 2). |

---

## 2. Guide row (both templates)

- **Position:** the first row under the header. Its first cell is `# GUIDE - not imported`.
- **On upload or preview,** any row whose **first cell starts with `#`** is ignored:
  - It isn't imported, isn't failed, isn't counted in `skipped`, and doesn't count towards the limits.
  - It never becomes a schedule preview item, in the new or the legacy preview.
  - It still works if the sheet was sorted.
- **A file with only guide rows** returns 400 `CSV file has no data rows.`

### Import Punch Logs

| Column | Guide cell |
|---|---|
| name | `# GUIDE - not imported` |
| email | (blank) |
| date | `YYYY-MM-DD` |
| clockIn | `08:00 or 8:00 AM` |
| clockOut | `17:00 or 5:00 PM` |
| punchType | B&C: `REGULAR or TRAINING (blank = REGULAR)`. Every other company: `REGULAR \| DRIVER_AIDE \| DRIVER_AIDE_AM \| DRIVER_AIDE_PM \| TRAINING (blank = REGULAR)` |
| reason | `optional` |
| notes | `optional` |

- **"DayCare" isn't used:** only B&C counts as BNC, so every other company gets the full list.
- **Old blank template** (no `startDate`/`endDate`): the guide row replaces the example row, which
  used to be imported if left in. Its first column is `date`, so that cell reads
  `# GUIDE - not imported (date: YYYY-MM-DD)`.

### Upload Schedule

| Column | Guide cell |
|---|---|
| email | `# GUIDE - not imported` |
| name | `Mark x (or 1 / yes) under each slot to schedule` |
| date | `YYYY-MM-DD` |
| first shift / time-block column | `x` |
| other slot columns | (blank) |

---

## 3. Clock times (Import Punch Logs) — answer to "does 8:00 AM parse?"

**Yes, now.** Before this fix, only `08:00` was reliable. `8:00`, `8:00 AM` and `8:00:00 AM` were
guessed in the **server's** time zone, which gave either an error or a time shifted by hours. Excel
often saves times as `8:00:00 AM`, so admins could hit this even when they typed `08:00`.

Times are now read in the **company's** time zone:

| Accepted | Examples |
|---|---|
| 24-hour | `08:00`, `8:00`, `08:00:00`, `20:00` |
| 12-hour (any case) | `8:00 AM`, `8:00:00 AM`, `8 AM`, `8:00AM`, `8:00 pm` |
| With its own date and offset | `2026-10-01T08:00:00-07:00`, used as-is |

- **Anything else fails the row** with:
  - `Invalid clock-in time "…". Use 08:00 or 8:00 AM.`
  - `Invalid clock-out time "…". Use 17:00 or 5:00 PM.`

  These replace `Invalid date, clockIn, or clockOut.`
- **Overnight:** a clock-out earlier than the clock-in still rolls over to the next day.

**Suggested dialog line:** *"Times: 08:00 or 8:00 AM. A clock-out earlier than the clock-in counts as
the next day. The first row is a guide and is never imported; you can delete it or leave it in."*

---

## 4. Supervisor scope (both imports)

**Why the template didn't download:**
- The picker (`/employee/team`, BB-080) gives a supervisor their own department **plus their direct
  reports in other departments**.
- The imports only accepted the **own department**.
- So picking a direct report returned 403 with no file.

**Now both imports use the same team rule as `/employee/team`.** A supervisor's team is their own
department **or** anyone whose supervisor is them (`EmploymentDetail.supervisorId`), in any department.

| Supervisor picks | Template covers |
|---|---|
| nothing (no `userIds`, no `departmentId`) | their whole team |
| their own `departmentId` | that department only |
| specific `userIds` | those people, if all are active and in the team |

- Admins are unchanged: the whole company.
- A supervisor with no department can still import for their direct reports.
- **Backtrack punch-log import** follows the same rule. Its preview matches names against the
  supervisor's team, **active people only**. Its commit error is now `Employee not found in your
  team.` No client change is needed beyond that new message. The employee dropdown for manually
  assigning a row should also show only active team members (`/employee/team`, `status === "active"`).

---

## 5. Messages the client may now see

**Template download (JSON `{ message }`):**

| Status | `message` |
|---|---|
| 400 | `startDate and endDate are required (YYYY-MM-DD).` · `endDate must be on or after startDate.` · `The date range can be at most 31 days (got N).` (Upload Schedule: 14) · `That's N rows (E employees × D days); the limit is 2000. Pick fewer employees or days.` · `No active employees match this selection.` (Import Punch Logs) |
| 403 | `N of M selected employees are inactive or outside your scope.` *(new wording)* · `You can only import punch logs for your own department.` / `You can only upload schedules for your own department.` · `Department not found in your company.` |

**Per row (upload results / schedule preview):**

| Message | When |
|---|---|
| `Employee not found in your team.` | A supervisor's row is for someone outside their team (Import Punch Logs, Upload Schedule, Backtrack import). This replaces "…in your department." |
| `Missing clock-in.` / `Missing clock-out.` | Only one of the two times is filled in. |
| `Invalid clock-in time "…". Use 08:00 or 8:00 AM.` | The time format wasn't recognized. |
| `Invalid clock-out time "…". Use 17:00 or 5:00 PM.` | The time format wasn't recognized. |

The upload response shape is unchanged: 207
`{ message, data: { created[], failed[], skipped } }`, with `name` on each row.

---

## 6. Test checklist

1. **Supervisor and a direct report from another department:**
   - The template downloads.
   - The upload accepts their rows.
   - Upload Schedule preview accepts them too.
2. **Inactive employees** don't appear in either picker.
3. **Force a refusal** (e.g. 32 days): the dialog shows the server's message, and no empty file is
   saved.
4. **Guide row:**
   - Row 2 of both templates is the guide.
   - Uploading with it left in imports nothing from it.
   - The first employee row reports as row 3.
5. **Times:**
   - `08:00`, `8:00`, `8:00 AM` and `8:00:00 AM` all import at the right company-local time.
   - `8 o'clock` fails with the new message.
6. **Punch-type hint:** a B&C template shows the short hint; any other company shows the full list.
