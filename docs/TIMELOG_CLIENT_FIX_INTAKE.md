# Intake — Client-Side Band-Aid Fix for TimeLog / Cutoff Hours Display

> Fill this in (or have whoever made the client-side change fill it in) before we touch anything server-side. Goal: confirm the server fix is safe to do in parallel, should replace the band-aid, or needs sequencing.

## 1. Where was the fix made?

- [ ] Timelog listing/detail page
- [ ] Cutoff Period approval page
- [ ] Payroll report / payroll run screen
- [ ] Somewhere else: ______________________

File/component name(s) touched:

## 2. What was actually broken on screen, before the fix?

(e.g. "hours shown didn't match what was approved," "showed pre-approval numbers after lock," "wrong OT total on the report")

## 3. What does the fix actually do?

- What field(s) does the client now read that it didn't before? (e.g. `cutoffApproval.actualHours`, `cutoffApproval.status`, something else)
- Does it **override/recompute** a value client-side, or does it just **read a different field** from the existing API response?
- If it recomputes: what's the formula/logic, in plain terms?

## 4. What condition triggers the fix?

- [ ] Always applied, regardless of cutoff status
- [ ] Only when `cutoffApproval.status === "approved"`
- [ ] Only when the cutoff period is `locked`
- [ ] Some other condition: ______________________

## 5. Does it use any field that doesn't currently exist in the API response?

(If yes — which one, and did you add a fallback/default for when it's missing? This matters because if the server later adds that field for real, the fallback logic needs to be removed or it'll mask the real value.)

## 6. Scope check — does the fix affect anything besides what it targets?

- Does it touch OT display too, or only regular hours?
- Does it touch both the Timelog page AND the report, or just one?
- Any other screen that reads the same underlying API response and might now show inconsistent numbers relative to the patched screen?

## 7. Paste the actual diff/snippet if you have it

```
(paste here)
```

---

## Why this matters (context for whoever fills this in)

Three server-side gaps were confirmed in this investigation, all around the same root issue — hours displayed after cutoff approval don't reflect the approved values:

1. **Timelog page** (`timeLogController.js`) — always shows `TimeLog.netWorkedHours`/`*SegmentHours` (pre-approval), never `TimeLogApproval.actualHours` (the payroll source of truth once approved).
2. **Payroll report generation** (`payrollController.js` → `computeEntryForUser`) — recomputes hours from raw `TimeLog.timeIn`/`timeOut` from scratch, with no reference to `TimeLogApproval` or `CutoffPeriod` at all.
3. **Cutoff summary endpoint** (`cutoffPeriodController.js` → `getCutoffSummary`) — does read from `TimeLogApproval`, but pulls `approval.scheduledHours` instead of `approval.actualHours`.

If the client-side fix is patching around gap #1 or #3 specifically, a matching server fix could conflict with it. If it's patching around gap #2 (payroll), that's a different, likely more invasive area — worth flagging separately since a client-side workaround for a server-side payroll calculation gap is higher-risk to leave in place long-term.
