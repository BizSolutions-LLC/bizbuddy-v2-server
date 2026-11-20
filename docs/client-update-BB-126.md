# Server reply: BB-126 Employees Punch Logs, server-computed rows

**Server version:** next release (built 2026-11-20). **Company web app.** Mobile: not affected (all additions; nothing removed or renamed).
**Database change:** none.

Your draft is accepted, with the differences marked **(changed)** below. `GET /api/timelogs` and the punch-log report now use **one** shared calculation (`services/TimeLogs/punchDisplay.js`), so the table and the PDF / Excel show the same values.

## Answers to your questions
1. **One nested `display` object:** yes, as proposed. Raw fields stay as they are.
2. **Summary with your filters:** on the **server**. Send the filters as query params (below) and `meta.summary` covers every page. Stop filtering several employees / search / punch type in the browser.
3. **Reviewed mode:** **(changed)** exactly the report's rule, which is **per selected cutoff period**, not "all locked". A punch whose approval belongs to a selected period that is `locked`/`processed` is `reviewed`; punches of open periods are not. With a mix, `meta.basis` is `"partial"` (the report's "Partly final").

## New: "decided" punches (agreed with Carlo)
Once **none** of a punch's approvals is pending any more (every segment, for Driver/Aide), its decision is shown even while the cutoff is still open:
- approved/resolved segments count their **approved payable hours** (an "Approve Schedule" or edited value wins);
- excluded/rejected count **0**, as in payroll.

This is read fresh on every request: **reset to pending → back to live** immediately. The report uses the same rule, so its "Data" column now shows **Decided** for these rows.

So `display.basis` is one of:
| `basis` | When | Hours from |
|---|---|---|
| `live` | the punch has a pending approval, or none yet | the punch's computed fields |
| `decided` | all approvals decided, cutoff still open | the approvals |
| `reviewed` | its cutoff is selected and locked/processed | the approvals (approved/resolved only) |

## Request
`GET /api/timelogs`, existing params unchanged (`page`, `limit`, `from`, `to`, `departmentId`, `employeeId`, `status`, `punchType`), plus:

| Param | Notes |
|---|---|
| `cutoffPeriodIds` | comma-separated, same as the report (send the sibling department periods too). Without `from`/`to`, the range is the periods' span. Unknown id → 404. |
| `employeeIds` | comma-separated: several employees (`employeeId` still works for one) |
| `q` | search name, email or employee ID (contains, any case) |
| `punchType` | already supported server-side (`REGULAR`, `TRAINING`, `DRIVER_AIDE`, …): please send it instead of filtering in the browser |

## `display` (on every row)
As you proposed, with these notes:

```json
"display": {
  "basis": "decided",
  "clockIn": "2026-11-18T15:00:00.000Z",
  "clockOut": "2026-11-18T23:00:00.000Z",
  "clockAdjusted": true,
  "workedHours": 8,
  "grossHours": 8.5,
  "scheduledHours": 8,
  "isScheduled": true,
  "lateHours": 0,
  "undertimeHours": 0,
  "coffeeMinutes": 30,
  "lunchMinutes": 60,
  "lunchAuto": false,
  "otHours": 0,
  "otStatus": "—",
  "segments": null,
  "cutoffStatus": "Approved",
  "deviceIn": "Apple, iPhone 15",
  "deviceOut": null,
  "locationIn": "38.58160, -121.49440",
  "locationOut": null,
  "schedule": [ { "id": "…", "assignedDate": "2026-11-18", "shift": { "id": "…", "shiftName": "Regular Shift", "startTime": "…", "endTime": "…" } } ],
  "matchedShiftId": "…",
  "missingClockOut": false
}
```
- `cutoffStatus`: `"Not in a cutoff"` · `"Pending review"` · `"Approved"` · `"Excluded"` (same wording as the report).
- `otStatus`: DayCare daily/weekly `"Approved"` · `"Pending"` · `"Not requested"` · `"—"`; B&C the day's OT block (`"Approved"` · `"Pending"` · `"Excluded"`); **DayCare cutoff-basis** keeps today's table wording `"-"` · `"Included"` · `"Approved"` with `otHours: null` (OT is per cutoff, as in the report).
- `segments`: `{ am, regular, pm }` for Driver/Aide (decided/reviewed: the approved payable hours of each segment), else `null`.
- `schedule` / `matchedShiftId`: the shifts of **the punch's date** for **both** company types (fixes #1). DayCare: the regular shift when there are several (Driver/Aide days), else the only one. The raw `userShifts` / `userShift` / `shiftToday` fields are fixed the same way.
- `missingClockOut`: still clocked in past clock-in + the company's **default shift hours** (`Company.defaultShiftHours`, 8 by default).
- `isScheduled`: `scheduledHours != null`, as in the report.

## Response: new `meta` (whole filtered set)
```json
"meta": {
  "total": 240,
  "basis": "live",
  "summary": {
    "active": 3,
    "completed": 237,
    "scheduled": 220,
    "decided": 120,
    "reviewed": 0,
    "avgWorkedHours": 7.6,
    "totalWorkedHours": 1801.25,
    "totalScheduledHours": 1880
  }
}
```
- `basis`: `"live"` · `"reviewed"` · `"partial"` (per selected period, like the report). Show the "Reviewed values" note for `reviewed` / `partial`.
- `avgWorkedHours` / `totalWorkedHours`: completed punches only, using `display.workedHours`.
- `decided` / `reviewed`: how many punches use approval values (optional to show).
- Above **10,000** matching punches the totals are skipped: `meta.summary` is `null` and `meta.summaryNote` says to narrow the filters. Counts in `pagination` still work.
- The old top-level `summary` object is unchanged, for older clients.

## After you switch
Display only: every column, the detail panel, the schedule dialog, the cards and totals read `display` / `meta.summary`. Edits still go through the existing endpoints, then refetch.

Client changelog: "Needs server v2.11.17 or later" (version confirmed at push).
