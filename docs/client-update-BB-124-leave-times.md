# Client update — BB-124 follow-up: Leave day times (shift + start–end) in leave details

**Server:** next push (version chosen at `/push`). **Web:** leave Request details + approval preview. **Mobile:** optional (same fields, if the app shows leave details). **Status:** built 2026-11-25. **Database change:** none. **Additive:** existing fields unchanged; nothing breaks before the client updates.

## Why
A leave day only showed `date · hours · paid`. For a partial-day leave that looks wrong next to the punches: e.g. a Driver/Aide with a 6.75h punch day (AM + Regular) and an approved **1.25h Sick Leave** the same day. With the times it reads correctly: **Driver/Aide PM Shift 1:30–2:45 PM · 1.25h**, punch 6:51–11:59 AM. It also makes a real mistake (leave on hours that were paid) visible.

## What the server sends now
Every leave day row gets **`windows`**: the time the leave charges that day.

```json
{
  "date": "2026-11-13", "isPaid": true, "hours": 1.25, "reverted": false, "revertedAt": null,
  "windows": [
    { "kind": "shift", "shiftName": "Driver/Aide PM Shift", "start": "1:30 PM", "end": "2:45 PM",
      "timeZone": "America/Los_Angeles", "zoneLabel": "Los Angeles", "hours": 1.25 }
  ]
}
```

- `kind`:
  - `"shift"` — a scheduled shift the leave covers (one item per shift; shifts the employee deselected are not listed);
  - `"requested"` — no shift that day, the employee's entered time window (`shiftName: null`);
  - `"whole_day"` — no shift and no entered times (`shiftName: null`, start/end "12:00 AM").
- `start` / `end` are already formatted in that window's zone (`timeZone`, `zoneLabel`). Shift days use the shift's own zone (BizSolutions LLC: Manila shifts in an LA company), so show `zoneLabel` when it differs from the company zone.
- `windows: []` = nothing charged that day (all shifts deselected, or an unplotted weekend with weekends excluded).
- A day split paid/unpaid (two rows, same date) carries the same `windows` on both rows.
- Read live from the day's shift assignments (the leave doesn't store them): if a shift is changed after approval, the times follow.

## Endpoints
1. `GET /api/leaves/:id/days` (Request details, after a decision) — each item in `data[]` has `windows`.
2. `GET /api/leaves/:id/preview` (approver, before deciding) — each item in `data.days[]` has `windows`.

## Suggested UI
Request details → "Actual day-by-day outcome", one line per day:
> **Fri, Nov 13** · Driver/Aide PM Shift · 1:30 PM – 2:45 PM · 1.25h · **Paid**

- Several shifts: list them ("Driver/Aide AM 6:45–8:00 AM, Regular 8:00 AM–1:30 PM, Driver/Aide PM 1:30–2:45 PM") or "Full day" when the day's charged hours equal the whole schedule.
- `requested`: "6:00 PM – 10:00 PM" without a shift name. `whole_day`: "Whole day".
- Approval preview: same line per day, so the approver sees the times before approving.

## Department name in leave lists
`GET /api/leaves` and `GET /api/leaves/pending` now include the employee's department: `User.department = { id, name }` (`null` when the employee has none). Request details showed "Department: Not specified" because only `User.departmentId` was sent. Show `User.department.name`.

## UI notes from the first look (2026-11-25)
- Show `zoneLabel` only when it differs from the company zone (PadPro: company and shifts are both Los Angeles, so "(Los Angeles time)" is noise; BizSolutions LLC Manila shifts need it).
- In the narrow panel, put the shift name on one line and the times on the next ("Driver/Aide PM Shift" / "1:30 – 2:45 PM") so the time doesn't wrap.

## Payroll Grid (Excel) — no client change
On a day with hours, a partial-day leave now shows its code (e.g. **SL**) in the empty AM / Regular / PM cell of the shift it covers, with a hover note ("Sick Leave 1.25h paid · Driver/Aide PM Shift 1:30 PM–2:45 PM"). Whole-day leave stays one label across the day. Server-built; the page only downloads it.
