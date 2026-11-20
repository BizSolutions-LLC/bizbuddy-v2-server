# Mobile update: BB-141 Face capture on clock-in / clock-out (photos on S3)

**Server version:** next release. Replaces how the face photo worked in the custom-forms questionnaire (PRs #129/#130): the photo now belongs to the **punch**, not to the questionnaire.

## What changed on the server
- The face photo is **proof of the punch**. It is required by **company settings**, not by whether a form is assigned:
  - **Clock-out:** required when face capture applies.
  - **Clock-in:** required when face capture applies **and** "also at clock-in" is on.
- **Face capture applies** only when all three are true (read from `GET /api/company-settings`):
  ```
  taskReportEnabled === true
  taskReportMode === "forms"
  taskReportFaceCapture === true
  ```
  Clock-in also needs `taskReportFaceCaptureClockIn === true`. Free-form documentation never needs a photo.
- The server resizes the photo (≤ 480 px JPEG, metadata removed) and stores it privately in S3 with the punch's location and time. **Nothing changes in how you send it.**
- The questionnaire (`PUT /api/task-report-forms/me/punch/:timeLogId`) **no longer needs or stores a photo**. If the app still sends `facePhoto` there, it is ignored.

## 1. Read the settings
`GET /api/company-settings` (already used for breadcrumbs) now also returns:
```json
{ "taskReportEnabled": true, "taskReportMode": "forms",
  "taskReportFaceCapture": true, "taskReportFaceCaptureClockIn": false }
```
Refresh it at sign-in, app start and before each punch (settings can change during the day).

## 2. Clock-in with a photo (when required)
`POST /api/timelogs/time-in` as **multipart/form-data**:

| Field | Value |
|---|---|
| `facePhoto` | the image file (JPEG or PNG, ≤ 5 MB) |
| `localTimestamp` | ISO string, as today |
| `location` | JSON string, e.g. `{"latitude":38.58,"longitude":-121.49,"accuracy":12}` |
| `deviceInfo` | JSON string, as today |
| `deviceId` | as today (BB-134) |
| `punchType`, `reason`, `remarks` | as today (`remarks` as a JSON string) |

When no photo is required, keep sending JSON exactly as today.

Response `201`: same as today plus `data.facePhotoId` (string, or `null` when no photo was taken).

## 3. Clock-out with a photo (when required)
`POST /api/timelogs/time-out` as **multipart/form-data**, same fields as clock-in plus, when the punch has a questionnaire, `answers` (JSON string). This is the same request the app already builds for the questionnaire; the difference is that the **photo is now required on every clock-out while face capture applies**, even when no form is assigned to the punch.

Response `200`: same as today plus `data.facePhotoId`.

## 4. Errors to handle
| Status | `code` | When | App behaviour |
|---|---|---|---|
| 400 | `FACE_PHOTO_REQUIRED` | photo missing, not JPEG/PNG, over 5 MB, or unreadable | open the camera again |
| 400 | `TASK_REPORT_FORMS_REQUIRED` | the punch has a form and `answers` is missing | show the form |
| 502 | `FACE_PHOTO_UPLOAD_FAILED` | the photo couldn't be stored | keep the photo, let the user retry; the punch was **not** saved |
| 503 | `FACE_PHOTO_UNAVAILABLE` | photo storage isn't available | retry later; the punch was **not** saved |
| 403 | `WEB_PUNCH_DISABLED` | only for browsers; the app should never see it | — |

A punch is never saved without its required photo, so after 502/503 the employee is still clocked in (or still clocked out) and can retry.

## 5. Camera only
The point of the photo is that it's hard to fake: **open the camera directly, never the gallery / file picker**, front camera by default. Take the photo right before sending the punch, so the photo, the location and `localTimestamp` describe the same moment. The server can't tell a camera shot from a gallery picture; this guarantee comes from the app.

## 6. Offline punches
If the app queues punches offline, keep the photo file with the queued punch and send it with the same multipart request when back online. `localTimestamp` stays the moment of the punch; the server records its own receive time separately.

## Who sees the photo
Admins and supervisors, on the web cutoff approvals page only, until the punch is approved. Employees don't see it in the app.
