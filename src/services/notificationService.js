const { prisma } = require("@config/connection");
const { getMessaging } = require("@config/firebase");
const { sendEmail } = require("./emailService");
const { notifyUser, notifyManagement } = require("./socketService");
const { getIO } = require("@config/socket");

async function prefixWithCompanyName(companyId, text) {
  if (!text || !companyId) return text;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true },
  });
  if (!company?.name) return text;

  const prefix = `[${company.name}] `;
  if (text.startsWith(prefix) || text.startsWith(`[${company.name}]`)) return text;
  return `${prefix}${text}`;
}

/**
 * Create internal notification (database + socket)
 */
async function createNotification({
  userId,
  companyId,
  departmentId,
  notificationCode,
  title,
  message,
  payload = {},
}) {
  try {
    const [prefixedTitle, prefixedMessage] = await Promise.all([
      prefixWithCompanyName(companyId, title),
      prefixWithCompanyName(companyId, message),
    ]);

    // Save to database
    const notification = await prisma.notificationLog.create({
      data: {
        userId,
        companyId,
        departmentId,
        notificationCode,
        title: prefixedTitle,
        message: prefixedMessage,
        payload,
      },
    });

    // Send via Socket.io
    notifyUser(userId, {
      id: notification.id,
      type: notificationCode,
      title: prefixedTitle,
      message: prefixedMessage,
      payload,
      createdAt: notification.createdAt,
      seen: false,
    });

    const messaging = getMessaging();
    if (messaging) {
      try {
        const { deviceToken } = await prisma.user.findUnique({
          where: { id: userId },
          select: { deviceToken: true },
        });
        if (deviceToken) {
          await messaging.send({
            token: deviceToken,
            notification: { title: prefixedTitle, body: prefixedMessage || "" },
            data: {
              type: String(notificationCode),
              notificationId: String(notification.id),
              payload: JSON.stringify(payload || {}),
            },
          });
        }
      } catch (pushErr) {
        console.error("❌ FCM push error:", pushErr);
      }
    }

    return notification;
  } catch (error) {
    console.error("❌ Error creating notification:", error);
    throw error;
  }
}

/**
 * Send email notification and log it
 */
async function sendEmailNotification({
  to,
  subject,
  templateName,
  context,
  notificationType,
  recipientUserId,
  companyId,
  metadata = {},
}) {
  try {
    // Send email
    const result = await sendEmail({
      to,
      subject,
      templateName,
      context,
    });

    // Log email sent
    await prisma.emailNotificationLog.create({
      data: {
        notificationType,
        recipientEmail: to,
        recipientUserId,
        companyId,
        subject,
        body: JSON.stringify(context),
        status: result.success ? "sent" : "failed",
        errorMessage: result.error || null,
        metadata,
      },
    });

    return result;
  } catch (error) {
    console.error("❌ Error sending email notification:", error);
    throw error;
  }
}

/**
 * Notify employee about missed clock-in
 */
async function notifyMissedClockIn(employee, shift, company) {
  const { user, shiftDetails } = employee;

  // Internal notification
  await createNotification({
    userId: user.id,
    companyId: company.id,
    departmentId: user.departmentId,
    notificationCode: "MISSED_CLOCK_IN",
    title: "⏰ Missed Clock-In",
    message: `You haven't clocked in for your ${shiftDetails.shiftName} shift scheduled at ${shiftDetails.startTime}.`,
    payload: {
      shiftId: shiftDetails.shiftId,
      scheduledStart: shiftDetails.scheduledStart,
      shiftName: shiftDetails.shiftName,
    },
  });

  // Email notification (if enabled)
  if (company.notifyEmployeeMissedIn && user.email) {
    await sendEmailNotification({
      to: user.email,
      subject: "⏰ Reminder: Missing Clock-In",
      templateName: "missedClockIn",
      context: {
        employeeName:
          `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
          user.username,
        shiftName: shiftDetails.shiftName,
        scheduledStart: shiftDetails.startTime,
        currentTime: new Date().toLocaleTimeString("en-US"),
        department: user.department?.name || "N/A",
        appUrl: process.env.CLIENT_URL,
      },
      notificationType: "MISSED_CLOCK_IN",
      recipientUserId: user.id,
      companyId: company.id,
      metadata: { shiftId: shiftDetails.shiftId },
    });
  }
}

/**
 * Notify employee about missed clock-out
 */
async function notifyMissedClockOut(employee, timeLog, company) {
  const { user } = employee;

  // Internal notification
  await createNotification({
    userId: user.id,
    companyId: company.id,
    departmentId: user.departmentId,
    notificationCode: "MISSED_CLOCK_OUT",
    title: "⏰ Missed Clock-Out",
    message: `You haven't clocked out yet. Your shift ended at ${new Date(timeLog.expectedClockOut).toLocaleTimeString("en-US", { timeZone: company.timeZone || "America/Los_Angeles" })}.`,
    payload: {
      timeLogId: timeLog.id,
      clockInTime: timeLog.timeIn,
      expectedClockOut: timeLog.expectedClockOut,
    },
  });

  // Email notification (if enabled)
  if (company.notifyEmployeeMissedOut && user.email) {
    await sendEmailNotification({
      to: user.email,
      subject: "⏰ Reminder: Missing Clock-Out",
      templateName: "missedClockOut",
      context: {
        employeeName:
          `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
          user.username,
        clockInTime: new Date(timeLog.timeIn).toLocaleTimeString("en-US", { timeZone: company.timeZone || "America/Los_Angeles" }),
        expectedClockOut: new Date(timeLog.expectedClockOut).toLocaleTimeString("en-US", { timeZone: company.timeZone || "America/Los_Angeles" }),
        hoursWorked: timeLog.hoursWorked,
        appUrl: process.env.CLIENT_URL,
      },
      notificationType: "MISSED_CLOCK_OUT",
      recipientUserId: user.id,
      companyId: company.id,
      metadata: { timeLogId: timeLog.id },
    });
  }
}

/**
 * Send daily morning report to management
 */
async function sendMorningReport(
  companyId,
  missedClockIns,
  currentlyClockedIn,
) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });

  if (!company.notifyAdminMissedClocks) return;

  const managementUsers = await prisma.user.findMany({
    where: {
      companyId,
      role: { in: ["admin", "superadmin", "supervisor"] },
      status: "active",
    },
    select: {
      id: true,
      email: true,
      username: true,
      role: true,
    },
  });

  const emailPromises = managementUsers.map(async (manager) => {
    // Internal notification
    await createNotification({
      userId: manager.id,
      companyId,
      departmentId: null,
      notificationCode: "DAILY_CLOCK_IN_REPORT",
      title: "📊 Morning Clock-In Report",
      message: `${missedClockIns.length} employees missed clock-in. ${currentlyClockedIn.length} employees are currently clocked in.`,
      payload: {
        missedCount: missedClockIns.length,
        clockedInCount: currentlyClockedIn.length,
      },
    });

    // Email notification
    if (manager.email) {
      await sendEmailNotification({
        to: manager.email,
        subject: `🔔 Morning Clock-In Report - ${company.name}`,
        templateName: "morningReport",
        context: {
          managerName: manager.username,
          companyName: company.name,
          reportDate: new Date().toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          missedClockIns,
          currentlyClockedIn,
          missedCount: missedClockIns.length,
          clockedInCount: currentlyClockedIn.length,
          showAllClear:
            missedClockIns.length === 0 && currentlyClockedIn.length === 0, // ✅ KEY FIX
          appUrl: process.env.CLIENT_URL,
        },
        notificationType: "DAILY_CLOCK_IN_REPORT",
        recipientUserId: manager.id,
        companyId,
        metadata: {
          missedCount: missedClockIns.length,
          clockedInCount: currentlyClockedIn.length,
        },
      });
    }
  });

  await Promise.all(emailPromises);
}

/**
 * Send daily evening report to management
 */
async function sendEveningReport(
  companyId,
  missedClockOuts,
  stillClockedIn,
  options = {},
) {
  const { testEmail } = options;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });

  if (!company.notifyAdminMissedClocks) return;

  // Get management users
  const managementUsers = await prisma.user.findMany({
    where: {
      companyId,
      role: { in: ["admin", "superadmin", "supervisor"] },
      status: "active",
    },
    select: {
      id: true,
      email: true,
      username: true,
      role: true,
    },
  });

  const emailContext = (manager) => ({
    managerName: manager.username,
    companyName: company.name,
    reportDate: new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    missedClockOuts,
    stillClockedIn,
    missedCount: missedClockOuts.length,
    stillClockedInCount: stillClockedIn.length,
    showAllClear: missedClockOuts.length === 0 && stillClockedIn.length === 0,
    appUrl: process.env.CLIENT_URL,
  });

  const emailPromises = managementUsers.map(async (manager) => {
    // Internal notification — skip in test mode to avoid polluting the DB
    if (!testEmail) {
      await createNotification({
        userId: manager.id,
        companyId,
        departmentId: null,
        notificationCode: "DAILY_CLOCK_OUT_REPORT",
        title: "Evening Clock-Out Report",
        message: `${missedClockOuts.length} employees missed clock-out. ${stillClockedIn.length} employees are still clocked in.`,
        payload: {
          missedCount: missedClockOuts.length,
          stillClockedInCount: stillClockedIn.length,
        },
      });
    }

    // In test mode, send only one email to testEmail using the first manager's context.
    // Skip all subsequent managers so we don't send duplicate test emails per company.
    const recipientEmail = testEmail || manager.email;
    if (!recipientEmail) return;
    if (testEmail && managementUsers.indexOf(manager) !== 0) return;

    await sendEmailNotification({
      to: recipientEmail,
      subject: testEmail
        ? `[TEST] Evening Clock-Out Report - ${company.name}`
        : `Evening Clock-Out Report - ${company.name}`,
      templateName: "eveningReport",
      context: emailContext(manager),
      notificationType: "DAILY_CLOCK_OUT_REPORT",
      recipientUserId: manager.id,
      companyId,
      metadata: {
        missedCount: missedClockOuts.length,
        stillClockedInCount: stillClockedIn.length,
      },
    });
  });

  await Promise.all(emailPromises);
}

/**
 * Notify employee about automatic clock-out after 5 hours
 */
async function notifyAutoClockOut({ user, timeLog }) {
  const companyId = user.companyId;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });

  // 1. Internal notification (database + socket)
  await createNotification({
    userId: user.id,
    companyId: user.companyId,
    departmentId: user.departmentId,
    notificationCode: "AUTO_CLOCK_OUT",
    title: "⏰ Automatic Clock-Out",
    message: `You were automatically clocked out after working ${timeLog.hoursWorked} hours (5-hour limit reached).`,
    payload: {
      timeLogId: timeLog.id,
      timeIn: timeLog.timeIn,
      timeOut: timeLog.timeOut,
      hoursWorked: timeLog.hoursWorked,
    },
  });

  // 2. Socket.IO real-time notification
  const io = getIO();
  io.to(user.id).emit("autoClockOut", {
    type: "autoClockOut",
    message: `You were automatically clocked out after 5 hours of work.`,
    data: {
      timeLogId: timeLog.id,
      timeIn: timeLog.timeIn,
      timeOut: timeLog.timeOut,
      hoursWorked: timeLog.hoursWorked,
    },
  });

  // 3. Email notification
  if (user.email) {
    await sendEmailNotification({
      to: user.email,
      subject: "⏰ Automatic Clock-Out - 5 Hour Limit Reached",
      templateName: "autoClockOut",
      context: {
        employeeName:
          `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
          user.username,
        clockInTime: new Date(timeLog.timeIn).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }),
        clockOutTime: new Date(timeLog.timeOut).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }),
        hoursWorked: timeLog.hoursWorked,
        companyName: company?.name || "BizBuddy",
        appUrl: process.env.CLIENT_URL,
      },
      notificationType: "AUTO_CLOCK_OUT",
      recipientUserId: user.id,
      companyId: user.companyId,
      metadata: {
        timeLogId: timeLog.id,
        hoursWorked: timeLog.hoursWorked,
      },
    });
  }
}

/**
 * Warn an employee that their shift is ending soon and they should clock out.
 * Sends a push notification + email.
 *
 * @param {object} opts
 * @param {object} opts.user         — { id, email, companyId, departmentId, profile, company }
 * @param {Date}   opts.scheduledEnd — resolved shift end time
 * @param {object} opts.timeLog      — { id, timeIn }
 */
async function notifyClockOutWarning({ user, scheduledEnd, timeLog }) {
  const company = await prisma.company.findUnique({
    where:  { id: user.companyId },
    select: { name: true, timeZone: true },
  });

  const tz       = company?.timeZone || "America/Los_Angeles";
  const endStr   = scheduledEnd
    ? new Date(scheduledEnd).toLocaleTimeString("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit" })
    : "your scheduled end time";

  await createNotification({
    userId:           user.id,
    companyId:        user.companyId,
    departmentId:     user.departmentId,
    notificationCode: "CLOCK_OUT_WARNING",
    title:            "Clock-Out Reminder",
    message:          `Your shift ends at ${endStr}. Please clock out before then.`,
    payload: {
      timeLogId:    timeLog.id,
      scheduledEnd: scheduledEnd?.toISOString() ?? null,
    },
  });

  if (user.email) {
    const clockInStr = new Date(timeLog.timeIn).toLocaleTimeString("en-US", {
      timeZone: tz,
      hour:     "2-digit",
      minute:   "2-digit",
    });

    await sendEmailNotification({
      to:             user.email,
      subject:        "Clock-Out Reminder",
      templateName:   "clockOutWarning",
      context: {
        employeeName:     `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() || user.email,
        companyName:      company?.name || "BizBuddy",
        scheduledEndTime: endStr,
        clockInTime:      clockInStr,
        appUrl:           process.env.CLIENT_URL,
        currentYear:      new Date().getFullYear(),
      },
      notificationType: "CLOCK_OUT_WARNING",
      recipientUserId:  user.id,
      companyId:        user.companyId,
      metadata:         { timeLogId: timeLog.id },
    });
  }
}

/**
 * Notify configured supervisor email addresses that an employee was auto-clocked out.
 * This is a plain email-only notification (no internal DB notification — supervisors
 * may not have user accounts in the system).
 *
 * @param {object}   opts
 * @param {object}   opts.user          — { id, email, username, companyId, profile, company }
 * @param {object}   opts.timeLog       — { id, timeIn, timeOut }
 * @param {Date}     opts.scheduledEnd  — the pre-computed shift end from LiveUser
 * @param {string[]} opts.notifyEmails  — list of recipient email addresses
 */
async function notifyAutoClockOutSupervisors({ user, timeLog, scheduledEnd, notifyEmails }) {
  if (!notifyEmails || notifyEmails.length === 0) return;

  const company = await prisma.company.findUnique({
    where:  { id: user.companyId },
    select: { name: true, timeZone: true },
  });

  const tz           = company?.timeZone || "America/Los_Angeles";
  const employeeName = `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() || user.username || user.email;

  const fmt = (dt) =>
    new Date(dt).toLocaleString("en-US", {
      timeZone:   tz,
      dateStyle:  "medium",
      timeStyle:  "short",
    });

  const clockInStr   = fmt(timeLog.timeIn);
  const clockOutStr  = fmt(timeLog.timeOut);
  const scheduledStr = scheduledEnd ? fmt(scheduledEnd) : fmt(timeLog.timeOut);

  await Promise.allSettled(
    notifyEmails.map((email) =>
      sendEmailNotification({
        to:             email,
        subject:        `[Auto Clock-Out] ${employeeName} — ${company?.name || "BizBuddy"}`,
        templateName:   "autoClockOutSv",
        context: {
          employeeName,
          companyName:      company?.name || "BizBuddy",
          clockInTime:      clockInStr,
          clockOutTime:     clockOutStr,
          scheduledEndTime: scheduledStr,
          appUrl:           process.env.CLIENT_URL,
          currentYear:      new Date().getFullYear(),
        },
        notificationType: "AUTO_CLOCK_OUT_SV",
        recipientUserId:  null,
        companyId:        user.companyId,
        metadata:         { timeLogId: timeLog.id, employeeId: user.id },
      })
    )
  );
}

module.exports = {
  prefixWithCompanyName,
  createNotification,
  sendEmailNotification,
  notifyMissedClockIn,
  notifyMissedClockOut,
  sendMorningReport,
  sendEveningReport,
  notifyAutoClockOut,
  notifyClockOutWarning,
  notifyAutoClockOutSupervisors,
};
