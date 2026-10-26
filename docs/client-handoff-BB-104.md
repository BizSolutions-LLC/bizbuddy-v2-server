BB-104 — Cutoff Approvals: "Approve Schedule" does nothing when the employee has no schedule (B&C)

Hi team, a new ticket for the web client. Please confirm the bug on your side before you start.

THE REPORT
In Cutoff Approvals on a B&C company, clicking "Approve Schedule" on a punch sometimes does nothing:
no shift picker opens and nothing loads. It happens when the employee has no shift assigned on that
punch's date, so there are no shifts to pick from.

PLEASE CONFIRM FIRST
1. Open a B&C cutoff in Cutoff Approvals.
2. Find a punch for an employee with no shift assigned that day. The schedule column shows no
   schedule.
3. Click "Approve Schedule".
4. Expected today: nothing opens, or an empty picker.
5. In the cutoff approvals response, that approval's availableShifts should be [].

Let us know if you see the same thing, or if the button does something else (an error toast, a
console error, etc.).

WHAT THE SERVER ALREADY SENDS (no server change needed)
- Every B&C approval in the cutoff approvals response has
  availableShifts: [{ id, shiftName, startTime "HH:mm", endTime "HH:mm" }, ...]
  It holds the employee's shifts on the punch's date (company timezone, cancelled shifts excluded),
  and it's [] when they have none.
- Approve Schedule without a shiftId is rejected with 400: "shiftId is required for
  approve-schedule mode." So nothing can be approved by mistake. The problem is only that the button
  looks broken.

THE FIX (CLIENT), ONCE CONFIRMED
- Grey out (disable) "Approve Schedule" when availableShifts is empty or missing.
- Add a tooltip on the disabled button, for example: "No schedule assigned for this day. Assign a
  shift first, or use Approve Raw / Edit."
- Approve Raw, Edit and Reject stay available as they are.
- No other change. After a shift is assigned and the approvals list re-fetches, availableShifts is
  filled and the button turns back on by itself.

Thanks!
