# Server reply — BB-106 Leave Report (template workbook)

**For:** bizbuddy-v2-client-web (Company Settings → Leave Settings → **Leave Report** button)
**Server:** v2.11.4 (new endpoint, additive). The existing `GET /api/reports/leave?type=…` JSON reports are unchanged.

## What changed
The Leave Report is now built on the server as an `.xlsx` in the layout of `docs/LeaveReport_Template.csv`. The client only sends the filters and downloads the file. It doesn't build rows or columns.

## Endpoint
```
GET /api/reports/leave/template
Authorization: Bearer <token>
Roles: admin, superadmin (whole company) · supervisor (own department only)
```

| Param | Required | Values | Default |
|---|---|---|---|
| `year` | no | e.g. `2026` | current year (company timezone) |
| `quarters` | no | comma list of `Q1,Q2,Q3,Q4` | whole year |
| `months` | no | comma list of `Jan,Feb,…,Dec` | whole year |
| `policyIds` | no | comma list of LeavePolicy ids (leave types) | all types |
| `departmentId` | no | department id | all (supervisor: forced to own) |
| `userIds` | no | comma list of user ids | all |
| `includeInactive` | no | `true` | `false` |

Send **either** `quarters` **or** `months`, not both (400 if both are sent).

**Success:** `200`, body is the workbook. Headers:
- `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `Content-Disposition: attachment; filename="Leave_Report_<Company>_<year>[_Q1-Q2].xlsx"`

**Errors:** JSON `{ message }`. `400` bad params · `403` outside your scope · `404` company · `500`.
Because a failed request returns JSON instead of a file, request with `responseType: "blob"`. If the status isn't 200, read the blob as text and show `message`.

```js
const res = await api.get("/reports/leave/template", {
  params: { year, quarters: quarters.join(",") || undefined, months: months.join(",") || undefined,
            policyIds: policyIds.join(",") || undefined, departmentId, includeInactive },
  responseType: "blob",
});
// filename from Content-Disposition, then trigger download (same as the yearly hours report)
```

> The server already exposes `Content-Disposition` through CORS (`app.js`), so the filename can be read from it.

## Suggested UI (the "Generate Leave Report" modal)
- **Year**: select (current year by default).
- **Range**: `Whole year` | `Quarters` (Q1–Q4 multi-select) | `Months` (Jan–Dec multi-select).
- **Leave types**: multi-select from the company's leave policies (default all). Each type becomes one sheet.
- **Department**: admins only. Supervisors don't see it, because the server scopes them.
- **Include inactive employees**: checkbox.
- **Generate** button → downloads the file.

## What the workbook contains (for help text)
One sheet per leave type, one row per employee:
`# | NAME | DOH | Beginning Balance <Y-1> | Total Used <Y-1> | Balance <Y-1> | Credits <Y> | Beginning Balance <Y> | one column per pay date (grouped by month) | Total Used <Y> | Balance <Y> | Beginning Balance <Y+1>`, plus a **TOTAL HOURS** row.
- Pay-date columns are cutoff payment dates. A leave day counts under the cutoff that contains it.
- Beginning Balance <Y+1> = Balance <Y> + next year's automatic grant, when grants are on.
- With quarters/months selected, only those pay dates are shown. Balance <Y> is the balance as of the end of the last selected cutoff.
