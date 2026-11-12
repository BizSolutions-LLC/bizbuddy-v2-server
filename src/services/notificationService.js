const { prisma } = require("@config/connection");
const moment = require("moment-timezone");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { getMessaging } = require("@config/firebase");
const { sendEmail } = require("./emailService");
const { notifyUser, notifyManagement } = require("./socketService");
const { getIO } = require("@config/socket");
const { targetRouteFor } = require("./notificationTargets");

// ── BB-117: company prefix only when it helps ───────────────────────────────
// "[Company] " is added only when the recipient's email also has an active
// account in another active company, so single-company users get clean titles.
// Cached briefly per user: reports and bulk imports notify the same people.
const MULTI_COMPANY_TTL_MS = 10 * 60 * 1000;
const multiCompanyCache = new Map(); // userId -> { multi, at }

async function isMultiCompany(user) {
  if (!user?.email) return false;
  const hit = multiCompanyCache.get(user.id);
  if (hit && Date.now() - hit.at < MULTI_COMPANY_TTL_MS) return hit.multi;
  const others = await prisma.user.count({
    where: {
      ...HUMAN_ONLY,
      email: user.email,
      id: { not: user.id },
      status: "active",
      companyId: { not: user.companyId },
      company: { isActive: true },
    },
  });
  const multi = others > 0;
  multiCompanyCache.set(user.id, { multi, at: Date.now() });
  return multi;
}

function withPrefix(companyName, text) {
  if (!text || !companyName) return text;
  const tag = `[${companyName}]`;
  return text.startsWith(tag) ? text : `${tag} ${text}`;
}

/**
 * Kept for older callers: adds "[Company] " to a text. New code should let
 * createNotification decide (it prefixes only multi-company recipients).
 */
async function prefixWithCompanyName(companyId, text) {
  if (!text || !companyId) return text;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
  return withPrefix(company?.name, text);
}

// FCM errors that mean the token will never work again (app uninstalled,
// reinstalled, or token rotated): the token is removed so we stop sending to it.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

async function dropDeadToken(token, err) {
  if (!DEAD_TOKEN_CODES.has(err?.code || err?.errorInfo?.code)) return false;
  // invalid-argument can also mean a bad payload; only treat it as a dead token
  // when FCM says the token itself is the problem.
  if ((err?.code || err?.errorInfo?.code) === "messaging/invalid-argument" && !/token/i.test(err?.message || "")) return false;
  const { count } = await prisma.user.updateMany({ where: { deviceToken: token }, data: { deviceToken: null } });
  console.warn(`[BB-117] removed a dead FCM token from ${count} account(s): ${err.code || err?.errorInfo?.code}`);
  return true;
}

/**
 * BB-117: the one push format for every notification type.
 * FCM data values must be strings.
 */
function pushMessage({ token, title, body, notificationId, notificationCode, companyId, targetRoute, payload }) {
  return {
    token,
    notification: { title: title || "BizBuddy", body: body || "" },
    data: {
      notificationId: String(notificationId || ""),
      type: String(notificationCode),
      companyId: String(companyId || ""),
      targetRoute: String(targetRoute),
      payload: JSON.stringify(payload || {}),
    },
    android: { notification: { channelId: "default" } },
  };
}

/**
 * Sends one push. Never throws; a dead token is removed.
 * @returns {Promise<boolean>} sent
 */
async function sendPush(message) {
  const messaging = getMessaging();
  if (!messaging || !message?.token) return false;
  try {
    await messaging.send(message);
    return true;
  } catch (err) {
    const dropped = await dropDeadToken(message.token, err).catch(() => false);
    if (!dropped) console.error("❌ FCM push error:", err?.code || err?.message || err);
    return false;
  }
}

/**
 * Create an internal notification: inbox row + socket event + phone push.
 *
 * BB-117 additions (all optional for callers):
 *   dedupeKey    e.g. "MISSED_CLOCK_IN:{userId}:{userShiftId}". The database rejects a
 *                second row with the same key (also after the user deleted the first,
 *                since deleting only hides it), so nothing is sent twice.
 *   targetRoute  app screen for a tap; defaults by notification type (notificationTargets.js).
 *   push         false to skip the phone push (inbox + socket only).
 *
 * Nothing is sent to an inactive account or an inactive company (BB-107 / BB-117).
 * @returns {Promise<object|null>} the inbox row, or null when skipped or a duplicate.
 */
async function createNotification({
  userId,
  companyId,
  departmentId,
  notificationCode,
  title,
  message,
  payload = {},
  dedupeKey = null,
  targetRoute = null,
  push = true,
}) {
  try {
    const recipient = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        status: true,
        deviceToken: true,
        companyId: true,
        company: { select: { name: true, isActive: true } },
      },
    });
    if (!recipient || recipient.status !== "active") return null;
    if (recipient.company && recipient.company.isActive === false) return null;

    // Cheap early exit for jobs that re-check every few minutes; the unique
    // index below still decides when two processes race.
    if (dedupeKey) {
      const seen = await prisma.notificationLog.findUnique({ where: { dedupeKey }, select: { id: true } });
      if (seen) return null;
    }

    const multi = await isMultiCompany(recipient);
    const companyName = multi ? recipient.company?.name : null;
    const finalTitle = withPrefix(companyName, title);
    const finalMessage = withPrefix(companyName, message);
    const route = targetRoute || targetRouteFor(notificationCode);

    let notification;
    try {
      notification = await prisma.notificationLog.create({
        data: {
          userId,
          companyId,
          departmentId,
          notificationCode,
          title: finalTitle,
          message: finalMessage,
          payload,
          dedupeKey,
          targetRoute: route,
        },
      });
    } catch (err) {
      // P2002 = unique violation on dedupeKey: already sent, send nothing.
      if (err?.code === "P2002" && dedupeKey) return null;
      throw err;
    }

    notifyUser(userId, {
      id: notification.id,
      type: notificationCode,
      title: finalTitle,
      message: finalMessage,
      payload,
      targetRoute: route,
      createdAt: notification.createdAt,
      seen: false,
    });

    if (push && recipient.deviceToken) {
      await sendPush(
        pushMessage({
          token: recipient.deviceToken,
          title: finalTitle,
          body: finalMessage,
          notificationId: notification.id,
          notificationCode,
          companyId,
          targetRoute: route,
          payload,
        })
      );
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
    // BB-107: never email an inactive (or deleted) account.
    // BB-117: nor anyone in an inactive company.
    if (recipientUserId) {
      const recipient = await prisma.user.findUnique({
        where: { id: recipientUserId },
        select: { status: true, company: { select: { isActive: true } } },
      });
      if (!recipient || recipient.status !== "active") {
        return { success: false, skipped: true, reason: "Recipient account is not active." };
      }
      if (recipient.company && recipient.company.isActive === false) {
        return { success: false, skipped: true, reason: "Company is not active." };
      }
    } else if (companyId) {
      const company = await prisma.company.findUnique({ where: { id: companyId }, select: { isActive: true } });
      if (company && company.isActive === false) {
        return { success: false, skipped: true, reason: "Company is not active." };
      }
    }

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

  // Internal notification. BB-117: once per scheduled shift (dedupeKey); the
  // email goes out only when the inbox entry was actually created.
  const created = await createNotification({
    userId: user.id,
    companyId: company.id,
    departmentId: user.departmentId,
    notificationCode: "MISSED_CLOCK_IN",
    dedupeKey: shiftDetails.userShiftId ? `MISSED_CLOCK_IN:${user.id}:${shiftDetails.userShiftId}` : null,
    title: "⏰ Missed Clock-In",
    message: `You haven't clocked in for your ${shiftDetails.shiftName} shift scheduled at ${shiftDetails.startTime}.`,
    payload: {
      shiftId: shiftDetails.shiftId,
      scheduledStart: shiftDetails.scheduledStart,
      shiftName: shiftDetails.shiftName,
    },
  });

  // Email notification (if enabled)
  if (created && company.notifyEmployeeMissedIn && user.email) {
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

  // Internal notification. BB-117: once per punch (dedupeKey), so deleting it in
  // the app or the job's next run doesn't send it again; the email goes out only
  // when the inbox entry was actually created.
  const created = await createNotification({
    userId: user.id,
    companyId: company.id,
    departmentId: user.departmentId,
    notificationCode: "MISSED_CLOCK_OUT",
    dedupeKey: timeLog.id ? `MISSED_CLOCK_OUT:${user.id}:${timeLog.id}` : null,
    title: "⏰ Missed Clock-Out",
    message: `You haven't clocked out yet. Your shift ended at ${new Date(timeLog.expectedClockOut).toLocaleTimeString("en-US", { timeZone: company.timeZone || "America/Los_Angeles" })}.`,
    payload: {
      timeLogId: timeLog.id,
      clockInTime: timeLog.timeIn,
      expectedClockOut: timeLog.expectedClockOut,
    },
  });

  // Email notification (if enabled)
  if (created && company.notifyEmployeeMissedOut && user.email) {
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
// BB-117: the report date is the company's own date (passed in by the job, in
// the company zone); one report per manager per day (dedupeKey); greeting uses
// the manager's name. Shared by the morning and evening reports.
const MANAGER_SELECT = {
  id: true,
  email: true,
  username: true,
  role: true,
  profile: { select: { firstName: true, lastName: true } },
};
const managerName = (m) => m.profile?.firstName?.trim() || m.username || "there";
function companyReportDate(company, dateKey) {
  const tz = company.timeZone || "America/Los_Angeles";
  const day = dateKey ? moment.tz(dateKey, "YYYY-MM-DD", tz) : moment().tz(tz);
  return { dateKey: day.format("YYYY-MM-DD"), reportDate: day.format("dddd, MMMM D, YYYY") };
}

async function sendMorningReport(
  companyId,
  missedClockIns,
  currentlyClockedIn,
  options = {},
) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });

  if (!company?.notifyAdminMissedClocks || company.isActive === false) return;
  const { dateKey, reportDate } = companyReportDate(company, options.dateKey);

  const managementUsers = await prisma.user.findMany({
    where: {
      ...HUMAN_ONLY,
      companyId,
      role: { in: ["admin", "superadmin", "supervisor"] },
      status: "active",
    },
    select: MANAGER_SELECT,
  });

  const emailPromises = managementUsers.map(async (manager) => {
    // Internal notification
    const created = await createNotification({
      userId: manager.id,
      companyId,
      departmentId: null,
      notificationCode: "DAILY_CLOCK_IN_REPORT",
      dedupeKey: `DAILY_CLOCK_IN_REPORT:${manager.id}:${dateKey}`,
      title: "📊 Morning Clock-In Report",
      message: `${missedClockIns.length} employees missed clock-in. ${currentlyClockedIn.length} employees are currently clocked in.`,
      payload: {
        missedCount: missedClockIns.length,
        clockedInCount: currentlyClockedIn.length,
      },
    });

    // Email notification (only with a new inbox entry: once per manager per day)
    if (created && manager.email) {
      await sendEmailNotification({
        to: manager.email,
        subject: `🔔 Morning Clock-In Report - ${company.name}`,
        templateName: "morningReport",
        context: {
          managerName: managerName(manager),
          companyName: company.name,
          reportDate,
          timeZone: company.timeZone || "America/Los_Angeles",
          currentYear: new Date().getFullYear(),
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

  if (!company?.notifyAdminMissedClocks || company.isActive === false) return;
  const { dateKey, reportDate } = companyReportDate(company, options.dateKey);

  // Get management users
  const managementUsers = await prisma.user.findMany({
    where: {
      ...HUMAN_ONLY,
      companyId,
      role: { in: ["admin", "superadmin", "supervisor"] },
      status: "active",
    },
    select: MANAGER_SELECT,
  });

  const emailContext = (manager) => ({
    managerName: managerName(manager),
    companyName: company.name,
    reportDate,
    timeZone: company.timeZone || "America/Los_Angeles",
    currentYear: new Date().getFullYear(),
    missedClockOuts,
    stillClockedIn,
    missedCount: missedClockOuts.length,
    stillClockedInCount: stillClockedIn.length,
    showAllClear: missedClockOuts.length === 0 && stillClockedIn.length === 0,
    appUrl: process.env.CLIENT_URL,
  });

  const emailPromises = managementUsers.map(async (manager) => {
    // Internal notification — skip in test mode to avoid polluting the DB.
    // BB-117: once per manager per day; no new inbox entry means no email either.
    let created = true;
    if (!testEmail) {
      created = await createNotification({
        userId: manager.id,
        companyId,
        departmentId: null,
        notificationCode: "DAILY_CLOCK_OUT_REPORT",
        dedupeKey: `DAILY_CLOCK_OUT_REPORT:${manager.id}:${dateKey}`,
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
    if (!created || !recipientEmail) return;
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
  const created = await createNotification({
    userId: user.id,
    companyId: user.companyId,
    departmentId: user.departmentId,
    notificationCode: "AUTO_CLOCK_OUT",
    dedupeKey:        `AUTO_CLOCK_OUT:${user.id}:${timeLog.id}`, // BB-117: once per punch
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
  if (created && user.email) {
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

  const created = await createNotification({
    userId:           user.id,
    companyId:        user.companyId,
    departmentId:     user.departmentId,
    notificationCode: "CLOCK_OUT_WARNING",
    dedupeKey:        `CLOCK_OUT_WARNING:${user.id}:${timeLog.id}`, // BB-117: once per punch
    title:            "Clock-Out Reminder",
    message:          `Your shift ends at ${endStr}. Please clock out before then.`,
    payload: {
      timeLogId:    timeLog.id,
      scheduledEnd: scheduledEnd?.toISOString() ?? null,
    },
  });

  if (created && user.email) {
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
  sendPush,
  pushMessage,
  sendEmailNotification,
  notifyMissedClockIn,
  notifyMissedClockOut,
  sendMorningReport,
  sendEveningReport,
  notifyAutoClockOut,
  notifyClockOutWarning,
  notifyAutoClockOutSupervisors,
};
