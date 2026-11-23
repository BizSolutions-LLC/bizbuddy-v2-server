# Mobile update: BB-124, leave request vs. an existing punch

**From:** bizbuddy-v2-server
**For:** the BizBuddy mobile app (iOS + Android)
**Ticket:** BB-124
**Server status:** built 2026-11-23, awaiting the user's test. Production after the next server release.

The server now refuses a leave request that covers time the employee already punched, including while they are still clocked in. Nothing breaks for older app versions: they get a normal error message.

> **Don't change the session, token or biometric handling as part of this.**

## What the app should do

### `POST /api/leaves/submit`: new 409
```json
{
  "code": "LEAVE_OVERLAPS_PUNCH",
  "message": "This leave overlaps time you already punched (2026-11-09: you are clocked in since 6:51 AM (Los Angeles time)). Clock out first, choose times outside the punch, or ask your supervisor to correct the punch.",
  "conflicts": [ { "date": "2026-11-09", "stillClockedIn": true, "punchInLocal": "2026-11-09 6:51 AM", "punchOutLocal": null, "leaveFromLocal": "2026-11-09 6:45 AM", "leaveToLocal": "2026-11-09 2:45 PM" } ]
}
```
- Each conflict also has `timeZone` and `zoneLabel`. The `*Local` strings are already in that zone (the shift's zone on shift days, else the company zone). Show them as they are, with "(<zoneLabel> time)".
- Show `message` and keep the form open, with the employee's entries still filled in.
- Please confirm that the app shows the server's `message` for a 409, not a generic "Something went wrong".

### Optional: `GET /api/leaves/affected-schedules`
The response now also has `punchOverlaps` (same items as `conflicts`), so the form can warn before submitting.

## The rule, briefly
- Days with a scheduled shift compare against the shift times. The From/To times only count on days without a shift; with no times entered, the whole day counts.
- An open punch counts until now.
- A punch that is fully excluded in the cutoff is ignored.
- Touching times are allowed.

## Questions for the mobile dev
1. Does the app's leave form call `affected-schedules`? If not, the submit 409 is the only signal, and that's fine.
2. Does the leave form let the employee untick a shift (`excludedShiftIds`), as on the web?
