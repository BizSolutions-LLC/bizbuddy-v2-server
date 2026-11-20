// src/services/Analytics/emailTemplateCatalog.js
//
// BB-140: every email template the server sends, with sample data, so a System
// Admin can send any of them to any address and check that it renders and that
// its images load. Each test goes through the REAL sender (same template, same
// from address), inside withEmailContext({ isTest }), so the subject gets
// "[TEST] " and the log row is marked as a test. Sample data only: no real
// employee, company, password, code or reset link is ever used.

const { sendMail } = require("@utils/mailer");
const { sendEmail } = require("@services/emailService");
const { renderWelcome } = require("../../emails/renderTemplate");

const APP_URL = () => process.env.CLIENT_URL || "https://app.mybizbuddy.co";
const YEAR = () => new Date().getFullYear();
const COMPANY = "BizBuddy Demo Co.";

// Templated (Handlebars) notification emails: same call as notificationService.
const hbs = (templateName, subject, context) => async (to) => {
  const r = await sendEmail({
    to,
    subject,
    templateName,
    context: { appUrl: APP_URL(), currentYear: YEAR(), ...context },
    log: { type: templateName },
  });
  if (!r.success) throw new Error(r.error || "Send failed.");
};

const TEMPLATES = [
  {
    key: "WELCOME_EMAIL",
    label: "Welcome (new account with login details)",
    from: "no-reply",
    usedBy: "Add employee, bulk add, self sign-up, System Admin Add company",
    send: async (to) => {
      const password = "Sample-Pass-1234";
      await sendMail({
        to,
        subject: "Welcome to BizBuddy — your account is live",
        html: renderWelcome({ firstName: "Jane", companyName: COMPANY, email: to, password }),
        text: `Hi Jane, your BizBuddy account is ready.\nEmail: ${to}\nPassword: ${password}`,
        log: { type: "WELCOME_EMAIL", notificationType: "WELCOME_EMAIL", redact: [password] },
      });
    },
  },
  {
    key: "PASSWORD_RESET",
    label: "Password reset instructions",
    from: "no-reply",
    usedBy: "Forgot password",
    send: async (to) => {
      // Lazy: controllers load a lot; only needed for this test.
      const { sendResetPasswordEmail } = require("@controllers/Account/resetPasswordController");
      await sendResetPasswordEmail(to, "sample-reset-token-not-valid", "Jane Doe", COMPANY);
    },
  },
  {
    key: "PASSWORD_CHANGED",
    label: "Password changed (security alert)",
    from: "no-reply",
    usedBy: "After a password reset",
    send: async (to) => {
      const { sendPasswordChangedEmail } = require("@controllers/Account/resetPasswordController");
      await sendPasswordChangedEmail(to, "Jane Doe", COMPANY);
    },
  },
  {
    key: "ACCOUNT_DELETION_CODE",
    label: "Account deletion verification code",
    from: "no-reply",
    usedBy: "Account deletion request",
    send: async (to) => {
      const { sendVerificationEmail } = require("@controllers/Features/requestAccountDeletionController");
      await sendVerificationEmail(to, "000000", "Jane Doe");
    },
  },
  {
    key: "missedClockIn",
    label: "Missed clock-in (employee)",
    from: "notifications",
    usedBy: "Every 5 minutes job",
    send: hbs("missedClockIn", "⏰ Reminder: Missing Clock-In", {
      employeeName: "Jane Doe", shiftName: "Regular Shift", scheduledStart: "8:00 AM", currentTime: "8:42 AM", department: "Classroom A",
    }),
  },
  {
    key: "missedClockOut",
    label: "Missed clock-out (employee)",
    from: "notifications",
    usedBy: "Every 5 minutes job",
    send: hbs("missedClockOut", "⏰ Reminder: Missing Clock-Out", {
      employeeName: "Jane Doe", clockInTime: "8:00 AM", expectedClockOut: "4:00 PM", hoursWorked: "8.00",
    }),
  },
  {
    key: "clockOutWarning",
    label: "Clock-out reminder (before auto clock-out)",
    from: "notifications",
    usedBy: "Auto clock-out warning",
    send: hbs("clockOutWarning", "Clock-Out Reminder", {
      employeeName: "Jane Doe", companyName: COMPANY, scheduledEndTime: "2:45 PM", clockInTime: "6:30 AM",
    }),
  },
  {
    key: "autoClockOut",
    label: "Automatic clock-out (employee)",
    from: "notifications",
    usedBy: "Auto clock-out",
    send: hbs("autoClockOut", "⏰ Automatic Clock-Out - 5 Hour Limit Reached", {
      employeeName: "Jane Doe", companyName: COMPANY, clockInTime: "Apr 12, 2026, 6:30 AM", clockOutTime: "Apr 12, 2026, 2:45 PM", hoursWorked: "8.25",
    }),
  },
  {
    key: "autoClockOutSv",
    label: "Automatic clock-out (supervisor copy)",
    from: "notifications",
    usedBy: "Auto clock-out",
    send: hbs("autoClockOutSv", `[Auto Clock-Out] Jane Doe — ${COMPANY}`, {
      employeeName: "Jane Doe", companyName: COMPANY, clockInTime: "Apr 12, 2026, 6:30 AM", clockOutTime: "Apr 12, 2026, 2:45 PM", scheduledEndTime: "Apr 12, 2026, 2:45 PM",
    }),
  },
  {
    key: "autoClockOutCorrected",
    label: "Time log correction notice",
    from: "notifications",
    usedBy: "Auto clock-out correction job",
    send: hbs("autoClockOutCorrected", "Time Log Correction Notice", {
      employeeName: "Jane Doe", companyName: COMPANY, originalDate: "Apr 12, 2026", clockInTime: "Apr 12, 2026, 6:30 AM", incorrectClockOutTime: "Apr 12, 2026, 11:30 AM",
    }),
  },
  {
    key: "morningReport",
    label: "Morning attendance report (admins)",
    from: "notifications",
    usedBy: "Daily at the company's morning report time",
    send: hbs("morningReport", `🔔 Morning Clock-In Report - ${COMPANY}`, {
      managerName: "Admin", companyName: COMPANY, reportDate: "Saturday, April 12, 2026", timeZone: "America/Los_Angeles",
      showAllClear: false, missedCount: 2, clockedInCount: 3,
      missedClockIns: [
        { employeeName: "Jane Doe", department: "Classroom A", scheduledTime: "8:00 AM", minutesLate: 42 },
        { employeeName: "Bob Reyes", department: "Classroom B", scheduledTime: "8:00 AM", minutesLate: 15 },
      ],
      currentlyClockedIn: [
        { employeeName: "Maria Cruz", department: "Classroom A", clockInTime: "7:58 AM", hoursWorked: "0.5" },
        { employeeName: "Carlos Tan", department: "Classroom B", clockInTime: "8:01 AM", hoursWorked: "0.4" },
      ],
    }),
  },
  {
    key: "eveningReport",
    label: "Evening attendance report (admins)",
    from: "notifications",
    usedBy: "Daily at the company's evening report time",
    send: hbs("eveningReport", `Evening Clock-Out Report - ${COMPANY}`, {
      managerName: "Admin", companyName: COMPANY, reportDate: "Saturday, April 12, 2026", timeZone: "America/Los_Angeles",
      showAllClear: false, missedCount: 1, stillClockedInCount: 2,
      missedClockOuts: [
        { employeeName: "Jane Doe", department: "Classroom A", clockInTime: "8:00 AM", expectedClockOut: "4:00 PM", minutesOverdue: 35 },
      ],
      stillClockedIn: [
        { employeeName: "Carlos Tan", department: "Classroom B", clockInTime: "8:01 AM", hoursWorked: "8.1", expectedClockOut: "4:00 PM" },
        { employeeName: "Ana Gonzalez", department: "Office", clockInTime: "7:45 AM", hoursWorked: "8.4", expectedClockOut: null },
      ],
    }),
  },
];

function listTemplates() {
  return TEMPLATES.map(({ key, label, from, usedBy }) => ({ key, label, from, usedBy }));
}

function findTemplate(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

module.exports = { listTemplates, findTemplate };
