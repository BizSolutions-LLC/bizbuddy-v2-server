# Client update: BB-124, leave request vs. an existing punch

**From:** bizbuddy-v2-server
**For:** bizbuddy-v2-client-web
**Ticket:** BB-124 (follow-up to Josie Soriano, Nov 9)
**Server status:** built 2026-11-23, uncommitted, awaiting the user's test. Available in dev after the next server release.

## Why
Josie clocked in at 6:51 AM and then filed a full-day Sick Leave for the same morning. The server accepted it, and payroll later counted both the punch and the leave. The server now refuses a leave request that covers time the employee already punched.

## The rule (server side, nothing to compute on the client)
For each day of the request, the server compares the employee's punches with the time the leave would actually be charged for:

| Day | Leave time compared |
|---|---|
| Has a scheduled shift | The shift's start → end, for each shift not unticked (`excludedShiftIds`). **The From/To times are ignored on these days**, just as they are for the hours. |
| No shift, From/To entered | The entered From → To (company time zone). |
| No shift, no times | The whole day. |
| Unscheduled Sat/Sun with "include weekends" off | Nothing (0 h). |

- A punch that is **still open** (clocked in) counts as running until now.
- A punch whose cutoff approvals are **all excluded** is ignored.
- Times that only touch are fine (punch ends 12:30 PM, leave starts 12:30 PM).
- One overlapping day refuses the whole request.

## API changes

### 1. `POST /api/leaves/submit`: new refusal
**409**
```json
{
  "code": "LEAVE_OVERLAPS_PUNCH",
  "message": "This leave overlaps time you already punched (2026-11-09: you are clocked in since 6:51 AM (Los Angeles time)). Clock out first, choose times outside the punch, or ask your supervisor to correct the punch.",
  "conflicts": [
    {
      "date": "2026-11-09",
      "timeLogId": "…",
      "punchIn": "2026-11-09T14:51:00.208Z",
      "punchOut": null,
      "stillClockedIn": true,
      "timeZone": "America/Los_Angeles",
      "zoneLabel": "Los Angeles",
      "leaveFrom": "2026-11-09T14:45:00.000Z",
      "leaveTo": "2026-11-09T22:45:00.000Z",
      "punchInLocal": "2026-11-09 6:51 AM",
      "punchOutLocal": null,
      "leaveFromLocal": "2026-11-09 6:45 AM",
      "leaveToLocal": "2026-11-09 2:45 PM"
    }
  ]
}
```
**Time zone (added 2026-11-23 after testing):** every `*Local` string is in `timeZone`, the zone the day's leave time belongs to. On a shift day that is the **shift's** zone; otherwise it's the company zone. `zoneLabel` is a short name for it ("Manila", "Los Angeles"). Show the label next to the times, e.g. "Nov 20: you punched 7:36 AM – 5:38 PM; this leave covers 8:00 AM – 5:00 PM (Manila time)". Don't convert these strings: they're display-ready. Why: BizSolutions LLC's company zone is Los Angeles but its shifts are Manila, so company-zone times showed a different calendar date from the leave day ("Fri, Nov 20" next to "2026-11-19 4:00 PM").

Seen in the same test, existing behaviour, not part of BB-124: the "Shifts that will be on leave" card shows the shift as 04:00 PM → 01:00 AM under Nov 20 (company-zone times next to the shift's own date). Consider showing the shift in its own zone there too.

**Client:** show `message` as it comes (or build your own from `conflicts`). Keep the form open so the employee can change the dates/times or untick a shift.

### 2. `GET /api/leaves/affected-schedules`: new `punchOverlaps` (additive)
The response is now `{ data, punchOverlaps }`, where `punchOverlaps` has the same shape as `conflicts` above (`[]` when clear).
**Client (recommended):** show an inline warning in the leave form before submit. This preview doesn't know which shifts the employee unticked, so unticking a shift can clear a warning. Submit is the final check.

### 3. `GET /api/leaves/:id/preview` (approver): new `data.punchOverlaps` (additive)
**Client:** in the approve dialog, show a warning such as "This employee punched during this leave: 2026-11-09 6:51 AM – 2:45 PM." **Warning only:** approval is still allowed.

### 4. `PUT /api/leaves/:id/approve` (final approval): new top-level `punchOverlaps` (additive)
Optional to show. Escalation responses don't include it.

## Nothing else changes
No schema change, no new settings, and existing leaves are untouched.
