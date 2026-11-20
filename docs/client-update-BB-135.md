# Client update — BB-135 Schedules List (sheet view)

**Server:** next push (version chosen at `/push`). **Web only.** Mobile: no change. **Status:** built 2026-11-18. **Database change:** none.

Your draft contract is accepted as written. This page confirms the final shape and the few details that differ.

## `GET /api/usershifts/range?from=YYYY-MM-DD&to=YYYY-MM-DD[&departmentId=]`
- **Roles:** admin, supervisor, superadmin.
- **Scope:** your company, human employees only. Supervisors see the whole company (same as the other schedule endpoints).
- **Dates:** `from` and `to` are required and inclusive. At most **62 days**. Dates are calendar dates; no time-zone shift.
- **Statuses:** all are returned, `cancelled` included.
- **Order:** employee, then date, then shift start time.

### Response 200
```json
{
  "message": "User shifts retrieved successfully.",
  "data": [
    {
      "id": "cuid",
      "userId": "cuid",
      "shiftId": "cuid",
      "assignedDate": "2026-11-06",
      "status": "scheduled",
      "isSplitShift": false,
      "customStartTime": null,
      "customEndTime": null,
      "scheduleId": "cuid-or-null",
      "createdFrom": "schedule",
      "notes": null,
      "createdAt": "…", "updatedAt": "…",
      "shift": {
        "id": "cuid",
        "shiftName": "AM Shift",
        "startTime": "1970-01-01T06:45:00.000Z",
        "endTime": "1970-01-01T08:00:00.000Z",
        "…": "all other Shift fields, e.g. timeZone"
      }
    }
  ]
}
```

**Differences from the draft (all additive):**
- Each row also has the other `UserShift` fields (`shiftId`, `createdFrom`, `notes`, `createdAt`, `updatedAt`), and `shift` has all its fields. This is the same as `/employee/:employeeId`. Ignore what you don't need.
- `customStartTime` / `customEndTime` are `"1970-01-01THH:mm:ss.000Z"` strings or `null`. Read the UTC hours as wall-clock time, the same as `shift.startTime`.
- Shifts for employees missing from `/api/employee?all=1` (e.g. removed) may still appear. Skip rows you have no employee for.

### Errors (`{ message }`)
| Status | When |
|---|---|
| 400 | `from` / `to` missing or not a real `YYYY-MM-DD` date, `to` before `from`, or more than 62 days |
| 403 | `departmentId` is not in your company; or the role isn't admin / supervisor / superadmin |
| 500 | Unexpected error |

---

# Part 2 — Roster OT warning (`includeOt=1`)

**Status:** built 2026-11-18. No database change. Your draft is accepted with the answers below.

`GET /api/usershifts/range?from&to[&departmentId]&includeOt=1` (`1` or `true`; any other value = off). Without it the response is unchanged. With it, `otProjection` is added next to `data`:

```json
"otProjection": {
  "basis": "cutoff",
  "threshold": 80,
  "available": true,
  "reason": null,
  "estimate": true,
  "employees": {
    "<userId>": [
      {
        "periodStart": "2026-11-09",
        "periodEnd": "2026-11-22",
        "periodSource": "generated",
        "projectedFrom": null,
        "cutoffPeriodId": "cuid",
        "cutoffStatus": "open",
        "scheduledHours": 84.5,
        "threshold": 80,
        "overBy": 4.5,
        "crossesOn": "2026-11-21",
        "fixedHours": false,
        "estimate": true
      }
    ]
  }
}
```

## Answers to your questions
- **Periods with `overBy: 0` are included,** so the Hours column can show "36 / 40".
- **`includeOt` values:** anything other than `1`/`true` counts as off (no 400).
- **Cutoff periods are per department.** Payroll uses each department's own cutoff periods, so **don't assume one period length for everyone**: always use each entry's `periodStart`/`periodEnd`. Employees in different departments can have different periods in the same week.
- **Weekly** = ISO week, Monday to Sunday (as you expected).

## Rules the server applies
- **Hours:** net, the same way a punch is computed.
  - Shift length (custom times when set; overnight handled) minus lunch, minus auto-coffee when it counts against hours.
  - **Lunch:** taken off **once per employee per day.** It's the auto-lunch minutes if the department or shift has auto-lunch that counts; 0 if the auto-lunch is set not to count; otherwise the company minimum lunch.
  - That's why everything is marked **`estimate: true`**: the schedule can't tell if a day's shifts will be one punch (e.g. Driver/Aide) or several.
- **Cancelled shifts** don't count. A shift counts fully on its `assignedDate`.
- **Fixed-hours employees** (paid a flat amount per cutoff): `fixedHours: true` and `overBy: 0` always, because their scheduled duty is never OT. Suggested display: "Fixed hours" instead of "44 / 40".

## When the cutoff period doesn't exist yet (`periodSource`)
Payroll creates cutoff periods only a little ahead of time. When the Roster shows dates further out, the server works out the period the same way the system will create it:

| `periodSource` | `projectedFrom` | Meaning | Suggested display |
|---|---|---|---|
| `calendar` | `null` | Daily / weekly basis | normal |
| `generated` | `null` | A real cutoff period | normal |
| `projected` | `latest_period` | Not created yet; continues the latest period with the same length, as the nightly job will | "44 / 40 (projected cutoff)" |
| `projected` | `cutoff_settings` | No periods yet; from the department's cutoff settings | same |
| `projected` | `company_seed` | From the company cutoff seed | same |
| `unknown` | `null` | No period can be worked out (dates before the first period, a gap between periods, or cutoff settings turned off) | Show the hours only, no OT marker: "Cutoff not set up for these dates" |

For `unknown` entries, `periodStart`/`periodEnd` are just the first and last scheduled dates in that stretch, and `threshold`, `overBy` and `crossesOn` are `null`.

## `available: false`
Only when the basis is `cutoff` and the company has no cutoff periods and no cutoff settings at all. The `reason` text is ready to show; `employees` is `{}`.

## Cells and tooltips
- **OT marker** from `crossesOn` to `periodEnd` (visible dates only), as you planned.
- **Tooltip:** "Scheduled 84.5h this cutoff (Nov 9–22, limit 80h), 4.5h over. Estimate from the schedule."

---

# Addendum (2026-11-18) — per-day breakdown + answers

**Status:** built 2026-11-18. Additive, no database change.

## `days[]` on every projection entry
One item per date **of the whole period** that has scheduled (non-cancelled) shifts, in date order. Dates outside `from`–`to` are included because they count towards the period.

```json
"days": [
  {
    "date": "2026-11-08",
    "grossHours": 12,
    "lunchHours": 0,
    "lunchRule": "auto_lunch_not_deducted",
    "lunchSource": "department",
    "coffeeHours": 0,
    "netHours": 12,
    "overnightShifts": 1
  }
]
```

| Field | Meaning |
|---|---|
| `grossHours` | Sum of the day's shift lengths (custom times when set; overnight shifts in full) |
| `lunchHours` | Lunch taken off that day (once per day) |
| `lunchRule` | `auto_lunch` (auto-lunch, deducted) · `auto_lunch_not_deducted` (auto-lunch applies but doesn't count → 0) · `minimum_lunch` (company minimum lunch, default 60 min) · `minimum_lunch_auto_too_short` (**new**: auto-lunch applies but doesn't fit in the day's longest shift, so the company minimum is used, as on a real punch) |
| `lunchSource` | Where the lunch setting came from: `department` or `shift` (per the company's auto-break basis), or `company` (minimum lunch) |
| `coffeeHours` | Auto-coffee taken off (only when it counts against hours) |
| `netHours` | `grossHours − lunchHours − coffeeHours`, never below 0. The `netHours` of an entry add up to its `scheduledHours` (±0.01 from rounding) |
| `overnightShifts` | How many of the day's shifts end the next day (counted fully on this date) |

Suggested tooltip wording for `lunchRule`:
- `auto_lunch`: "auto-lunch"
- `auto_lunch_not_deducted`: "auto-lunch, not deducted"
- `minimum_lunch`: "minimum lunch"
- `minimum_lunch_auto_too_short`: "minimum lunch, shift too short for auto-lunch"

Add "(department setting)" / "(shift setting)" from `lunchSource`.

## Answers
**Why case B has no lunch deducted.** The code gives a day 0 lunch only when **all** of these hold:
- the company has an auto-break basis and auto-lunch switched on
- the employee's **department** (basis "department") or that day's **longest shift** (basis "shift") is entitled to auto-lunch
- the lunch fits in the longest shift
- it's set **not** to count against hours

Case A got 1h, so A's department or shift is either not entitled (company minimum) or has a deductible 60-min auto-lunch. `lunchRule` + `lunchSource` now show exactly which, for each day.

**Overnight shifts on a daily basis.** The Roster already matches payroll:
1. Payroll daily OT adds up the approved hours of punches by their **clock-in date** (company zone). An overnight punch counts entirely on the day it starts. The OT-request screen and BNC do the same.
2. No company or labour setting splits a workday at midnight or at a configured day start.

Nothing changes until Carlo decides; `overnightShifts` makes it visible.
