Hi! Server update for **BB-089 — fixed-hours employees (SV): off-day work is now approvable OT.**

**Why:** SVs get a flat 80h per cutoff (10 weekdays × 8h). Until now *every* punch they made was auto-excluded ("Not counted: fixed hours"), so work on a day off, like Lennie Capulong's Sunday 10/11, could never be approved or paid as OT.

**New rule:**
- **Scheduled day:** covered by the flat 80h, including staying past the shift end. These punches stay excluded / "Not counted: fixed hours", the same as today.
- **Off day:** goes to the admin for approval. If approved, the hours are paid as **OT on top of the 80h**, with no threshold.
  - An SV with shifts plotted: off day = a date with no scheduled shift.
  - An SV with **no** shifts plotted in the cutoff (most SVs; Lennie shows "0h scheduled" every day): off day = **Saturday or Sunday**.
- Pending off-day punches block Lock/Finalize until they're approved or excluded, like any pending punch.
- The fixed-hours row stays at 80. Off-day work is not added to it, because it's paid as OT.

**API changes** (`GET /api/cutoff-periods/:id/approvals`). All are additive:
- Each approval gains **`isOffDay: boolean`**. It is true for a fixed-hours employee's punch on an off day.
- Off-day approvals for fixed-hours employees now come back as **`status: "pending"`** with `notes: "Off-day work (BB-089) — paid as OT if approved"`. Previously they were `excluded`.
- `otBlocks[]` can now include fixed-hours employees (`isFixedHoursEmployee: true`). For them, `breakdown.threshold` is `0` and `breakdown.days` lists only the off-day dates.
- Cutoff summary: `overtimeHours` for fixed-hours employees can now be above 0, and `totalHours` = flat hours + OT.
- The payroll export now includes their approved OT.

**Cutoff page changes needed:**
1. On a fixed-hours employee's punch row, when **`isOffDay` is true**, show the normal **Approve / Edit / Exclude** actions with an **"Off-day · OT"** badge instead of "Not counted: fixed hours". Keep "Not counted: fixed hours" only for `excluded` rows where `isOffDay` is false.
2. Show the **OT block approval** for fixed-hours employees, the same as other employees.
3. Employee header / payable: fixed hours + approved OT. For example, Lennie should show **88h** (80 regular + 8 OT).

**Test case — Lennie Capulong, cutoff Sep 30 – Oct 13** (kept open for this):
1. Sun 10/11 (8:00 AM → 5:00 PM) is pending with `isOffDay: true`. Oct 9, 12 and 13 stay "Not counted: fixed hours".
2. Approve 10/11 with **Edit → 8h**. An 8h OT block appears; approve it.
3. Payable is **88h** (80 regular + 8 OT).
4. Lock is blocked while 10/11 is pending, and works once it's decided.
5. After processing, the export shows Regular 80, OT 8.

**Status of other tickets, for reference:**
- **BB-098 (Leave credits / expiration):** still on hold while PadPro confirms the settings.
- **BB-102 (Admin add/edit/delete lunch):** server ready. See `docs/client-handoff-BB-102.md`.

The full details are in `docs/changelog-v2.10.49.md` → "BB-089 (rework)". Let me know if anything's unclear!
