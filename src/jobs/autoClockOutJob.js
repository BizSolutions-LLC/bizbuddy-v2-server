// src/jobs/autoClockOutJob.js
//
// Two-pass auto clock-out cron job. Runs every 5 minutes.
//
// Pass 1 — WARN
//   Query: LiveUser WHERE warnAt <= now AND warningSent = false
//   Action: push + email to employee, mark warningSent = true
//
// Pass 2 — CLOSE
//   Query: LiveUser WHERE closeAt <= now AND timeLog.status = true
//   Action: set timeOut = scheduledEnd, autoClockOut = true
//           run computeTimeLogSummary, email configured SV addresses
//           delete the LiveUser row
//
// All per-record errors are caught and skipped — the job never aborts mid-run.

const moment                             = require("moment-timezone");
const { prisma }                          = require("@config/connection");
const { shiftTimeStr }                    = require("@services/attendanceReportSchedule"); // BB-144
const { getIO }                           = require("@config/socket");
const { computeTimeLogSummary }           = require("@services/timeLogComputeService");
const {
  notifyClockOutWarning,
  notifyAutoClockOutSupervisors,
}                                         = require("@services/notificationService");

// BB-144: the punch's shift (name + times) for the supervisor email. assignedDate
// holds the calendar date at UTC midnight: match the company-zone clock-in date.
async function shiftOfPunch(userId, timeIn, timeZone) {
  try {
    const tz = moment.tz.zone(timeZone || "") ? timeZone : "America/Los_Angeles";
    const ymd = moment(timeIn).tz(tz).format("YYYY-MM-DD");
    const userShift = await prisma.userShift.findFirst({
      where: {
        userId,
        status:       { not: "cancelled" },
        assignedDate: { gte: new Date(`${ymd}T00:00:00.000Z`), lte: new Date(`${ymd}T23:59:59.999Z`) },
      },
      include: { shift: true },
      orderBy: { shift: { endTime: "desc" } }, // same pick as liveUserService: the day's latest end
    });
    if (!userShift?.shift) return null;
    const fmt = (v) => {
      const t = shiftTimeStr(v);
      return t ? moment.tz(`${ymd} ${t}`, "YYYY-MM-DD HH:mm:ss", tz).format("h:mm A") : null;
    };
    return {
      name:  userShift.shift.shiftName,
      start: fmt(userShift.customStartTime || userShift.shift.startTime),
      end:   fmt(userShift.customEndTime || userShift.shift.endTime),
    };
  } catch {
    return null;
  }
}

async function autoClockOutJob() {
  try {
    console.log("\n⏰ [AUTO CLOCK-OUT] Running...");

    const now = new Date();

    // ── PASS 1: Warn ─────────────────────────────────────────────────────────
    const toWarn = await prisma.liveUser.findMany({
      where: {
        warnAt:      { lte: now },
        warningSent: false,
      },
      include: {
        user: {
          select: {
            id:           true,
            email:        true,
            username:     true,
            companyId:    true,
            departmentId: true,
            profile:      { select: { firstName: true, lastName: true } },
          },
        },
        timeLog: { select: { id: true, timeIn: true } },
      },
    });

    let warned = 0;
    for (const lu of toWarn) {
      try {
        await notifyClockOutWarning({
          user:         lu.user,
          scheduledEnd: lu.scheduledEnd,
          closeAt:      lu.closeAt, // BB-144: when the automatic clock-out runs
          timeLog:      lu.timeLog,
        });
        await prisma.liveUser.update({
          where: { id: lu.id },
          data:  { warningSent: true },
        });
        console.log(`   ⚠️  Warned: ${lu.user.email || lu.userId}`);
        warned++;
      } catch (err) {
        console.error(`   ❌ Warn failed for ${lu.userId}:`, err.message);
      }
    }

    // ── PASS 2: Close ────────────────────────────────────────────────────────
    const toClose = await prisma.liveUser.findMany({
      where: {
        closeAt: { lte: now },
        timeLog: { status: true },
      },
      include: {
        user: {
          select: {
            id:           true,
            email:        true,
            username:     true,
            companyId:    true,
            departmentId: true,
            profile:      { select: { firstName: true, lastName: true } },
            company: {
              select: {
                name:                    true,
                timeZone:                true, // BB-144
                autoClockOutNotifyEmails: true,
              },
            },
          },
        },
        timeLog: {
          select: {
            id:          true,
            timeIn:      true,
            coffeeBreaks: true,
            lunchBreak:   true,
          },
        },
      },
    });

    const cronFiredAt = now;
    let closed = 0;

    for (const lu of toClose) {
      try {
        // timeOut = scheduledEnd (not cron time); fallback: timeIn + 8h
        const resolvedTimeOut = lu.scheduledEnd
          ?? new Date(new Date(lu.timeLog.timeIn).getTime() + 8 * 3_600_000);

        // Build update — close any open breaks at cron fire time
        const updateData = {
          timeOut:        resolvedTimeOut,
          status:         false,
          autoClockOut:   true,
          autoClockOutAt: cronFiredAt,
        };

        if (Array.isArray(lu.timeLog.coffeeBreaks)) {
          updateData.coffeeBreaks = lu.timeLog.coffeeBreaks.map((b) =>
            b.start && !b.end ? { ...b, end: cronFiredAt.toISOString() } : b
          );
        }

        if (lu.timeLog.lunchBreak?.start && !lu.timeLog.lunchBreak?.end) {
          updateData.lunchBreak = {
            ...lu.timeLog.lunchBreak,
            end: cronFiredAt.toISOString(),
          };
        }

        // Persist clock-out
        const closedTimeLog = await prisma.timeLog.update({
          where: { id: lu.timeLog.id },
          data:  updateData,
        });

        // Notify the employee's socket room in real time
        try {
          getIO().to(lu.userId).emit("timeLogUpdated", { type: "autoClockOut", data: closedTimeLog });
        } catch (_) {}

        // Compute derived fields (non-fatal)
        let hoursRecorded = null; // BB-144: net hours for the supervisor email
        try {
          await computeTimeLogSummary(lu.timeLog.id);
          const computed = await prisma.timeLog.findUnique({
            where:  { id: lu.timeLog.id },
            select: { netWorkedHours: true },
          });
          if (computed?.netWorkedHours != null) hoursRecorded = Number(computed.netWorkedHours);
        } catch (computeErr) {
          console.error(
            `   ⚠️  computeTimeLogSummary failed for ${lu.timeLog.id}:`,
            computeErr.message
          );
        }

        // Notify supervisors
        const notifyEmails = Array.isArray(lu.user.company?.autoClockOutNotifyEmails)
          ? lu.user.company.autoClockOutNotifyEmails.filter(
              (e) => typeof e === "string" && e.trim()
            )
          : [];

        await notifyAutoClockOutSupervisors({
          user:         lu.user,
          timeLog: {
            id:      lu.timeLog.id,
            timeIn:  lu.timeLog.timeIn,
            timeOut: resolvedTimeOut,
            hoursRecorded,
          },
          scheduledEnd: lu.scheduledEnd,
          notifyEmails,
          shift: await shiftOfPunch(lu.userId, lu.timeLog.timeIn, lu.user.company?.timeZone), // BB-144
        });

        // Remove LiveUser row
        await prisma.liveUser.delete({ where: { id: lu.id } });

        const name = [lu.user.profile?.firstName, lu.user.profile?.lastName]
          .filter(Boolean)
          .join(" ") || lu.user.email;

        console.log(
          `   ✓ Closed: ${name} | timeOut → ${resolvedTimeOut.toISOString()}`
        );
        closed++;
      } catch (err) {
        console.error(`   ❌ Close failed for ${lu.userId}:`, err.message);
      }
    }

    console.log(`   ✅ Done — warned: ${warned}, closed: ${closed}`);
  } catch (err) {
    console.error("   ❌ [AUTO CLOCK-OUT] Fatal error:", err);
  }
}

module.exports = autoClockOutJob;
