/**
 * One-time job: Send correction emails to employees whose time logs were
 * incorrectly auto-clocked out due to the late-clock-in bug (pre-fix).
 *
 * Affected logs: autoClockOut=false, status=true, timeOut=null, autoClockOutAt=null
 * that were recently reverted (updatedAt within the revert window).
 *
 * Run once:
 *   node src/jobs/sendAutoClockOutCorrectionEmails.js
 *
 * Test mode (sends one sample email to the given address, no real recipients touched):
 *   node src/jobs/sendAutoClockOutCorrectionEmails.js --test webdev@bizsolutions.us
 */

require("module-alias/register");
require("dotenv").config();

const { prisma } = require("@config/connection");
const { sendEmailNotification } = require("../services/notificationService");
const { sendEmail } = require("../services/emailService");

const { firstNameOf, fmtDay, fmtTime } = require("@emails/emailFormat"); // BB-144
const { links } = require("@emails/renderEmail");

// BB-144: the "time-log-correction" template, filled for this one case: the
// system set a clock-out too early and it was removed.
function correctionData({ firstName, companyName, shiftDate, autoOut }) {
  return {
    first_name:    firstName,
    company_name:  companyName,
    edited_by:     "BizBuddy",
    shift_date:    shiftDate,
    field_changed: "clock-out time",
    old_value:     autoOut ? `Out ${autoOut}` : "Automatic clock-out",
    new_value:     "Removed",
    reason:        "The system set this clock-out too early by mistake.",
    edited_at:     fmtDay(new Date()),
    timelog_url:   links.myPunchLogs(),
  };
}

const testIndex = process.argv.indexOf("--test");
const TEST_EMAIL = testIndex !== -1 ? process.argv[testIndex + 1] : null;

async function sendCorrectionEmails() {
  if (TEST_EMAIL) {
    console.log(`\n📧 [CORRECTION EMAIL] TEST MODE — sending sample to ${TEST_EMAIL}`);
    // Use sendEmail directly to skip DB logging (no real userId/companyId in test)
    await sendEmail({
      to:          TEST_EMAIL,
      templateKey: "time-log-correction",
      data:        correctionData({
        firstName:   "John",
        companyName: "BizBuddy Demo Company",
        shiftDate:   "Wed, Apr 8",
        autoOut:     "11:30 PM",
      }),
    });
    console.log(`   ✅ Test email sent to ${TEST_EMAIL}`);
    return;
  }

  console.log("\n📧 [CORRECTION EMAIL] Starting rollout...");

  // Query the originally affected logs using the same criteria as the bug:
  // autoClockOut=true, timeOut set, but recorded hours < 5.
  // Deduplicate by userId so each employee gets only one email.
  // Skip users without a companyId (system/admin accounts).
  const affectedLogs = await prisma.timeLog.findMany({
    where: {
      autoClockOut: true,
      timeOut:      { not: null },
      user: {
        companyId: { not: null },
      },
    },
    include: {
      user: {
        include: {
          profile: true,
          company: {
            select: { id: true, name: true, timeZone: true },
          },
        },
      },
    },
  });

  // Filter to logs where recorded hours < 5 (the affected condition)
  const revertedLogs = Object.values(
    affectedLogs
      .filter((log) => {
        const hours =
          (new Date(log.timeOut) - new Date(log.timeIn)) / (1000 * 60 * 60);
        return hours < 5;
      })
      // Deduplicate — one email per user (pick most recent affected log)
      .reduce((acc, log) => {
        if (
          !acc[log.userId] ||
          new Date(log.timeIn) > new Date(acc[log.userId].timeIn)
        ) {
          acc[log.userId] = log;
        }
        return acc;
      }, {})
  );

  if (revertedLogs.length === 0) {
    console.log("   ℹ️  No affected logs found.");
    return;
  }

  console.log(`   Found ${revertedLogs.length} affected employee(s). Sending emails...`);

  let successCount = 0;
  let skipCount    = 0;
  let errorCount   = 0;

  for (const log of revertedLogs) {
    const user = log.user;

    if (!user.email) {
      console.log(`   ⚠️  No email for user ${user.id} — skipping`);
      skipCount++;
      continue;
    }

    const employeeName =
      `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
      user.username;

    const companyName  = user.company?.name || "BizBuddy";
    const tz           = user.company?.timeZone;

    try {
      await sendEmailNotification({
        to:          user.email,
        templateKey: "time-log-correction",
        data:        correctionData({
          firstName: firstNameOf(user),
          companyName,
          shiftDate: fmtDay(log.timeIn, tz),
          autoOut:   fmtTime(log.timeOut, tz),
        }),
        notificationType: "AUTO_CLOCK_OUT",
        recipientUserId:  user.id,
        companyId:        user.companyId,
        metadata: {
          timeLogId:  log.id,
          revertedAt: new Date().toISOString(),
        },
      });

      console.log(`   ✓ Sent to: ${employeeName} <${user.email}>`);
      successCount++;
    } catch (err) {
      console.error(`   ❌ Failed for ${user.email}:`, err.message);
      errorCount++;
    }
  }

  console.log(
    `\n   ✅ Done — ${successCount} sent, ${skipCount} skipped (no email), ${errorCount} failed`
  );
}

sendCorrectionEmails()
  .catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
