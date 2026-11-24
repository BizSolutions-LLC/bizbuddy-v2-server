# Changelog — v2.11.22

**Branch:** `release/v2.11.22` (pushed 2026-11-24), from `origin/master` (after PR #136).

**Tickets:**
- BB-148: Missed Clock-In / Missed Clock-Out read the shift in its own time zone. **Complete (user, 2026-11-24). Real check: the first night after deploy (no Missed Clock-In at 00:30 PHT for a shift already worked).**
- Tooling: `/version-of` command (which server versions shipped a ticket). **Complete.**

**Schema change:** none. **Deploy:** needed (server code). No SQL, no `prisma generate`, no env change, no data scripts.
**Client impact:** none (same notification titles, text and push format).
**Mobile impact:** none.

---

# BB-148 — Missed Clock-In / Missed Clock-Out in the shift's time zone

- **What:** BizSolutions LLC (company zone Los Angeles, shifts in Manila) got a "⏰ Missed Clock-In" push at 00:30 PHT for an 8:00 AM PHT shift that was already worked. The "Shift starting soon" reminder was correct.
- **Cause:** `jobs/checkMissedClockIns.js` read every shift in the company zone and ignored `Shift.timeZone`. 8:00 AM was read as 8:00 AM LA; + 30 min grace = 8:30 AM LA = 00:30 PHT the next day. The punch lookup started at 7:30 AM LA, after the real 8:00 AM PHT clock-in, so it found none. `jobs/checkMissedClockOuts.js` had the same problem: it matched a punch to a shift by the company-zone date, so a Manila morning punch matched the previous day's shift.
- **Changes:**
  - `src/jobs/checkMissedClockIns.js`:
    - Shift zone = `Shift.timeZone` → company zone → Los Angeles (same order as `workers/clockInReminderWorker.js`).
    - Start/end built with the shared `combineAssignedDateWithTimeTz` (`services/timeLogComputeUtils.js`). The local helper read the server's clock (`moment(date)`, `toTimeString()`) and was removed.
    - Loads the company's yesterday, today and tomorrow, then keeps only shifts whose start (in the shift's zone) + grace falls in the 5-minute window.
    - Skips cancelled shifts.
    - Times in the inbox message and email are in the shift's zone.
  - `src/jobs/checkMissedClockOuts.js`:
    - New `shiftOfPunch`: the shift assigned on the punch's clock-in date in the shift's zone (yesterday/today/tomorrow candidates, cancelled skipped). Several shifts that day: the one starting closest to the clock-in.
    - Shift end, crosses-midnight handling and email times in the shift's zone. Local server-clock helper removed.
- **Same-zone companies (e.g. PadPro):** same result as before. Only cancelled shifts no longer alert.
- **Not changed:**
  - Morning/evening admin reports still read shifts in the company zone (separate ticket if wanted).
  - Missed Clock-In still counts punches only from 30 min before the shift start.
  - Past false alerts stay in the inbox.
- **Order of steps:** merge → deploy. Check the first night after deploy.

# Tooling — `/version-of`

- `.claude/commands/version-of.md`: `/version-of BB-125 [BB-134 ...]` lists the server versions that shipped a ticket (release commits on `master` + `docs/changelog-v*.md`), splits "shipped" from "mentioned only", and gives one version for the tracker (latest shipped). Read-only.
