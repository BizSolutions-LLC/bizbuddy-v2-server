# Client update — BB-129 phase 2: Assign custom forms + answer them after clock-out

**Server:** next push (version chosen at `/push`). **Web and mobile** (same endpoints). **Status (2026-11-18): available in the dev environment and for local testing**, including the PDF (section 10). The database script and `prisma generate` are done. Production follows the next push and deploy. Phase 1 (`docs/client-update-BB-129-forms.md`) must already be in.

## What changes
- **Modes are exclusive** (radio, not checkboxes):
  - **Free-form**: the daily task report only. No questionnaires.
  - **Custom forms**: questionnaires only. Writing a free-form report is refused (`403 TASK_REPORT_MODE_FORMS`).
  - Everything already submitted stays visible on the Employee Report page in both modes.
- Admins **assign** forms to: everyone, a department, an employee, or a shift.
- After clock-out, the employee gets the punch's questionnaire as a **pop-up**, or answers later from an **"Answer questionnaire"** icon.
- **Answer window:** a company setting (default 14 days). When it ends, the questionnaire locks: a draft becomes **Incomplete**, kept as it is.
- **Submit locks** the answers.

> Replaces the phase 1 note: free-form no longer keeps working in Custom forms mode. Hide the free-form report icon/editor when `mode === "forms"`.

## 1. Settings (Trial Features card)
- `GET /api/company-settings` → `data.taskReportFormWindowHours` (integer, default `336` = 14 days).
- `PATCH /api/company-settings` `{ "taskReportFormWindowHours": 72 }` (admin only). Whole hours, 1–2160 (90 days). Otherwise `400 { error }`.
- Suggested: show it under "Custom forms" as "Time to answer after clock-out" with presets (24 h, 3 days, 7 days, 14 days) or a days/hours input. The server stores hours.

## 2. Assignments (admin, on the Forms page)
Which form a punch gets, most specific first: **shift → employee → department → all**. No match → no questionnaire. Archived forms are skipped (the next scope applies) but their assignments are kept for when the form is restored.

| Action | Request | Response |
|---|---|---|
| List | `GET /api/task-report-forms/assignments` | `data[]`, `scopes[]` |
| Assign / replace | `PUT /api/task-report-forms/assignments` `{ scope, targetId?, formId }` | `data` |
| Remove | `DELETE /api/task-report-forms/assignments/:id` | `data: { id }` |

- `scope`: `"all"` (no `targetId`) | `"department"` | `"employee"` (user id) | `"shift"` (Shift id from the shift catalog).
- One form per target: assigning again replaces the form.
- Assignment row: `{ id, scope, target: { id, name, missing } | null, form: { id, name, status }, formArchived, createdAt, updatedAt }`. `missing: true` = the department/employee/shift no longer exists (show it so the admin can remove it). `formArchived: true` = currently skipped.
- Opening one form (`GET /api/task-report-forms/:id`) now also returns `assignments[]` (same rows without `form`), `responseCount` and `canDelete`.
- Delete is refused once a form has answers: `409 FORM_HAS_RESPONSES` → offer **Archive**.
- Errors: `INVALID_ASSIGNMENT` (400), `TARGET_NOT_FOUND` (404), `FORM_NOT_FOUND` (404), `FORM_ARCHIVED` (409, restore first), `ASSIGNMENT_NOT_FOUND` (404).

## 3. Clock-out pop-up (web + mobile)
`POST /api/timelogs/time-out` now returns one more top-level field:

```json
{ "message": "...", "data": { ...timeLog }, "taskReportForm": { "timeLogId": "...", "form": { "id": "...", "name": "John Doe care form" }, "shiftName": "John Doe", "closesAt": "..." } }
```

- `taskReportForm` is `null` when there's nothing to answer (mode is free-form, the setting is off, or no form applies).
- When it's set, open the questionnaire for `timeLogId` (section 5). The employee may close it and answer later.
- Added field only: app builds that don't know it simply ignore it.

## 4. "Answer questionnaire" icon (web + mobile)
`GET /api/task-report-forms/me/pending` → `data = { enabled, windowHours, timeZone, items[] }`.
- `items[]`: `{ timeLogId, timeIn, timeOut, closesAt, form: { id, name }, shiftName, assignedVia, response: { id, status: "draft", answeredCount } | null }`, newest clock-out first.
- Includes punches with no answers yet and saved drafts, inside the window. Submitted and closed ones drop off.
- Show a badge with `items.length`. Hide the icon when `enabled` is false. Auto clock-outs and later-added punches appear here (no pop-up for them).
- Suggested: show "closes {closesAt}" per item.

## 5. Answering one punch (web + mobile)
- **Open:** `GET /api/task-report-forms/me/punch/:timeLogId` → `data = { enabled, timeZone, punch: { timeLogId, timeIn, timeOut }, canEdit, response, form: { id, name, description, questions[] }, shiftName, closesAt }`.
  - `response` is `null` until the first save, then `{ id, status, answers, answeredCount, questionCount, submittedAt, ... }`.
  - `canEdit: false` → read-only (submitted, incomplete, or questionnaires turned off).
- **Save draft:** `PUT /api/task-report-forms/me/punch/:timeLogId` `{ "answers": { ... }, "submit": false }`.
- **Submit:** the same with `"submit": true`. It locks the answers. Required questions are checked only on submit.
- The form is fixed at the first save. Later edits to the form or its assignments don't change a started questionnaire.
- `answers` = `{ [questionId]: value }`. Leave out (or send empty) unanswered questions.

| `type` | Value |
|---|---|
| `short_text` | string, ≤ 500 |
| `paragraph` | string, ≤ 5000 |
| `single_choice`, `dropdown` | one option string, exactly as listed |
| `checkboxes` | array of option strings |
| `yes_no` | `true` / `false` |
| `number` | number |
| `date` | `"YYYY-MM-DD"` |
| `time` | `"HH:mm"` (24-hour) |

- Errors: `PUNCH_NOT_FOUND` (404), `STILL_CLOCKED_IN` (409), `NO_FORM` (404), `TASK_REPORT_FORMS_OFF` (403), `RESPONSE_LOCKED` (409, already submitted), `RESPONSE_CLOSED` (409, window passed), `RESPONSE_CONFLICT` (409, saved from another tab/device: reload), `INVALID_ANSWER` (400), `REQUIRED_ANSWER` (400). Show `message`; it names the question.

## 6. Employee's own history (web + mobile)
`GET /api/task-report-forms/me/responses?from=YYYY-MM-DD&to=YYYY-MM-DD` (default last 30 days, max 93) → `data.responses[]`: `{ id, timeLogId, punchDate, status: "draft"|"submitted"|"incomplete", form: { id, name }, answeredCount, questionCount, shiftName, closesAt, submittedAt, punch: { timeIn, timeOut } }`. Open one with section 7.

## 7. Viewing one answer set
`GET /api/task-report-forms/responses/:id` → the response with `form.questions`, `answers`, `status`, `punch`, `shiftName`, `employee { id, name, employeeId, jobTitle, department }`, `timeZone`, `isOwner`, `canEdit`.
- Owner: any status. Supervisor (department + direct reports) and admin: **submitted and incomplete only**, view only. Others/drafts → 404.

## 8. Employee Report page (supervisor/admin)
Free-form reports and questionnaires in one list:
- `GET /api/task-reports/team?from=&to=&userId=&departmentId=&include=forms`
- Every row now has `kind`. Free-form rows: `kind: "freeform"` (unchanged otherwise; open with `GET /api/task-reports/:id`). Questionnaire rows: `kind: "form"`, `{ id, reportDate, status: "submitted"|"incomplete", formName, shiftName, answeredCount, questionCount, timeLogId, punch, submittedAt, closesAt, employee }`. Open with `GET /api/task-report-forms/responses/:id`.
- Without `include=forms` the list is exactly as before (free-form only).
- Suggested: a type column ("Daily tasks" / form name), and an **Incomplete** badge.
- The response also has `mode`.

## 9. Free-form screens in Custom forms mode
- `GET /api/task-reports/me/:date` now returns `mode`; `canEdit` is `false` when `mode === "forms"`.
- `PUT /api/task-reports/me/:date` → `403 TASK_REPORT_MODE_FORMS` in Custom forms mode.

## 10. PDF: View and Download (submitted only)
`GET /api/task-report-forms/responses/:id/pdf`
- Default: file download (`Content-Disposition: attachment`). **Download PDF** button.
- `?disposition=inline`: shown in the browser. **View PDF** button (open in a new tab or a PDF viewer).
- Same access as section 7: the owner, plus supervisors (in scope) and admins.
- Only when `status === "submitted"`. Otherwise `409 NOT_SUBMITTED` (drafts and Incomplete have no PDF). Show the buttons only for submitted rows.
- The PDF matches the Daily Task Report layout:
  - form name and punch date
  - company, employee, department, shift, submitted time
  - clock-in and clock-out, answered count
  - numbered questions with answers (`*` = required, "Not answered" for blanks)
  - a "Submitted by" block.
- Places to add the buttons: the employee's history and answered view (sections 6–7), and the Employee Report page rows with `kind: "form"` (section 8).
- The request needs the auth header, so fetch it as a blob and open or save the blob, as the existing Daily Task Report PDF does.

## Mobile (for the mobile developer)
Needed:
- section 3 (pop-up after clock-out)
- section 4 (icon + list)
- section 5 (answer screen, all 9 types)
- section 6 (history)
- section 7 (view one)
- section 10 (PDF, optional on mobile)

Not needed: settings, assignments, the Employee Report page. Show times in the response's `timeZone` (company zone).

## Notes
- B. Buddy can't answer (`/me…` is blocked); as an admin it can view.
