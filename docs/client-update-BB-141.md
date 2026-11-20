# Client update: BB-141 Face capture (proof of the punch, photos on S3)

**Server version:** next release. **Company web app.** Mobile has its own hand-off (`docs/mobile-update-BB-141.md`). No System Admin changes.

## What it is
A company that uses **Clock-Out Documentation in custom forms mode** can require a **live face photo** taken on the phone as proof of the punch: on every clock-out, and optionally on every clock-in. The photo is stored privately (AWS S3, Oregon) with the punch's location and time. Admins and supervisors see it **only on the cutoff approvals page**, while the punch is not approved yet.

Free-form documentation never asks for a photo.

---

## 1. Company Settings: Clock-Out Documentation section
Two new switches on the existing `GET` / `PATCH /api/company-settings` (admin), shown **under** the Documentation switch:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `taskReportFaceCapture` | boolean | `false` | **Include face capture.** Every clock-out needs a live photo. |
| `taskReportFaceCaptureClockIn` | boolean | `false` | **Also at clock-in.** Every clock-in needs a live photo too. |

```http
PATCH /api/company-settings
{ "taskReportFaceCapture": true, "taskReportFaceCaptureClockIn": false }
```

Rules the server applies (the UI should mirror them):
- Face capture **only applies while** `taskReportEnabled` is `true` **and** `taskReportMode` is `"forms"`. In free-form mode the switches are kept but do nothing. Suggest: show the switches only in forms mode, or disable them with a hint ("Face capture works with custom forms only").
- `taskReportEnabled: false` also sets both face switches to `false`.
- `taskReportFaceCapture: false` also sets `taskReportFaceCaptureClockIn` to `false`.
- "Also at clock-in" is a child of "Include face capture": disable it while face capture is off.

**Reminder text** under the face capture switch (suggested copy):
> ⓘ While face capture is on, employees can't clock in or out on the web. The web shows punches as view only; punching is done in the mobile app.

## 2. Web clock-in / clock-out while face capture applies
The server **refuses** browser clock-in and clock-out for that company:

```http
POST /api/timelogs/time-in   →  403
POST /api/timelogs/time-out  →  403
{ "message": "Clocking in and out on the web is turned off for your company. Please use the mobile app.",
  "code": "WEB_PUNCH_DISABLED" }
```

What the web should do:
- Read `GET /api/company-settings`. When `taskReportEnabled && taskReportMode === "forms" && taskReportFaceCapture`, **hide or disable the Clock In / Clock Out buttons** and show the punch area as **view only** (current status, today's punches), with a note: "Clock in and out from the BizBuddy mobile app."
- Still handle `WEB_PUNCH_DISABLED` (settings can change while the page is open): show the message and refresh the settings.
- BB-142 (separate ticket) will add a general web on/off switch; face capture forces it off.

## 3. Web clock-out with a questionnaire (forms mode, face capture off)
Unchanged from BB-129 phase 2 except: the web clock-out **does not need a photo** and may send JSON:

```http
POST /api/timelogs/time-out
{ "answers": { "<questionId>": "…" }, "localTimestamp": "…", "location": { … } }
```
When the punch has an assigned form, missing `answers` → `400 TASK_REPORT_FORMS_REQUIRED` ("Finish the end-of-shift form before clocking out.").

Saving or submitting a questionnaire later (`PUT /api/task-report-forms/me/punch/:timeLogId`) **no longer needs a photo** either (JSON `{ answers, submit }`).

## 4. Cutoff approvals: face photos
Two new endpoints (admin, supervisor, superadmin; same access as cutoff approvals).

### 4a. Photos of a cutoff period
```http
GET /api/face-photos/cutoff/:cutoffPeriodId[?employeeId=<userId>]
```
```json
{
  "data": {
    "items": [
      {
        "timeLogId": "cmx…",
        "userId": "cmu…",
        "approved": false,
        "in": null,
        "out": {
          "id": "9b2e…",
          "kind": "out",
          "capturedAt": "2026-11-20T01:02:03.000Z",
          "receivedAt": "2026-11-20T01:02:05.120Z",
          "latitude": 38.5816,
          "longitude": -121.4944,
          "accuracy": 12,
          "unavailable": null
        }
      }
    ]
  }
}
```
- One item per punch **that has a photo** (punches without photos are not listed). Match items to approval rows by `timeLogId`.
- `in` / `out` is `null` when that side has no photo.
- `unavailable`: `null` = can be opened; `"approved"` = the punch is approved, so the photo is hidden; `"expired"` = older than 90 days, deleted from storage.
- `capturedAt` is the phone's punch time; `receivedAt` is when the server got it. Coordinates are the punch's location at that moment.

Call it once when the cutoff approvals page loads (and after approve / reset actions) instead of per row.

### 4b. Open a photo
```http
GET /api/face-photos/:id/url
```
```json
{ "data": { "url": "https://bizbuddy-face-photos-prod-or.s3.us-west-2.amazonaws.com/face-photos/…jpg?X-Amz-…", "expiresAt": "2026-11-20T01:07:03.000Z" } }
```
- Use `url` directly as `<img src>` (no auth header needed, no CORS needed for an `<img>`). It **expires after 5 minutes**: fetch a new one each time the viewer opens; don't store it.
- Errors: `403 FACE_PHOTO_HIDDEN` (punch approved), `410 FACE_PHOTO_EXPIRED` (older than 90 days), `404` (not found / other company), `503 FACE_PHOTO_UNAVAILABLE`.

### Suggested UI
- On each approval row that has a photo: a small camera icon for **In** and/or **Out**. Click → modal with the photo (~480 px), the time (company time zone), and the coordinates (link to a map, or a pin on the Employee Map).
- When `unavailable` is `"approved"`: grey icon, tooltip "Hidden after approval". If the approval is **reset to pending**, the photo becomes viewable again: refresh the list after a reset.
- Driver/Aide punches have one photo per clock-in/clock-out (not per segment); it is hidden once **all** segments are approved.

## Summary of changes for the web
| Area | Change |
|---|---|
| Company Settings → Clock-Out Documentation | 2 new switches + reminder text |
| Punch / Dashboard clock buttons | view only while face capture applies; handle `WEB_PUNCH_DISABLED` |
| Web clock-out with a form | no photo needed; JSON `answers` is fine |
| Questionnaire save/submit | no photo needed |
| Cutoff approvals | load `/api/face-photos/cutoff/:id`, camera icons, viewer via `/api/face-photos/:id/url` |
