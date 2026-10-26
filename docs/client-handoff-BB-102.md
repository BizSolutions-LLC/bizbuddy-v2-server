BB-102 — Admin add / edit / delete lunch on an employee's punch
================================================================

Admins (admin, superadmin, supervisor) can add, edit and delete the lunch on an employee's
completed punch. Hours are recomputed on the server, and the Cutoff page shows the new hours.


1. ADD OR EDIT LUNCH
--------------------
PUT /api/timelogs/:id/lunch-break
Body: { "start": "2026-10-08T19:00:00.000Z", "end": "2026-10-08T19:30:00.000Z" }   // ISO, UTC

  - The same call adds a lunch or replaces the existing one.
  - 200 → { message: "Lunch added." | "Lunch updated.", data: <updated TimeLog> }
  - data.lunchBreak is now:
      { start, end, editedBy, editedAt, previous }   // previous = the lunch it replaced, or null
    The new fields are additive. Anything that reads lunchBreak.start/end keeps working.


2. DELETE LUNCH
---------------
DELETE /api/timelogs/:id/lunch-break           (no body)

  - Removes any lunch: punched by the employee, added by an admin, or auto-injected.
  - 200 → { message: "Lunch deleted.", data: <updated TimeLog> } with lunchBreak: null.
  - 200 → { message: "No lunch on this punch — nothing to delete." } if there was none.


3. WHEN IT'S ALLOWED / ERRORS
-----------------------------
  400  start/end missing or invalid, start >= end, or the lunch falls outside the punch's
       clock-in and clock-out
  400  the punch has no clock-out yet (only completed punches)
  403  not admin/superadmin/supervisor, or a punch from another company
  404  time log not found
  409  the punch is in a locked or processed cutoff
  409  the punch is already approved (or excluded) in its cutoff. Message:
       "This punch is already approved in its cutoff. Reset the approval on the Cutoff page
        before editing lunch."

  Suggested UI: show the Add / Edit / Delete lunch actions only on completed punches. On a 409,
  show the message as it comes back.


4. WHAT CHANGES AFTER A SAVE
----------------------------
  - The response's data already holds the recomputed fields: netWorkedHours,
    lunchDeductionMinutes, and on Driver/Aide punches driverAmSegmentHours,
    regularSegmentHours and driverPmSegmentHours.
  - Regular punch: lunch deducted = the larger of the lunch length and the company's
    minimum lunch. Driver/Aide punch: the lunch comes out of the segment it falls in.
  - Cutoff page: pending rows read these fields live. Refetch the cutoff approvals after a
    save and the new hours show.
  - Socket: "timeLogUpdated" goes to the employee, with type "lunchBreakEdited" or
    "lunchBreakDeleted".
  - After a delete, the company's minimum-lunch rule applies again, the same as for a punch
    with no lunch.


5. UI WORK
----------
  - Admin punch record (punch logs, and the Cutoff row if that's where admins fix punches):
    "Add lunch" when there is none; "Edit lunch" / "Delete lunch" when there is one.
  - Time pickers for start/end, limited to the punch's clock-in and clock-out. Send them as UTC
    ISO, converted from the company timezone.
  - Optional: show "Edited by <name> on <date>" from lunchBreak.editedBy / editedAt.


6. TEST CHECKLIST
-----------------
  1. Add a 30-min lunch on a pending Regular punch (PadPro). Net hours drop by 0.5h on the punch
     log and on the Cutoff page.
  2. Edit it to 45 min. lunchBreak.previous shows the 30-min one.
  3. Delete it. Net hours go back.
  4. Driver/Aide punch: a lunch inside the Regular window lowers only regularSegmentHours.
  5. An approved punch returns 409. Reset it on the Cutoff page and the edit then works.
  6. A punch in a locked/processed cutoff returns 409.
