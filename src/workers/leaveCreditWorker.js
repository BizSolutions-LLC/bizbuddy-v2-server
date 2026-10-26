// src/workers/leaveCreditWorker.js
//
// BB-098 — Leave credit cycle. Replaces the old leaveAccrualWorker (gated on
// Company.accrualEnabled, which no screen could set; it ran on server time
// and had no double-run guard).
//
// Runs hourly. For every company whose leave credits are set up and that has
// at least one toggle on, runs one cycle in the company's own timezone:
//   1. expire lots past their last usable day   (leaveExpirationEnabled)
//   2. send the "credits expiring" reminders     (leaveExpirationEnabled)
//   3. automatic grants + regularization grants  (leaveGrantEnabled)
// Every step is idempotent (per-lot / per-period claims), so running hourly
// just means a company's day boundary is picked up within the hour, and a
// missed run is caught up by the next one.

const cron = require("node-cron");
const { prisma } = require("@config/connection");
const { COMPANY_CREDIT_SELECT, runCompanyCycle } = require("@services/Leave/leaveCreditService");

let running = false;

async function runLeaveCreditCycle() {
  if (running) return;
  running = true;
  try {
    const companies = await prisma.company.findMany({
      where: {
        leaveCreditsInitializedAt: { not: null },
        OR: [{ leaveGrantEnabled: true }, { leaveExpirationEnabled: true }],
      },
      select: COMPANY_CREDIT_SELECT,
    });

    for (const company of companies) {
      try {
        const result = await runCompanyCycle(company);
        const g = result.grants;
        const e = result.expired;
        if ((g && (g.regular || g.regularization)) || (e && e.lots) || result.remindersSent) {
          console.log(`[LeaveCredits] Company ${company.id} — ${JSON.stringify(result)}`);
        }
      } catch (err) {
        console.error(`[LeaveCredits] Company ${company.id} failed:`, err);
      }
    }
  } catch (err) {
    console.error("[LeaveCredits] Fatal error:", err);
  } finally {
    running = false;
  }
}

function scheduleLeaveCredits() {
  cron.schedule("15 * * * *", runLeaveCreditCycle);
}

module.exports = { scheduleLeaveCredits, runLeaveCreditCycle };
