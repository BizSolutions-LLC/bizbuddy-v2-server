// src/services/Analytics/emailTemplateCatalog.js
//
// BB-140: every email template the server sends, with sample data, so a System
// Admin can send any of them to any address and check that it renders and that
// its images load. Each test goes through the REAL sender (same template, same
// from address), inside withEmailContext({ isTest }), so the subject gets
// "[TEST] " and the log row is marked as a test. Sample data only: no real
// employee, company, password, code or reset link is ever used.
//
// BB-144: all twelve use the shared design (src/emails/templates); the keys and
// labels below are unchanged so the System Admin page keeps working.
// BB-145: + CONTACT_FORM (website contact form, sent to the test address
// instead of CONTACT_FORM_TO).

const { sendMail } = require("@utils/mailer");
const { sendEmail } = require("@services/emailService");
const { buildWelcomeEmail } = require("@emails/welcomeEmail");
const { links } = require("@emails/renderEmail");
const { sendContactEmail } = require("@services/Public/contactFormService");

const COMPANY = "BizBuddy Demo Co.";

// Notification emails: same call path as notificationService (templateKey + data).
const tpl = (templateKey, logType, data) => async (to) => {
  const r = await sendEmail({
    to,
    templateKey,
    data: { company_name: COMPANY, ...data },
    log: { type: logType },
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
      const { subject, html, text } = await buildWelcomeEmail({
        firstName: "Jane",
        companyName: COMPANY,
        email: to,
        password,
        department: "Driver/Aide",
        role: "employee",
      });
      await sendMail({
        to,
        subject,
        html,
        text,
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
      await sendResetPasswordEmail(to, "sample-reset-token-not-valid", "Jane Doe", COMPANY, { firstName: "Jane", device: "Chrome on Windows" });
    },
  },
  {
    key: "PASSWORD_CHANGED",
    label: "Password changed (security alert)",
    from: "no-reply",
    usedBy: "After a password reset",
    send: async (to) => {
      const { sendPasswordChangedEmail } = require("@controllers/Account/resetPasswordController");
      await sendPasswordChangedEmail(to, "Jane Doe", COMPANY, { firstName: "Jane", device: "Chrome on Windows" });
    },
  },
  {
    key: "ACCOUNT_DELETION_CODE",
    label: "Account deletion verification code",
    from: "no-reply",
    usedBy: "Account deletion request",
    send: async (to) => {
      const { sendVerificationEmail } = require("@controllers/Features/requestAccountDeletionController");
      await sendVerificationEmail(to, "000000", "Jane Doe", { firstName: "Jane", companyName: COMPANY });
    },
  },
  {
    key: "missedClockIn",
    label: "Missed clock-in (employee)",
    from: "notifications",
    usedBy: "Every 5 minutes job",
    send: tpl("missed-clock-in", "MISSED_CLOCK_IN", {
      first_name: "Jane", shift_name: "Driver AM", shift_start: "6:45 AM", shift_end: "8:00 AM",
      shift_date: "Mon, Nov 23", minutes_late: 20, supervisor_name: "Carlo Reyes", clock_in_url: links.punch(),
    }),
  },
  {
    key: "missedClockOut",
    label: "Missed clock-out (employee)",
    from: "notifications",
    usedBy: "Every 5 minutes job",
    send: tpl("missed-clock-out", "MISSED_CLOCK_OUT", {
      first_name: "Jane", shift_date: "Mon, Nov 23", shift_name: "Driver AM", shift_start: "6:45 AM", shift_end: "8:00 AM",
      clock_in: "6:47 AM", correction_url: links.myPunchLogs(), correction_deadline: "Tue, Nov 24",
    }),
  },
  {
    key: "clockOutWarning",
    label: "Clock-out reminder (before auto clock-out)",
    from: "notifications",
    usedBy: "Auto clock-out warning",
    send: tpl("clock-out-reminder", "CLOCK_OUT_WARNING", {
      first_name: "Jane", shift_end: "2:45 PM", auto_clock_out: "3:45 PM", clock_out_url: links.punch(),
    }),
  },
  {
    key: "autoClockOut",
    label: "Automatic clock-out (employee)",
    from: "notifications",
    usedBy: "Auto clock-out",
    send: tpl("auto-clock-out-employee", "AUTO_CLOCK_OUT", {
      first_name: "Jane", shift_date: "Mon, Nov 23", clock_in: "6:47 AM", auto_clock_out: "3:58 PM", hours_recorded: "9.18h",
      correction_url: links.myPunchLogs(), correction_deadline: "Tue, Nov 24",
    }),
  },
  {
    key: "autoClockOutSv",
    label: "Automatic clock-out (supervisor copy)",
    from: "notifications",
    usedBy: "Auto clock-out",
    send: tpl("auto-clock-out-supervisor", "AUTO_CLOCK_OUT_SV", {
      first_name: "Carlo", employee_name: "Jane Doe", employee_first_name: "Jane", department: "Driver/Aide",
      shift_date: "Mon, Nov 23", shift_name: "Driver AM", shift_start: "6:45 AM", shift_end: "8:00 AM",
      clock_in: "6:47 AM", auto_clock_out: "3:58 PM", hours_recorded: "9.18h", review_url: links.companyPunchLogs(),
    }),
  },
  {
    key: "autoClockOutCorrected",
    label: "Time log correction notice",
    from: "notifications",
    usedBy: "Auto clock-out correction job",
    send: tpl("time-log-correction", "AUTO_CLOCK_OUT", {
      first_name: "Jane", edited_by: "BizBuddy", shift_date: "Mon, Nov 23", field_changed: "clock-out time",
      old_value: "Out 11:30 AM", new_value: "Removed", reason: "The system set this clock-out too early by mistake.",
      edited_at: "Tue, Nov 24", timelog_url: links.myPunchLogs(),
    }),
  },
  {
    key: "morningReport",
    label: "Morning attendance report (admins)",
    from: "notifications",
    usedBy: "Daily at the company's morning report time",
    send: tpl("attendance-morning", "DAILY_CLOCK_IN_REPORT", {
      report_date: "Mon, Nov 23", report_time: "8:30 AM", scope: "All departments",
      scheduled_count: 24, clocked_in_count: 22, late_count: 2, missing_count: 2,
      missing: [
        { name: "Smith, John", detail: "Driver AM · 6:45 AM", status: "Not in" },
        { name: "Santos, Maria", detail: "Regular · 8:00 AM", status: "Not in" },
      ],
      late: [
        { name: "Cruz, Alex", detail: "Driver AM · in at 7:05 AM", status: "Late 20m" },
        { name: "Doe, Jane", detail: "Driver AM · in at 7:03 AM", status: "Late 18m" },
      ],
      roster_url: links.companyPunchLogs(),
    }),
  },
  {
    key: "eveningReport",
    label: "Evening attendance report (admins)",
    from: "notifications",
    usedBy: "Daily at the company's evening report time",
    send: tpl("attendance-evening", "DAILY_CLOCK_OUT_REPORT", {
      report_date: "Mon, Nov 23", report_time: "6:00 PM", scope: "All departments",
      worked_count: 22, open_count: 1, auto_count: 1, absent_count: 1,
      open: [{ name: "Cruz, Alex", detail: "In since 1:30 PM · shift ended 2:45 PM", status: "Overdue 3h 15m" }],
      auto_out: [{ name: "Doe, Jane", detail: "In 7:58 AM · auto out 3:58 PM", status: "Auto 3:58 PM" }],
      absent: [{ name: "Smith, John", detail: "Driver AM · 6:45 AM", status: "No-show" }],
      hours_today: "174.5h", overtime_hours: "2.4h (est.)", review_url: links.companyPunchLogs(),
    }),
  },
  {
    key: "CONTACT_FORM",
    label: "Website contact form (team inbox)",
    from: "no-reply",
    usedBy: "Landing page contact form (BB-145)",
    send: async (to) => {
      await sendContactEmail(
        {
          name: "Jane Visitor",
          email: "jane.visitor@example.com",
          company: "Acme Home Care",
          phone: "+1 (555) 010-2030 x12",
          teamSize: "25",
          message: "Hi, we'd like a quote for 25 people across two sites.\nCan someone call us this week?\n\nThanks,\nJane",
        },
        { to: [to] },
      );
    },
  },
];

function listTemplates() {
  return TEMPLATES.map(({ key, label, from, usedBy }) => ({ key, label, from, usedBy }));
}

function findTemplate(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

module.exports = { listTemplates, findTemplate };
