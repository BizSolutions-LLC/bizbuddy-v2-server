# Client update — BB-129 phase 1: Clock-out documentation mode + custom forms

**Server:** next push (version chosen at `/push`). **Web only** (mobile: no change in phase 1). **Status (2026-11-17): available in the dev environment and for local testing.** The database script and `prisma generate` are done. Build and test against dev or local now; production follows the next push and deploy.

## What it is
Clock-out documentation now has two kinds:
- **Free-form:** today's Daily Task Report (task list per day). Unchanged.
- **Custom forms:** questionnaires the admin builds, like Google Forms.

Phase 1 is only the **mode setting** and the **form builder**. Employees don't answer custom forms yet. Assigning forms to shifts, the pop-up after clock-out, answering, review and PDF come in later phases.

**Important:** while the mode is "Custom forms", the free-form Daily Task Report keeps working exactly as today. Employees still see the report icon in their Punch logs, and supervisors and admins still get the Employee Report page. Don't hide them based on the mode yet.

## 1. Trial Features card: mode choice
- `GET /api/company-settings` → `data.taskReportMode`: `"freeform"` (default) | `"forms"`.
- `PATCH /api/company-settings` `{ "taskReportMode": "freeform" | "forms" }` (admin only). Any other value → `400 { error }`. Note: this endpoint returns `error`, not `message`.
- Show the choice only when the "Clock-out documentation (trial)" switch is on, styled like the Cutoff Page cards:
  - **Free-form**: "Employees list the tasks they did each day."
  - **Custom forms (preview)**: "Build questionnaires for employees to answer after a shift. Answering is coming soon; free-form stays on until then."
- When the mode is `"forms"`, show a link or button to the **Forms** page (section 2).

## 2. Forms page (admin only)
All endpoints are under `/api/task-report-forms`, for admin/superadmin only. Supervisors and employees get `403 { message }`. Hide the page for them.

| Action | Request | Response |
|---|---|---|
| List | `GET /?status=active\|archived\|all` (default `active`) | `data[]` (no questions), `questionTypes[]` |
| Open | `GET /:id` | `data` (with `questions`) |
| Create | `POST /` `{ name, description?, questions }` | `201`, `data` |
| Save | `PATCH /:id` `{ name?, description?, questions? }` | `data` |
| Duplicate | `POST /:id/duplicate` `{ name? }` | `201`, `data` (the copy, active) |
| Archive | `POST /:id/archive` | `data` |
| Restore | `POST /:id/restore` | `data` |
| Delete | `DELETE /:id` | `data: { id }` |

**Form object:** `{ id, name, description, status: "active"|"archived", questionCount, requiredCount, questions?, archivedAt, createdAt, updatedAt, createdBy: { id, name } | null, updatedBy: { id, name } | null }`.

**Question object:** `{ id, type, label, helpText, required, options }`.

| `type` | Suggested label | `options` |
|---|---|---|
| `short_text` | Short answer | `[]` |
| `paragraph` | Paragraph | `[]` |
| `single_choice` | Multiple choice (one answer) | required, ≥ 1 |
| `checkboxes` | Checkboxes | required, ≥ 1 |
| `dropdown` | Dropdown | required, ≥ 1 |
| `yes_no` | Yes / No | `[]` |
| `number` | Number | `[]` |
| `date` | Date | `[]` |
| `time` | Time | `[]` |

## 3. Builder rules (the server checks all of these)
- **Name:** required, ≤ 120 characters. It must be unique among the company's **active** forms (case-insensitive), otherwise `409 FORM_NAME_TAKEN`.
- **Description:** optional, ≤ 1000 characters.
- **Questions:** 1 to 100.
  - Question text is required, ≤ 300 characters. Help text is optional, ≤ 500.
  - Choice types need 1 to 50 options. Each option is ≤ 200 characters, not empty, no duplicates (case-insensitive).
  - Options sent for non-choice types are dropped.
- **Question order** = array order. Reordering = send the list in the new order.
- **Question `id`:** keep the `id` the server returns and send it back on save. It stays stable so later answers can point at it. New questions can be sent without an `id` (or with a temporary one of letters, digits, `_` or `-`, ≤ 40); the server assigns one. Always use the `questions` from the response after saving.
- **Archived forms can't be edited** (`409 FORM_ARCHIVED`). Show them read-only with **Restore** and **Duplicate**.
  - Restore fails with `409 FORM_NAME_TAKEN` if an active form has the same name. Ask the admin to rename that form or duplicate this one.
- **Duplicate** without a name becomes "Copy of X" (then "Copy of X (2)", …).
- **Delete** is allowed for every form in phase 1, since nothing has answers yet. Ask for confirmation. Once answering ships, forms with answers can only be archived.
- **Preview:** client-only (render the questions as an employee would see them). Nothing is saved.
- **Errors:** `{ message, code? }`. Show `message`. Codes: `INVALID_FORM` (400), `INVALID_QUERY` (400), `NOTHING_TO_UPDATE` (400), `FORM_NOT_FOUND` (404), `FORM_NAME_TAKEN` (409), `FORM_ARCHIVED` (409).

## Notes
- Forms can be built whatever the mode is. The server doesn't block it, so admins can prepare forms before switching.
- Not in this phase: assigning a form to a shift, the pop-up after clock-out, the "Answer questionnaire" icon, answering, supervisor/admin review, PDF, mobile. These change the clock-out response later; a separate hand-off will follow.
