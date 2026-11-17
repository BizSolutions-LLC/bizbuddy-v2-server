# Client update — BB-133 Overview page: corrected numbers

**Server:** next push (version chosen at `/push`). **Web** (Overview pages). Mobile: only if the app calls `/api/analytics/employee` (same URL; old fields kept). **Status:** built 2026-11-18; dev after deploy. No database change.

Same URLs and query (`period=this_month|last_month|last_7_days|last_14_days|last_28_days|custom`, `startDate`/`endDate` as `YYYY-MM-DD` for custom). New fields are **added**. Old fields are **kept with corrected values**, so the current screens keep working until you switch. Answers to the questions in the BB-133 draft are at the end.

## Rules now applied on the server
- **Time zone:** every day, time and label uses the company time zone (`Company.timeZone`). A punch belongs to the company-zone date of its clock-in.
- **Range:** ends **today**. Future days never count. `dateRange.end` = the clamped end; `dateRange.periodEnd` = the period's real end (e.g. Nov 30).
- **Hours:** net worked hours (breaks and lunch deducted), the same as Punch Logs. An open punch counts 0.
- **Scheduled:** shifts that aren't cancelled. Overnight shifts end the next day.
- **Late:** first clock-in after the shift start + the company grace period (`gracePeriodMinutes`, default 15).
- **Early out:** last clock-out before the shift end − the company `earlyClockOutGraceMinutes` (default 20). Not judged while a punch is open.
- **Absent:** a scheduled day with no punch that is already over. Approved leave days and company holidays never count as absent.
- **Approved overtime:** cutoff-approved OT (the same number as Punch Logs and payroll).
  - It only exists once a cutoff is reviewed, so the current period may show 0. Suggested caption: "Approved in cutoff review".
  - "Hours beyond schedule" is separate (worked − scheduled, scheduled days only).

## 1. `GET /api/analytics/employee` (own Overview)
```json
{
  "timeZone": "America/Los_Angeles",
  "profile": { "username", "firstName", "lastName", "email", "department" },
  "totals": {
    "hoursWorked", "daysWorked", "scheduledDays", "absences", "lateIns", "earlyOuts",
    "approvedOvertime", "overtimeDays", "hoursBeyondSchedule", "leaveDays",
    "totalHours", "overtime", "activeSessions"
  },
  "patterns": { "usualClockIn": "08:52", "usualClockOut": "17:10", "usualClockInLabel": "8:52 AM", "usualClockOutLabel": "5:10 PM" },
  "averages": { "hoursPerDayWorked", "overtimePerDayWorked", "hoursPerDay", "overtimePerDay" },
  "series": { "daily": [ { "date", "hours", "overtime", "beyondSchedule", "scheduledHours", "status", "lateIn", "earlyOut", "firstIn", "lastOut" } ] },
  "charts": { "dailyHours": [ { "date", "hours" } ] },
  "dateRange": { "start", "end", "periodEnd", "label", "period" }
}
```
- **`series.daily`:** includes absent, leave and holiday days (hours 0), for the attendance strip.
  - `status`: `on_time | late | absent | leave | holiday | unscheduled | scheduled`. `scheduled` = today, shift not over yet.
  - `overtime` = approved OT that day. `firstIn`/`lastOut` are `"HH:mm"` in the company zone. `lastOut` is `null` while a punch is open.
- **`scheduledDays`:** decided scheduled days only (today's unfinished shift isn't counted yet).
- **Old names, new values:** `totalHours` = `hoursWorked`; `overtime` = `hoursBeyondSchedule`; `hoursPerDay`/`overtimePerDay` = per day worked (`overtimePerDay` is now approved OT).
- **Removed:** `hoursPerWeek`, `hoursPerMonth`, `overtimePerWeek`, `overtimePerMonth` (the ×7 / ×30 projections).
- **Format change:** `usualClockIn`/`usualClockOut` are now `"HH:mm"` (24-hour). The old `"h:mm A"` text is in `usualClockInLabel`/`usualClockOutLabel`. **If the current screen prints `usualClockIn` directly, switch it to the `…Label` field.**

## 2. `GET /api/analytics/admin-dashboard`
- **Scope (new):**
  - Admins/superadmins: the whole company.
  - **Supervisors: their department + direct reports** (before: the whole company).
  - `data.scope` = `"company"` | `"team"`. Suggested title for supervisors: "My team".
- **`summary`:** the same names, corrected. New fields: `approvedOvertimeHours`, `hoursBeyondSchedule`, `absences`, `scheduledShifts` (decided scheduled person-days).
  - `totalOvertimeHours` keeps its old meaning (= hours beyond schedule).
  - Rates are percentages of `scheduledShifts`. `reliabilityRate` = on time and not early. `coverageRate` = scheduled days with a punch.
- **`charts.attendanceDaily` (new):** `[{ date, onTime, late, earlyOut, absent }]`.
  - Each person-day is counted once, so the bars stack: late wins over early out.
- **`charts.overtimeTrend[]` and `charts.overtimeByDepartment[]`:** each item has `hours` (old meaning: beyond schedule), plus `approvedHours` and `beyondScheduleHours`.
  - **`cost` is removed** (it was hours × 1.5 × a made-up $15).
- **`charts.leaveByType[].days`:** real approved leave days in the range (was hours ÷ 8). `leaveApprovalRate` counts requests that overlap the range.
- **Buckets:** daily up to 31 days, monthly above, as before. All charts use company-zone dates.
- **New top-level fields:** `timeZone`, and `dateRange.periodEnd`.

## 3. `GET /api/analytics/super-dashboard`
- **Superadmin only at the route now** (it was already refused inside the handler).
- **Days:** in **UTC** (platform view; companies are in different zones). Same periods; the range ends today. `timeZone: "UTC"`.
- **Hours:** net worked hours, as on the company Overview. Leave requests that span the whole range are now counted.
- **`summary.serverUptime` and `summary.avgResponseTime`** are now `null`. They were hard-coded. Hide them, or link to System Admin → Server. `GET /api/analytics/super` `serverUptime` is `null` too.
- `dateRange` adds `periodEnd`.

## 4. Client follow-up
- Read the new fields; the old names still work.
- Employee: attendance strip from `series.daily[].status`, stacked regular/OT bars, clock-in trend from `firstIn`.
- Admin: stacked daily attendance from `charts.attendanceDaily`, approved OT vs beyond schedule.
- Remove the "not approved overtime" caveats. Keep a small note that approved OT appears after cutoff review.
- Switch any direct print of `patterns.usualClockIn/Out` to the `…Label` fields, or format the `"HH:mm"` value.

## Answers to the draft's questions
1. **Absent:** approved leave and company holidays (`Holiday` table) are excluded.
2. **Grace:** company `gracePeriodMinutes` for late, `earlyClockOutGraceMinutes` for early leave.
3. **Overtime:** both. Approved OT is the main number; hours beyond schedule is separate.
4. **Averages:** per day worked only.
5. **OT cost:** dropped.
6. **Superadmin:** UTC.
7. **Supervisors:** team view (department + direct reports) on `/admin-dashboard`. Their own personal Overview stays on `/employee`.
