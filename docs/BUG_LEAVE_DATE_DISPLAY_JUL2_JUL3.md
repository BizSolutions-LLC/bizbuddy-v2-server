# Client-Side Handoff — Leave Date Display Bug (Jul 3 shown as Jul 2)

> Prepared for whoever owns `CutoffReview.jsx` / the Cutoff Review frontend. Server-side investigation is complete and conclusive: **the API is correct, the screen is not.**

## Summary

Leave request `cmrcalddl1fjwvh50sbju86qq` (Jhenelle Villanueva, single-day Sick Leave, Fri Jul 3, 2026) was reported as displaying on **Jul 2** in Cutoff Review — attached to Jul 2's punch card, with Jul 3 showing "Absent — No punch record."

This has been fully traced server-side. The underlying `Leave.startDate`/`endDate` are correctly `2026-07-03`, and the `GET /api/cutoff-periods/:id/approvals` endpoint returns the correct date. The discrepancy is not reproducible from the API — it must be in how the client consumes or caches this response.

## Proof: raw API response (captured live from the Cutoff Review network request)

```json
"leaves": [
  {
    "_type": "leave",
    "id": "leave_cmrcalddl1fjwvh50sbju86qq_2026-07-03",
    "leaveDate": "2026-07-03",
    "leave": {
      "id": "cmrcalddl1fjwvh50sbju86qq",
      "leaveType": "Sick Leave",
      "startDate": "2026-07-03T19:00:00.000Z",
      "endDate": "2026-07-03T19:00:00.000Z",
      "status": "approved",
      "isPaid": true
    }
  }
]
```

- `leaveDate` is `"2026-07-03"` — not `"2026-07-02"`.
- The `data` array (punches) in the same response has no entry for this user on Jul 3 — her punches jump from Jul 2 straight to Jul 6, confirming there's genuinely no punch that day (she was on leave) and the leave block should stand alone on Jul 3.

## What to check on the client

1. **Stale cache** — is the SPA's data layer (React Query/SWR/Redux/etc.) serving a cached response from before this leave's date was corrected server-side, instead of the fresh payload above? A hard reload should force a refetch; if the screen still shows Jul 2 after that, it's not a cache issue.
2. **Matching logic** — how does `CutoffReview.jsx` iterate the `leaves[]` array and place each entry on a day? If it matches by array position/index rather than by the `leaveDate` field, or does any date arithmetic of its own instead of using `leaveDate` directly, that would explain correct data rendering on the wrong day.
3. Per the original bug report, the client's date rendering itself (`new Date(leaveRow.leaveDate + "T00:00:00")`, formatted with `timeZone: tz`) was already confirmed to just reflect whatever `leaveDate` the server sends — so the bug is upstream of that formatting call, in whatever selects which day's list this leave gets pushed into.

## Related fix shipped alongside this (server-side, already on this branch)

The `leaves[]` entry now includes a real `hours` field — `5.5` for this leave — computed from the employee's actual scheduled shift for that day (same calculation used for leave-approval proration). Previously there was no hours data in the payload at all, which is why the client was hardcoding `8h` on the Sick Leave card. **The client needs to start reading `leaves[].hours` instead of hardcoding a default** for the displayed hours to be correct going forward.

## Root cause class (for awareness, not blocking on this ticket)

The server-side date drift this report was chasing turned out to be a red herring by the time of investigation — the DB was already corrected before this session started. But investigating it surfaced a real, separate bug pattern: several places converted a plain "calendar date" DB column (`@db.Date`, no time/timezone) through `moment(x).tz(companyTz)`, which reinterprets it as a precise instant and rolls it back a day in negative-UTC-offset zones like `America/Los_Angeles`. Two live instances of this were found and fixed on the server (`Holiday.date` and `UserShift.assignedDate`, both inside `leaveUtils.js`'s `calcDailyHours()`) — the second one was silently causing shift-worker leave-hour proration to undercount to zero hours for the affected day. A third instance remains open in `src/jobs/sendEveningReport.js:83`, not yet fixed (out of scope for this ticket, flagged for follow-up).
