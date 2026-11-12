// src/services/notificationTargets.js
//
// BB-117: which mobile-app screen a tapped notification opens. The app routes
// only on `targetRoute` (a value starting with "/"); `targetScreen` is ignored.
// Routes come from the mobile developer's table (BB-117, answered 2026-11-11).
// Types they didn't list fall back to the notifications
// screen, their own default, until they confirm a better one:
//   CONTEST_REQUEST_SUBMITTED (punch-log request to approve), DELETION_REQUEST_SUBMITTED,
//   DAILY_CLOCK_IN_REPORT / DAILY_CLOCK_OUT_REPORT, SCHEDULE_ASSIGNED_MANAGEMENT.

const ROUTES = {
  punch:         "/(tabs)/(shifts)/timekeeping-punch",
  schedule:      "/(tabs)/(shifts)/timekeeping-schedule",
  punchRequests: "/(tabs)/(shifts)/timekeeping-punch-requests",
  myLeave:       "/(tabs)/(leaves)/leaves-request",
  approveLeave:  "/(tabs)/(requests)?type=leave",
  myOvertime:    "/(tabs)/(overtime)",
  approveOT:     "/(tabs)/(requests)?type=overtime",
  payroll:       "/(tabs)/payroll",
  inbox:         "/(tabs)/notifications",
};

const BY_CODE = {
  // Shift reminder, missed clock-in/out, clock-out warning, auto clock-out
  CLOCK_IN_REMINDER: ROUTES.punch,
  MISSED_CLOCK_IN: ROUTES.punch,
  MISSED_CLOCK_OUT: ROUTES.punch,
  CLOCK_OUT_WARNING: ROUTES.punch,
  AUTO_CLOCK_OUT: ROUTES.punch,

  // Shift assigned, schedule created, shift replaced (the employee's own schedule)
  SCHEDULE_ASSIGNED: ROUTES.schedule,
  SCHEDULE_UPDATED: ROUTES.schedule,
  SCHEDULE_REPLACED: ROUTES.schedule,

  // Punch-log request (the employee's own request)
  CONTEST_REQUEST_APPROVED: ROUTES.punchRequests,
  CONTEST_REQUEST_REJECTED: ROUTES.punchRequests,

  // Leave (employee)
  LEAVE_REQUEST_FIRST_APPROVED: ROUTES.myLeave,
  LEAVE_REQUEST_APPROVED: ROUTES.myLeave,
  LEAVE_REQUEST_REJECTED: ROUTES.myLeave,
  LEAVE_CREDITS_EXPIRING: ROUTES.myLeave,

  // Leave to approve (sent to approvers; a cancellation goes to the same list)
  LEAVE_REQUEST_SUBMITTED: ROUTES.approveLeave,
  LEAVE_PENDING_SECONDARY_APPROVAL: ROUTES.approveLeave,
  LEAVE_REQUEST_CANCELLED: ROUTES.approveLeave,

  // Overtime
  OVERTIME_REQUEST_APPROVED: ROUTES.myOvertime,
  OVERTIME_REQUEST_REJECTED: ROUTES.myOvertime,
  OVERTIME_REQUEST_SUBMITTED: ROUTES.approveOT,

  // Payroll, cutoffs
  PAYSLIP_GENERATED: ROUTES.payroll,
  CUTOFF_PERIOD_LOCKED: ROUTES.payroll,
  CUTOFF_PROCESSED: ROUTES.payroll,
};

/** @param {string} notificationCode @returns {string} */
function targetRouteFor(notificationCode) {
  return BY_CODE[notificationCode] || ROUTES.inbox;
}

module.exports = { targetRouteFor, ROUTES };
