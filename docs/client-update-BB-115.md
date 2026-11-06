# Server reply — BB-115 "Set up your business" guide

**For:** bizbuddy-v2-client-web (admin panel, left side)
**Server:** v2.11.4 (new endpoints, additive; needs the `Company.setupGuide` column, see the changelog).

## The idea
A new company starts as a blank canvas: no departments, no employees, no shifts or schedules. On their own, a new owner or HR admin doesn't know where to start or what order things go in, and an empty system doesn't show what BizBuddy can do.

BB-115 adds a **setup guide**: a checklist on the left side of the admin panel that walks them through setup in the right order. It shows what each step is for and links straight to the page where it's done. Most steps **tick themselves off**: when the admin creates their first department, the "Departments" step turns done the next time the guide is loaded. Nobody ticks boxes by hand, and the guide stays accurate whether the setup was done on web, on mobile or by BizBuddy support (B. Buddy).

Who sees it: **admin and superadmin** (owner, HR/admin, B. Buddy). Supervisors and employees don't (the API returns 403).

## Endpoints
All need `Authorization: Bearer <token>` and always apply to the caller's own company. Every response is `{ data: <Checklist> }`. The actions return the **updated** checklist, so just re-render with it.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/company-setup/checklist` | Current checklist |
| POST | `/api/company-setup/checklist/steps/:key/skip` | Skip an optional step (`canSkip: true` only) |
| DELETE | `/api/company-setup/checklist/steps/:key/skip` | Undo skip |
| POST | `/api/company-setup/checklist/steps/:key/review` | Mark a review step reviewed (`canReview: true` only) |
| DELETE | `/api/company-setup/checklist/steps/:key/review` | Undo reviewed |
| POST | `/api/company-setup/checklist/dismiss` | Hide the guide |
| POST | `/api/company-setup/checklist/reopen` | Show it again |

Errors: JSON `{ message }`. `400` (step can't be skipped/reviewed) · `403` (not admin) · `404` (unknown step) · `500`.

## Response shape
```json
{
  "data": {
    "companyId": "cm…",
    "progress": { "done": 5, "total": 15, "percent": 33, "requiredDone": 4, "requiredTotal": 9 },
    "isComplete": false,
    "allFinished": false,
    "nextStepKey": "shifts",
    "dismissed": false,
    "dismissedAt": null,
    "steps": [
      {
        "key": "employee_details",
        "title": "Assign employees to departments",
        "description": "Give every employee a department and hire date. Hire dates drive leave eligibility and anniversaries.",
        "required": true,
        "kind": "auto",
        "page": "employees",
        "dependsOn": ["departments", "employees"],
        "blockedBy": [],
        "status": "todo",
        "progress": { "current": 3, "target": 5 },
        "detail": "2 employee(s) missing a department or hire date",
        "canSkip": false,
        "canReview": false
      }
    ]
  }
}
```

Field notes:
- `status`: `todo` | `done` (auto, detected) | `reviewed` (review step marked by admin) | `skipped`.
- `kind`: `auto` steps complete themselves. `review` steps complete only when the admin clicks **Mark reviewed**, because their settings already have defaults.
- `progress`: for "3 of 5" text or a mini bar. It's `null` on review steps. `current` never exceeds `target`, so 46 employees on a "at least 1" step shows as 1/1.
- `detail`: a short hint of what's missing, only while the step is `todo`. Show it under the title.
- `blockedBy`: unfinished steps this one depends on. Show the step greyed out with "Do *X* first", but still let them open it.
- `nextStepKey`: the step to highlight or expand ("Up next").
- `isComplete`: every **required** step is finished. `allFinished`: every step is done, reviewed or skipped.
- The steps' `title` / `description` text comes from the server. Use it as-is so wording changes need no client release.

## Steps and where they link (`page` → client route)
Map `page` to your own routes. Keys are stable.

| Order | `key` | Required | `kind` | `page` | Suggested route |
|---|---|---|---|---|---|
| 1 | `company_profile` | ✔ | auto | `company_profile` | Company Settings → Company Info |
| 2 | `departments` | ✔ | auto | `departments` | Departments |
| 3 | `locations` | | auto | `locations` | Locations |
| 4 | `employees` | ✔ | auto | `employees` | Employees → Add |
| 5 | `employee_details` | ✔ | auto | `employees` | Employees list |
| 6 | `supervisors` | | auto | `departments` | Departments |
| 7 | `shifts` | ✔ | auto | `shifts` | Shifts |
| 8 | `schedules` | ✔ | auto | `schedules` | Schedules |
| 9 | `cutoff` | ✔ | auto | `cutoff_settings` | Cutoff / Pay period settings |
| 10 | `department_cutoffs` | ✔ | auto | `cutoff_periods` | `/dashboard/company/cutoff-periods` |
| 11 | `attendance_rules` | | review | `attendance_settings` | Company Settings → Attendance (grace, OT, breaks, auto clock-out) |
| 12 | `leave_policies` | | auto | `leave_policies` | Leave Settings → Leave types |
| 13 | `leave_settings` | | review | `leave_settings` | Leave Settings → Credits |
| 14 | `holidays` | | auto | `holidays` | Holidays |
| 15 | `payroll` | | auto | `payroll_settings` | Payroll settings / employee payroll details |

**Client action for `department_cutoffs`:** `cutoff_periods` is a new `page` value. Add it to `components/Dashboard/SetupGuide/setupRoutes.js`, mapped to `/dashboard/company/cutoff-periods`, so **Go** opens that page.

`department_cutoffs` is done when every department has active cutoff settings and at least one generated period. `progress` counts departments, e.g. 2 of 5. 

**`cutoff` only appears when the company's `otBasis` is `"cutoff"`.** It reflects only the company settings in Company Configurations, which are used for cutoff-based overtime. On daily or weekly OT the server leaves the step out of `steps`, so `total` is 14 and `requiredTotal` is 8 (15 and 9 on cutoff). Render the `steps` the server sends and don't assume a fixed count. Numbers in the table above are for a company on cutoff OT.

## Suggested UI
**Left panel card "Set up your business"**
- Header: title, a progress bar from `progress.percent`, and "**{done} of {total}** steps · {requiredDone}/{requiredTotal} required".
- Step list in server order. Each row shows:
  - an icon by status: ✓ done/reviewed, ⤼ skipped (muted), ○ todo, lock-tinted when `blockedBy` isn't empty
  - the `title`, a "Required" tag when `required`, and `progress` as "3/5" when present
  - when expanded (the `nextStepKey` row starts expanded): the `description`, the `detail` hint, and the buttons:
    - **Go** → navigate to the `page` route
    - **Mark reviewed** (when `canReview` and not reviewed) / **Undo**
    - **Skip** (when `canSkip` and `todo`) / **Undo skip**
- Footer: **Hide guide** → `POST …/dismiss`.

**Showing / hiding**
- Show the panel when `!dismissed && !allFinished`.
- When dismissed (or all finished), keep a small "Setup guide (33%)" entry in the sidebar or settings that calls `…/reopen`.
- When `isComplete` first becomes true, show a short "You're all set 🎉" state. Optional steps can stay listed until finished or dismissed.

**Refreshing**
- Fetch on panel mount and when the window regains focus. Also re-fetch after the user comes back from a step's page; there are no socket events for it. The endpoint is light (one round of counts).

## Suggested intro text (panel header / first-time tooltip)
> **Welcome to BizBuddy!** Let's get your business ready. Follow these steps to set up your departments, people, schedules and pay periods. Each step checks itself off as you go, and you can come back to this guide anytime.
