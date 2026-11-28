// src/services/Company/companySettingsEventService.js
//
// BB-151: Company Settings history.
//
// Table "CompanySettingsEvent" (scripts/add-company-settings-events-bb151.sql): one row
// per settings save that changed something: who (User.id + B. Buddy staff id), which
// page ("area") and each field old → new. Raw SQL (like CutoffStatusEvent), so it
// doesn't depend on the generated Prisma client.
//
//   - diffSettings: only the fields that really changed (Decimal, Date, arrays, JSON normalised).
//   - recordSettingsChange / recordDiff: best effort, never blocks or fails a save.
//   - listHistory: newest first, paged by id, with actor names.

const { prisma } = require("@config/connection");
const { Prisma } = require("@prisma/client");

const AREAS = ["general", "cutoff", "notifications", "check", "payroll", "profile", "leaveCredits"];

// Display names for the history view, so the client doesn't invent its own.
const FIELD_LABELS = {
  // general (PATCH /api/company-settings)
  defaultShiftHours:            "Default shift hours",
  minimumLunchMinutes:          "Minimum lunch (min)",
  gracePeriodMinutes:           "Grace period (min)",
  otBasis:                      "Overtime basis",
  dailyOtThresholdHours:        "Daily OT threshold (h)",
  weeklyOtThresholdHours:       "Weekly OT threshold (h)",
  cutoffOtThresholdHours:       "Cutoff OT threshold (h)",
  country:                      "Country",
  currency:                     "Currency",
  language:                     "Language",
  timeZone:                     "Time zone",
  driverAideThresholdMinutes:   "Driver/Aide threshold (min)",
  shiftAssignmentWindowMinutes: "Shift assignment window (min)",
  earlyClockInGraceMinutes:     "Early clock-in grace (min)",
  earlyClockOutGraceMinutes:    "Early clock-out grace (min)",
  autoClockOutWarningHours:     "Auto clock-out warning (h)",
  autoClockOutGraceHours:       "Auto clock-out grace (h)",
  autoClockOutNotifyEmails:     "Auto clock-out notify emails",
  multiApprovalEnabled:         "Multi-level approval",
  secondaryApproverId:          "Secondary approver",
  leaveConflictAutoRevert:      "Leave conflict auto-revert",
  autoBreakBasis:               "Auto-break basis",
  autoLunchEnabled:             "Auto lunch",
  autoCoffeeEnabled:            "Auto coffee break",
  ettEnabled:                   "Employer ETT",
  suiEnabled:                   "Employer SUI",
  cutoffPageView:               "Cutoff page type",
  taskReportEnabled:            "Clock-out documentation",
  taskReportMode:               "Documentation mode",
  taskReportFormWindowHours:    "Questionnaire answer window (h)",
  taskReportFaceCapture:        "Face capture at clock-out",
  taskReportFaceCaptureClockIn: "Face capture at clock-in",
  punchDeviceProofEnabled:      "Punch device proof",
  breadcrumbsEnabled:           "GPS breadcrumbs",
  breadcrumbIntervalMinutes:    "Breadcrumb interval (min)",
  // leave credits (settings page or leave credit setup)
  leaveGrantEnabled:            "Leave grants",
  leaveGrantMode:               "Leave grant mode",
  leaveGrantHours:              "Leave grant hours",
  leaveYearStartMonth:          "Leave year start month",
  leaveYearStartDay:            "Leave year start day",
  leaveExpirationEnabled:       "Leave expiration",
  leaveCreditLifetimeYears:     "Leave credit lifetime (years)",
  leaveExpiryReminderDays:      "Leave expiry reminder (days)",
  leaveRegularizationMonths:    "Regularization (months)",
  leaveRegularizationGrant:     "Regularization grant",
  leaveCreditsInitializedAt:    "Leave credits set up on",
  // cutoff
  seedStartDate:                "Cutoff seed start date",
  durationDays:                 "Cutoff length (days)",
  paymentOffsetDays:            "Payment offset (days)",
  // notifications
  clockInGracePeriod:           "Missed clock-in alert after (min)",
  clockOutGracePeriod:          "Missed clock-out alert after (min)",
  notifyEmployeeMissedIn:       "Notify employee: missed clock-in",
  notifyEmployeeMissedOut:      "Notify employee: missed clock-out",
  notifyAdminMissedClocks:      "Notify admins: missed clocks",
  morningReportTime:            "Morning report time",
  eveningReportTime:            "Evening report time",
  // check printing
  checkTemplate:                "Check template",
  checkPositions:               "Check print positions",
  // payroll config
  payFrequency:                 "Pay frequency",
  ptoEnabled:                   "PTO",
  ptoLabel:                     "PTO label",
  futaEnabled:                  "FUTA",
  sutaEnabled:                  "SUTA",
  futaRate:                     "FUTA rate",
  ficaRate:                     "FICA rate",
  medicareRate:                 "Medicare rate",
  sdiRate:                      "SDI rate",
  // company profile
  name:                         "Company name",
  dba:                          "DBA",
  ein:                          "EIN",
  stateTaxIds:                  "State tax IDs",
  addressLine1:                 "Address line 1",
  addressLine2:                 "Address line 2",
  city:                         "City",
  state:                        "State",
  postalCode:                   "Postal code",
  phoneNumber:                  "Phone number",
  businessEmail:                "Business email",
  websiteUrl:                   "Website",
};

const labelFor = (field) => FIELD_LABELS[field] || field;

/** Plain JSON value for storing and comparing (Decimal → number, Date → ISO string). */
function normalize(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Prisma.Decimal.isDecimal(v)) return Number(v.toString());
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Fields that changed between two snapshots.
 * @param {object|null} before
 * @param {object|null} after
 * @param {string[]} [fields] defaults to every key of `after`
 * @returns {Array<{ field, from, to }>}
 */
function diffSettings(before, after, fields) {
  const b = before || {};
  const a = after || {};
  const keys = fields || Object.keys(a);
  const changes = [];
  for (const field of keys) {
    if (field === "id" || field === "companyId") continue;
    const from = normalize(b[field]);
    const to = normalize(a[field]);
    if (!same(from, to)) changes.push({ field, from, to });
  }
  return changes;
}

/** req.ip honours app's "trust proxy" setting (same as utils/punchDeviceProof). */
const clientIp = (req) => req?.ip || req?.socket?.remoteAddress || null;

/** One history row. Logged, never throws. Nothing written when nothing changed. */
async function recordSettingsChange({ companyId, area, changes, actor, ip = null }) {
  if (!companyId || !changes?.length) return;
  try {
    await prisma.$executeRaw`
      INSERT INTO "CompanySettingsEvent" ("companyId", "area", "changes", "actorId", "agentId", "ip")
      VALUES (${companyId}, ${area}, ${JSON.stringify(changes)}::jsonb, ${actor?.id || null}, ${actor?.agentId || null}, ${ip})`;
  } catch (err) {
    // Table not created yet (SQL not run) or any DB hiccup: the save itself already succeeded.
    console.error("[BB-151] company settings change not recorded:", err.message);
  }
}

/** Diff two snapshots and record them for the signed-in user of `req`. */
async function recordDiff({ req, companyId, area, before, after, fields }) {
  try {
    const changes = diffSettings(before, after, fields);
    await recordSettingsChange({ companyId, area, changes, actor: req?.user, ip: clientIp(req) });
  } catch (err) {
    console.error("[BB-151] company settings diff failed:", err.message);
  }
}

/**
 * History for one company, newest first.
 * @param {string} companyId
 * @param {{ from?: string, to?: string, area?: string, field?: string, actorId?: string, limit?: number, cursor?: string }} opts
 *   from/to: ISO dates or timestamps (to is inclusive when a plain date is given);
 *   cursor: the `nextCursor` of the previous page.
 * @returns {Promise<{ items: object[], nextCursor: string|null, available: boolean }>}
 */
async function listHistory(companyId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 100);
  const where = [Prisma.sql`e."companyId" = ${companyId}`];

  if (opts.from) where.push(Prisma.sql`e."createdAt" >= ${new Date(opts.from)}`);
  if (opts.to) {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(opts.to)
      ? new Date(new Date(`${opts.to}T00:00:00Z`).getTime() + 24 * 3600 * 1000)
      : new Date(opts.to);
    where.push(Prisma.sql`e."createdAt" < ${to}`);
  }
  if (opts.area) where.push(Prisma.sql`e."area" = ${opts.area}`);
  if (opts.actorId) where.push(Prisma.sql`e."actorId" = ${opts.actorId}`);
  if (opts.field) where.push(Prisma.sql`e."changes" @> ${JSON.stringify([{ field: opts.field }])}::jsonb`);
  if (opts.cursor && /^\d+$/.test(String(opts.cursor))) where.push(Prisma.sql`e."id" < ${BigInt(opts.cursor)}`);

  let rows;
  try {
    rows = await prisma.$queryRaw`
      SELECT e."id", e."area", e."changes", e."actorId", e."agentId", e."createdAt",
             p."firstName", p."lastName", u."email", u."role", u."isSystemAgent",
             sa."code" AS "agentCode"
      FROM "CompanySettingsEvent" e
      LEFT JOIN "User" u ON u."id" = e."actorId"
      LEFT JOIN "UserProfile" p ON p."userId" = u."id"
      LEFT JOIN "SupportAgent" sa ON sa."id" = e."agentId"
      WHERE ${Prisma.join(where, " AND ")}
      ORDER BY e."id" DESC
      LIMIT ${limit + 1}`;
  } catch (err) {
    // Table not created yet (SQL not run): empty history, nothing else breaks.
    console.error("[BB-151] company settings history unavailable:", err.message);
    return { items: [], nextCursor: null, available: false };
  }

  const page = rows.slice(0, limit);
  const items = page.map((r) => {
    const changes = Array.isArray(r.changes) ? r.changes : [];
    // BB-151 follow-up: support rows read "B. Buddy (123)" — last 3 characters
    // of the staff code only (the code is half of the B. Buddy sign-in).
    const supportCode = r.isSystemAgent && r.agentCode ? String(r.agentCode).slice(-3) : null;
    const name = r.isSystemAgent
      ? (supportCode ? `B. Buddy (${supportCode})` : "B. Buddy")
      : `${r.firstName || ""} ${r.lastName || ""}`.trim() || r.email || null;
    return {
      id: String(r.id),
      at: r.createdAt,
      area: r.area,
      by: r.actorId ? { id: r.actorId, name, role: r.role || null } : null,
      bySupport: !!r.isSystemAgent, // B. Buddy (support staff id stays in the table)
      supportCode,
      changes: changes.map((c) => ({ ...c, label: labelFor(c.field) })),
    };
  });

  return {
    items,
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
    available: true,
  };
}

module.exports = {
  AREAS,
  FIELD_LABELS,
  labelFor,
  diffSettings,
  recordSettingsChange,
  recordDiff,
  listHistory,
};
