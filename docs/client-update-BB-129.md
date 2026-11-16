# Client update — BB-129 Clock-out documentation (Daily Task Report), trial

**Server:** v2.11.13. **Web only** (mobile: no change). **Status:** server first. Build this once the server is deployed.

## What it is
An optional daily report where the employee lists the work they did, one report per day. It is a trial: there is no deadline, and past days with a punch can be documented too. The PDF exists only after the employee submits. Supervisors and admins can view submitted reports only.

## 1. Configurations: a new switch
- `GET /api/company-settings` → `data.taskReportEnabled` (boolean, default `false`).
- `PATCH /api/company-settings` `{ "taskReportEnabled": true|false }` (admin only).
- Suggested label: **"Clock-out documentation (trial)"**. Help text: "Employees can list the tasks they did each day. Optional; no deadline during the trial."

## 2. Employee punch logs: edit icon per day
- When the setting is on, show an edit (document) icon on each punch row. Every punch on the same day opens the **same** report, because reports are per day (the day of the clock-in, in the company zone).
- To mark the icons: `GET /api/task-reports/me?from=YYYY-MM-DD&to=YYYY-MM-DD` → `data.reports[]` with `{ reportDate, status: "draft"|"submitted", taskCount, submittedAt }`. Range max 93 days. Suggested icon states: none / draft / submitted.

## 3. The form (no template preview)
- Open: `GET /api/task-reports/me/:date` → `data = { enabled, canEdit, timeZone, reportDate, attendance: { punchCount, clockIn, clockOut, stillClockedIn, shift: { name, start, end } | null }, report: { id, status, tasks: [{ title, note }], submittedAt, ... } | null }`.
- Show only the input form: a list of tasks, each with a **title** (required, ≤ 200 characters) and a **note** (optional, ≤ 1000), with add, remove and reorder; at most 50 tasks. Don't show the PDF layout here.
- Buttons: **Save draft** → `PUT /api/task-reports/me/:date` `{ tasks, submit: false }`; **Submit** → the same with `submit: true` (needs at least 1 task).
- After the first submit there is no draft state any more: the button is just **Save** and every save re-submits. Send `submit: true`; the server keeps it submitted either way.
- `canEdit: false` → read-only, with the reason: the setting is off, or there is no punch that day.
- Errors are `{ message, code? }`. Show `message`. Codes: `TASK_REPORT_DISABLED` (403), `NO_PUNCH` (400), `NOT_SUBMITTED` (409, PDF only).

## 4. PDF (after submit only)
- Employee: `GET /api/task-reports/me/:date/pdf`. Supervisor/admin: `GET /api/task-reports/:id/pdf`. Both return a file download (`application/pdf`, filename in `Content-Disposition`).
- Show the download / view button only when `status === "submitted"`.

## 5. Supervisor / admin view (read-only)
- List: `GET /api/task-reports/team?from=&to=&userId=&departmentId=` → `data.reports[]` with `{ id, reportDate, taskCount, submittedAt, employee: { id, name, employeeId, department } }`. Submitted only. Supervisors get their department + direct reports; admins get the whole company. Employees get 403.
- One report: `GET /api/task-reports/:id` → tasks, `employee` (name, jobTitle, department), `attendance`, `timeZone`. No edit controls.
- Where to put it is up to the client: a "Task Reports" tab or an icon on the team punch logs.

## Notes
- Show every time in the response's `timeZone` (the company zone), not the browser's.
- B. Buddy can't write reports (`/me…` is blocked) but can view the team list as an admin.
- Not in this version: a deadline, mobile support, and a prompt at clock-out.
