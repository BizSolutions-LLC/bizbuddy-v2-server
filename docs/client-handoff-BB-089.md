BB-089: Fixed-hours employees (e.g. SV at 80h per cutoff), server v2.10.45
=====================================================================

WHAT'S NEW
----------
Some employees (e.g. certain Staff Supervisors) are paid a fixed rate. For them, the server now
pays a flat number of hours per cutoff (default 80), whatever their clock-ins are.

It's controlled by two switches, and both have to be on:
  1. Department master switch: turns the feature on for the department and holds the hours.
  2. Employee switch: turns fixed hours on for that one person, inside that department.

Everyone else in the department stays punch-based.


1. COMPANY SETTINGS: "DEPARTMENT FIXED HOURS" CARD
--------------------------------------------------
This extends the card you already have (Staff / Staff Supervisor / Driver/Aide rows).

a) Department row (already built)
   - The master switch saves to the existing endpoint:
       PUT /api/departments/update/:id
       { "fixedHoursEnabled": true }
   - When the switch is on, show an "Hours per cutoff" number input:
       PUT /api/departments/update/:id
       { "fixedHoursPerCutoff": 80 }
     It must be above 0 and at most 999. A bad value returns 400 { error }.
   - The department GET endpoints already return fixedHoursEnabled and fixedHoursPerCutoff.

b) Employee list inside the department row (new)
   - When the master switch is on, expand the row, or add a "Manage employees" toggle, and load:

       GET /api/departments/:id/fixed-hours-members

       200 {
         "data": {
           "department": { "id", "name", "fixedHoursEnabled", "fixedHoursPerCutoff" },
           "members": [
             {
               "userId": "…",
               "firstName": "Jane", "lastName": "Doe",
               "email": "…", "employeeId": "…" | null,
               "role": "employee", "status": "active" | "inactive",
               "fixedHoursEnabled": true,   // this employee's own switch
               "isOnFixedHours": true       // what actually applies now: both switches on AND active
             }
           ]
         }
       }

     Members are sorted by last name, then first name. Deleted users aren't included.

   - Each row shows the employee's name (plus employee ID if there is one) and a switch labelled
     "Fixed hours" / "Punch-based".
   - To toggle one employee, or several at once for a "Select all" or bulk action:

       PUT /api/departments/:id/fixed-hours-members
       { "userIds": ["…", "…"], "enabled": true }

       200 { "data": { "updatedCount", "userIds", "fixedHoursEnabled" }, "message" }

     - 400 if userIds is empty, enabled isn't a boolean, or a user isn't in this department.
     - 404 if the department isn't found.
     - Admin, superadmin and supervisor can all do this (same as the department update).

   - All employees start OFF. The admin picks the fixed-rate people.
   - If the master switch is OFF, still show the list (read-only or greyed out) if you like.
     Employee switches are kept, so turning the department back on restores the same people.
   - Inactive employees can be switched on, but they only get fixed hours while they're active.
     Showing isOnFixedHours = false as a small "inactive" tag is enough.

c) Summary tiles (suggestion)
   - "Fixed-Hours Depts X/Y": count departments where fixedHoursEnabled is true.
   - It would help to also show "N employees on fixed hours" per department (count members
     where isOnFixedHours = true).

d) "How Fixed Hours Work" info box: suggested wording, now that it's per employee
   - Turn a department on, then pick which employees are on fixed hours. Everyone else stays
     punch-based.
   - Each selected employee gets the department's hours per cutoff (default 80), whatever their
     clock-ins are.
   - Paid leave is included: 8h of leave gives 72h regular + 8h leave = 80h. Leave balances are
     still used up as normal.
   - Punches are kept for reference but not counted for pay, never create OT, and never block Lock
     or Finalize.
   - Turning a department or an employee off only affects open cutoffs. Locked and processed
     cutoffs stay as they are.


2. CUTOFF REVIEW PAGE
---------------------
GET /api/cutoff-periods/:id/approvals now also returns:

a) A new top-level "fixedHours" list, one entry per fixed-hours employee in this cutoff:

     {
       "id": "…", "userId": "…",
       "user": { "id", "email", "username", "departmentId", "profile" },
       "status": "approved",
       "hours": 80, "leaveHours": 8, "regularHours": 72,
       "editedBy": { "id", "profile": { "firstName", "lastName" } } | null,
       "editedAt": "…" | null,
       "notes": "…" | null
     }

   - Show it as one row per employee, e.g. "Fixed hours: 80.00h", with "72 regular + 8 leave"
     when leaveHours > 0.
   - It's already approved, so there's no Approve button.
   - Show "Edited by <name> on <date>" when editedBy is set.

b) A new "isFixedHoursEmployee" flag (boolean) on every row in "data" (punches) and "otBlocks".
   - Their punches come back as status "excluded" with the note:
       "Fixed-hours department (BB-089) — not counted for pay"
   - Keep showing them, labelled "Not counted: fixed hours".
   - Hide or disable Approve / Approve Schedule / Approve Raw / Edit on those punches and on their
     OT blocks.

c) Editing a fixed-hours row (e.g. someone hired partway through the cutoff):

     PATCH /api/cutoff-periods/:id/fixed-hours/:fixedHoursId
     { "hours": 40, "notes": "Hired mid-cutoff" }

     200 { "message", "data": { …row, "hours", "leaveHours", "regularHours" } }

   - hours must be between 0 and 999. notes is optional.
   - Only works while the cutoff is OPEN. Locked or processed returns 400, so hide the Edit button
     for them.
   - Errors: 400 (bad hours, or cutoff not open), 404 (row not in this cutoff).


3. CUTOFF SUMMARY
-----------------
GET /api/cutoff-periods/:id/summary: for fixed-hours employees,
  - totalHours    = fixed hours (e.g. 80)
  - regularHours  = fixed hours minus paid leave
  - overtimeHours = 0
  - two new fields: isFixedHours = true, and leaveHours
You can show a "Fixed" badge on these rows.


BEHAVIOR TO KNOW
----------------
- Fixed hours include paid leave (72 regular + 8 leave = 80).
- The fixed row shows up, and punches get excluded, the next time the review page loads (and also
  on Lock / Finalize). No separate "sync" call is needed after changing a switch.
- Turning a department or an employee off only affects OPEN cutoffs: the fixed row disappears and
  their punches go back to pending review. Locked and processed cutoffs never change.
- Who counts is based on the employee's CURRENT department.
- Payroll processing and the Yearly Total Hours report pick up fixed hours automatically.


COMPATIBILITY
-------------
Everything is additive. If no department and no employee is switched on, every response is the same
as before, except for an empty "fixedHours": [] and "isFixedHoursEmployee": false.


HOW TO CHECK IT
---------------
1. Turn on the Staff Supervisor master switch (80h). Load its employees: all switches should be off.
2. Turn on 2 employees. Open an OPEN cutoff's review page. Only those 2 should have a
   "Fixed hours: 80.00h" row, and only their punches should show "Not counted: fixed hours".
3. The other Staff Supervisors should still be punch-based and need normal approval.
4. Edit one fixed row to 40h. It should update and show "Edited by".
5. Lock the cutoff. The fixed employees' punches shouldn't block it.
6. Turn one employee off and reload an open cutoff. Their fixed row should be gone and their punches
   back to pending.
7. Turn the department off, then on again. The same 2 employees should still be switched on.
