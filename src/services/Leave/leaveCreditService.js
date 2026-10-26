// src/services/Leave/leaveCreditService.js
//
// BB-098 — Leave credits as fiscal-year lots: grants, regularization,
// oldest-first usage, and expiration.
//
// Model:
//   - LeaveBalance.balanceHours stays the running total every existing screen
//     reads. Once a company is initialized (Company.leaveCreditsInitializedAt,
//     set by the preview → apply step), every balance write also maintains
//     LeaveCredit lots — one per employee × leave type × fiscal year.
//   - Invariant: balanceHours = sum(lots.remainingHours) − debt, where debt is
//     a negative balance (policy.negativeAllowed) and only exists while every
//     lot is empty. So: usage drains lots oldest-first and anything beyond
//     becomes debt; a credit pays off debt first and only the rest lands in a
//     lot.
//   - Before initialization nothing here runs and the leave module behaves
//     exactly as it did before BB-098.
//
// Settings live on Company and are company-wide (applied to every leave type):
//   leaveGrantEnabled / leaveGrantMode / leaveGrantHours
//   leaveYearStartMonth / leaveYearStartDay           (fiscal year start)
//   leaveExpirationEnabled / leaveCreditLifetimeYears / leaveExpiryReminderDays
//   leaveRegularizationMonths / leaveRegularizationGrant
//
// Dates: all "today" / fiscal-year logic runs on YYYY-MM-DD strings in the
// company timezone. LeaveCredit.expiresOn is a plain @db.Date column — read it
// with toISOString().slice(0, 10), never through moment.tz().

const { prisma } = require("@config/connection");
const moment = require("moment-timezone");
const { createNotification } = require("@services/notificationService");

const DEFAULT_TZ = "America/Los_Angeles";

// Company fields every function here needs. Keep in sync with the columns
// added by scripts/add-bb098-leave-credit-expiration.sql.
const COMPANY_CREDIT_SELECT = {
  id:                        true,
  timeZone:                  true,
  leaveGrantEnabled:         true,
  leaveGrantMode:            true,
  leaveGrantHours:           true,
  leaveYearStartMonth:       true,
  leaveYearStartDay:         true,
  leaveExpirationEnabled:    true,
  leaveCreditLifetimeYears:  true,
  leaveExpiryReminderDays:   true,
  leaveRegularizationMonths: true,
  leaveRegularizationGrant:  true,
  leaveCreditsInitializedAt: true,
};

const GRANT_MODES = ["yearly_lump", "monthly_accrual"];
const REGULARIZATION_GRANTS_BY_MODE = {
  yearly_lump:     ["none", "prorated", "full"],
  monthly_accrual: ["none", "catch_up"],
};

const r2 = (n) => +Number(n).toFixed(2);
const num = (v) => (v == null ? 0 : Number(v));
const pad2 = (n) => String(n).padStart(2, "0");

// ── Fiscal-year math (pure) ─────────────────────────────────────────────────

const tzOf = (company) => company.timeZone || DEFAULT_TZ;
const todayStr = (company) => moment.tz(tzOf(company)).format("YYYY-MM-DD");
const toDateCol = (ymd) => new Date(`${ymd}T00:00:00.000Z`);
const dateColStr = (d) => d.toISOString().slice(0, 10);

function fyStartStr(company, fy) {
  return `${fy}-${pad2(company.leaveYearStartMonth)}-${pad2(company.leaveYearStartDay)}`;
}

// Last day of fiscal year `fy`.
function fyEndStr(company, fy) {
  return moment.utc(fyStartStr(company, fy + 1)).subtract(1, "day").format("YYYY-MM-DD");
}

// Fiscal year (identified by the calendar year it starts in) containing `ymd`.
function fiscalYearOf(company, ymd) {
  const year = Number(ymd.slice(0, 4));
  return ymd.slice(5) >= `${pad2(company.leaveYearStartMonth)}-${pad2(company.leaveYearStartDay)}`
    ? year
    : year - 1;
}

function fyLabel(company, fy) {
  return company.leaveYearStartMonth === 1 && company.leaveYearStartDay === 1
    ? `FY${fy}`
    : `FY${fy}-${pad2((fy + 1) % 100)}`;
}

// Last usable day of credits granted in fiscal year `fy`.
function expiresOnStr(company, fy) {
  return fyEndStr(company, fy + company.leaveCreditLifetimeYears - 1);
}

// User.hireDate is a Timestamptz written from a client date string, so it is
// usually midnight UTC — read that as the calendar date it names. Anything
// else is a real instant: take its date in the company timezone.
function hireDateStr(company, hireDate) {
  if (!hireDate) return null;
  const d = new Date(hireDate);
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : moment.tz(d, tzOf(company)).format("YYYY-MM-DD");
}

// Regularization date, or null when it can't be evaluated (waiting period
// configured but no hire date). No waiting period and no hire date = treated
// as regular from the start.
function regularizationDateStr(company, hireDate) {
  const hire = hireDateStr(company, hireDate);
  const months = company.leaveRegularizationMonths || 0;
  if (!hire) return months > 0 ? null : "0000-01-01";
  return moment.utc(hire).add(months, "months").format("YYYY-MM-DD");
}

// Idempotency key for the automatic grant covering `ymd`.
function grantPeriodKey(company, ymd) {
  return company.leaveGrantMode === "monthly_accrual"
    ? ymd.slice(0, 7)
    : `FY${fiscalYearOf(company, ymd)}`;
}

// True when the last grant key covers `key` — the same period or a later one,
// so a balance marked "2026-12" isn't granted October or November. Keys of
// the other mode ("FY2026" vs "2026-11") don't compare and never cover.
function periodCovered(last, key) {
  if (!last || last.startsWith("FY") !== key.startsWith("FY")) return false;
  return last >= key;
}

// Monthly accrual share for the month containing `ymd`. Rounds cumulatively
// (k/12 of the grant minus (k−1)/12) so twelve months add up to exactly
// leaveGrantHours instead of drifting by a few hundredths.
function monthlyShare(company, ymd) {
  const grant = num(company.leaveGrantHours);
  const fy = fiscalYearOf(company, ymd);
  const k = Math.min(12, moment.utc(ymd).diff(moment.utc(fyStartStr(company, fy)), "months") + 1);
  return r2(r2((grant * k) / 12) - r2((grant * (k - 1)) / 12));
}

// Hours granted on the regularization date, per company rule.
function regularizationHours(company, regStr) {
  const grant = num(company.leaveGrantHours);
  const rule = company.leaveRegularizationGrant;
  if (company.leaveGrantMode === "monthly_accrual") {
    return rule === "catch_up" ? r2((grant / 12) * (company.leaveRegularizationMonths || 0)) : 0;
  }
  if (rule === "full") return r2(grant);
  if (rule === "prorated") {
    // Months left in the fiscal year from the regularization date, a partial
    // month counting as a full one.
    const nextFyStart = fyStartStr(company, fiscalYearOf(company, regStr) + 1);
    const monthsLeft = Math.min(12, Math.max(0, Math.ceil(moment.utc(nextFyStart).diff(moment.utc(regStr), "months", true))));
    return r2((grant * monthsLeft) / 12);
  }
  return 0;
}

// Splits an opening balance into fiscal-year chunks of leaveGrantHours,
// newest first: the first chunk is the current FY, the next the previous FY,
// and so on. Same rule as scripts/check-bb098-padpro-leave-balances.js.
function splitOpeningBalance(company, balance, currentFy) {
  const size = num(company.leaveGrantHours);
  const chunks = [];
  let left = r2(balance);
  let fy = currentFy;
  while (left > 0 && size > 0) {
    const hours = r2(Math.min(size, left));
    chunks.push({ fiscalYear: fy, hours });
    left = r2(left - hours);
    fy -= 1;
  }
  return chunks;
}

// ── Settings validation (shared by company settings PATCH, preview, apply) ──

// Merges `input` over `company` and validates the result. Returns
// { settings, errors } — `settings` holds only the leave-credit fields.
function normalizeCreditSettings(input, company) {
  const errors = [];
  const pick = (key) => (input[key] !== undefined ? input[key] : company[key]);
  const intIn = (key, min, max) => {
    const v = Number(pick(key));
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${key} must be a whole number from ${min} to ${max}`);
    return v;
  };

  const settings = {
    leaveGrantMode:            pick("leaveGrantMode"),
    leaveGrantHours:           Number(pick("leaveGrantHours")),
    leaveYearStartMonth:       intIn("leaveYearStartMonth", 1, 12),
    leaveYearStartDay:         intIn("leaveYearStartDay", 1, 28),
    leaveCreditLifetimeYears:  intIn("leaveCreditLifetimeYears", 1, 10),
    leaveExpiryReminderDays:   intIn("leaveExpiryReminderDays", 0, 365),
    leaveRegularizationMonths: intIn("leaveRegularizationMonths", 0, 60),
    leaveRegularizationGrant:  pick("leaveRegularizationGrant"),
  };

  if (!GRANT_MODES.includes(settings.leaveGrantMode))
    errors.push(`leaveGrantMode must be one of: ${GRANT_MODES.join(", ")}`);
  if (!Number.isFinite(settings.leaveGrantHours) || settings.leaveGrantHours <= 0 || settings.leaveGrantHours > 9999)
    errors.push("leaveGrantHours must be greater than 0");
  const allowed = REGULARIZATION_GRANTS_BY_MODE[settings.leaveGrantMode] || [];
  if (!allowed.includes(settings.leaveRegularizationGrant))
    errors.push(`leaveRegularizationGrant must be one of: ${allowed.join(", ")} for ${settings.leaveGrantMode}`);

  // Fiscal-year boundaries are baked into existing lots — changing them after
  // setup would mislabel every lot already created.
  if (
    company.leaveCreditsInitializedAt &&
    (settings.leaveYearStartMonth !== company.leaveYearStartMonth ||
      settings.leaveYearStartDay !== company.leaveYearStartDay)
  )
    errors.push("The fiscal year start can't be changed after leave credits have been set up");
  // Yearly and monthly grants track "already granted" with different period
  // keys ("FY2026" vs "2026-11"), so switching mid-stream would grant twice.
  if (company.leaveCreditsInitializedAt && settings.leaveGrantMode !== company.leaveGrantMode)
    errors.push("The grant mode can't be changed after leave credits have been set up");

  return { settings, errors };
}

async function loadCreditCompany(db, companyId) {
  return db.company.findUnique({ where: { id: companyId }, select: COMPANY_CREDIT_SELECT });
}

async function loadCreditCompanyForPolicy(db, policyId) {
  const policy = await db.leavePolicy.findUnique({
    where:  { id: policyId },
    select: { company: { select: COMPANY_CREDIT_SELECT } },
  });
  return policy?.company ?? null;
}

const isTracked = (company) => Boolean(company?.leaveCreditsInitializedAt);

// ── Lot operations (call inside a $transaction; balance + ledger stay with the caller) ──

// Puts newly credited hours into the fiscal-year lot. Debt (negative
// balanceBefore) is paid off first; only the remainder lands in a lot.
async function addToLots(tx, company, { userId, policyId, hours, balanceBefore, fiscalYear }) {
  const debt = Math.max(0, -num(balanceBefore));
  const lotHours = r2(Math.max(0, hours - debt));
  if (lotHours <= 0) return 0;

  const fy = fiscalYear ?? fiscalYearOf(company, todayStr(company));
  await tx.leaveCredit.upsert({
    where:  { userId_policyId_fiscalYear: { userId, policyId, fiscalYear: fy } },
    update: { grantedHours: { increment: lotHours }, remainingHours: { increment: lotHours } },
    create: {
      userId,
      policyId,
      fiscalYear:     fy,
      grantedHours:   lotHours,
      remainingHours: lotHours,
      expiresOn:      toDateCol(expiresOnStr(company, fy)),
    },
  });
  return lotHours;
}

// Drains `hours` from the employee's lots, oldest fiscal year first. Anything
// beyond what the lots hold is debt (the caller's balance already reflects
// it). With a leaveId, records which lots were used so a cancellation can put
// the hours back where they came from.
async function consumeFromLots(tx, { userId, policyId, hours, leaveId = null }) {
  let left = r2(hours);
  if (left <= 0) return 0;

  const lots = await tx.leaveCredit.findMany({
    where:   { userId, policyId, remainingHours: { gt: 0 } },
    orderBy: { fiscalYear: "asc" },
  });

  let consumed = 0;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = r2(Math.min(num(lot.remainingHours), left));
    await tx.leaveCredit.update({
      where: { id: lot.id },
      data:  { remainingHours: { decrement: take } },
    });
    if (leaveId) {
      await tx.leaveCreditUsage.create({ data: { leaveId, creditId: lot.id, hours: take } });
    }
    left = r2(left - take);
    consumed = r2(consumed + take);
  }
  return consumed;
}

// Reverses a leave's consumption. Debt is paid off first (mirrors addToLots),
// then hours go back to the exact lots the leave used — even an expired one;
// the expiration job removes those again on its next run with its own ledger
// row. Anything left over (legacy leave approved before setup, so no usage
// rows) goes into the current fiscal year's lot.
async function restoreToLots(tx, company, { userId, policyId, hours, balanceBefore, leaveId }) {
  const debt = Math.max(0, -num(balanceBefore));
  let left = r2(Math.max(0, hours - debt));

  const usages = await tx.leaveCreditUsage.findMany({
    where:   { leaveId, credit: { userId, policyId } },
    orderBy: { createdAt: "asc" },
  });
  for (const u of usages) {
    const back = r2(Math.min(num(u.hours), left));
    if (back > 0) {
      await tx.leaveCredit.update({
        where: { id: u.creditId },
        data:  { remainingHours: { increment: back } },
      });
      left = r2(left - back);
    }
  }
  if (usages.length) {
    await tx.leaveCreditUsage.deleteMany({ where: { id: { in: usages.map((u) => u.id) } } });
  }
  if (left > 0) {
    await addToLots(tx, company, { userId, policyId, hours: left, balanceBefore: 0 });
  }
}

// Credits hours end-to-end: balance + lot + ledger. Used by automatic grants.
async function grantHours(tx, company, { userId, policyId, hours, fiscalYear, note }) {
  const bal = await tx.leaveBalance.update({
    where: { userId_policyId: { userId, policyId } },
    data:  { balanceHours: { increment: hours }, lastAccrualAt: new Date() },
  });
  const balanceAfter = num(bal.balanceHours);
  const balanceBefore = r2(balanceAfter - hours);
  await addToLots(tx, company, { userId, policyId, hours, balanceBefore, fiscalYear });
  await tx.leaveTransaction.create({
    data: { userId, policyId, type: "accrual", hours, balanceBefore, balanceAfter, note },
  });
}

// ── Expiration ──────────────────────────────────────────────────────────────

// Expires one lot that's past its last usable day: zeroes it, takes the hours
// off the balance, and writes an `expired` ledger row. Claims the lot by its
// current remainingHours so two concurrent runs can't expire it twice.
async function expireLot(tx, company, lot, note) {
  const hours = num(lot.remainingHours);
  if (hours <= 0) return 0;

  const claim = await tx.leaveCredit.updateMany({
    where: { id: lot.id, remainingHours: lot.remainingHours },
    data:  { remainingHours: 0, expiredHours: { increment: hours }, expiredAt: new Date() },
  });
  if (claim.count === 0) return 0;

  const bal = await tx.leaveBalance.update({
    where: { userId_policyId: { userId: lot.userId, policyId: lot.policyId } },
    data:  { balanceHours: { decrement: hours } },
  });
  const balanceAfter = num(bal.balanceHours);
  await tx.leaveTransaction.create({
    data: {
      userId:        lot.userId,
      policyId:      lot.policyId,
      type:          "expired",
      hours:         -hours,
      balanceBefore: r2(balanceAfter + hours),
      balanceAfter,
      note: note ?? `Expired — ${fyLabel(company, lot.fiscalYear)} credits (usable through ${dateColStr(lot.expiresOn)})`,
    },
  });
  return hours;
}

async function expireDueCredits(company) {
  const today = todayStr(company);
  const lots = await prisma.leaveCredit.findMany({
    where: {
      policy:         { companyId: company.id },
      remainingHours: { gt: 0 },
      expiresOn:      { lt: toDateCol(today) },
    },
  });
  let total = 0;
  for (const lot of lots) {
    total += await prisma.$transaction((tx) => expireLot(tx, company, lot));
  }
  return { lots: lots.length, hours: r2(total) };
}

// Notifies each employee once per lot when it enters the reminder window.
async function sendExpiryReminders(company) {
  const days = company.leaveExpiryReminderDays || 0;
  if (days <= 0) return 0;

  const today = todayStr(company);
  const horizon = moment.utc(today).add(days, "days").format("YYYY-MM-DD");
  const lots = await prisma.leaveCredit.findMany({
    where: {
      policy:         { companyId: company.id },
      user:           { status: "active" },
      remainingHours: { gt: 0 },
      reminderSentAt: null,
      expiresOn:      { gte: toDateCol(today), lte: toDateCol(horizon) },
    },
    include: {
      policy: { select: { leaveType: true } },
      user:   { select: { departmentId: true } },
    },
  });

  let sent = 0;
  for (const lot of lots) {
    const claim = await prisma.leaveCredit.updateMany({
      where: { id: lot.id, reminderSentAt: null },
      data:  { reminderSentAt: new Date() },
    });
    if (claim.count === 0) continue;

    const hours = r2(num(lot.remainingHours));
    const expiresOn = dateColStr(lot.expiresOn);
    try {
      await createNotification({
        userId:           lot.userId,
        companyId:        company.id,
        departmentId:     lot.user?.departmentId ?? null,
        notificationCode: "LEAVE_CREDITS_EXPIRING",
        title:            "Leave Credits Expiring",
        message:          `${hours}h of your ${lot.policy.leaveType} credits will expire after ${moment.utc(expiresOn).format("MMM D, YYYY")}. Use them before then.`,
        payload: {
          creditId:   lot.id,
          policyId:   lot.policyId,
          leaveType:  lot.policy.leaveType,
          fiscalYear: lot.fiscalYear,
          hours,
          expiresOn,
        },
      });
      sent += 1;
    } catch (err) {
      console.error(`[LeaveCredits] Reminder failed for credit ${lot.id}:`, err);
    }
  }
  return sent;
}

// ── Grants (automatic + regularization) ─────────────────────────────────────

// Active employees × active leave types they're eligible for.
async function eligiblePairs(db, companyId) {
  const [policies, employees] = await Promise.all([
    db.leavePolicy.findMany({
      where:  { companyId, isArchived: false },
      select: { id: true, leaveType: true, assignedToAll: true, assignments: { select: { userId: true } } },
    }),
    db.user.findMany({
      where:  { companyId, status: "active" },
      select: { id: true, hireDate: true },
    }),
  ]);
  const pairs = [];
  for (const p of policies) {
    const assigned = new Set(p.assignments.map((a) => a.userId));
    for (const e of employees) {
      if (p.assignedToAll || assigned.has(e.id)) pairs.push({ policy: p, employee: e });
    }
  }
  return pairs;
}

async function runGrants(company) {
  const today = todayStr(company);
  const key = grantPeriodKey(company, today);
  const currentFy = fiscalYearOf(company, today);
  const initStr = moment.tz(company.leaveCreditsInitializedAt, tzOf(company)).format("YYYY-MM-DD");
  const stats = { regular: 0, regularization: 0, skippedNoHireDate: 0 };

  for (const { policy, employee } of await eligiblePairs(prisma, company.id)) {
    const regStr = regularizationDateStr(company, employee.hireDate);
    if (regStr === null) { stats.skippedNoHireDate += 1; continue; }
    if (today < regStr) continue; // still in the waiting period

    await prisma.$transaction(async (tx) => {
      const bal = await tx.leaveBalance.upsert({
        where:  { userId_policyId: { userId: employee.id, policyId: policy.id } },
        update: {},
        create: { userId: employee.id, policyId: policy.id, balanceHours: 0 },
      });

      // Regularization grant — only for employees who reach their
      // regularization date after setup; everyone regular before setup
      // already has their credits in the opening balance.
      if (regStr >= initStr && !bal.regularizationGrantedAt) {
        const claim = await tx.leaveBalance.updateMany({
          where: { id: bal.id, regularizationGrantedAt: null },
          data:  { regularizationGrantedAt: new Date(), lastGrantPeriod: key },
        });
        if (claim.count === 0) return;
        const hours = regularizationHours(company, regStr);
        if (hours > 0) {
          await grantHours(tx, company, {
            userId:     employee.id,
            policyId:   policy.id,
            hours,
            fiscalYear: fiscalYearOf(company, regStr),
            note:       `Regularization grant (${company.leaveRegularizationGrant}) — regularized ${regStr}`,
          });
        }
        stats.regularization += 1;
        return;
      }

      if (periodCovered(bal.lastGrantPeriod, key)) return;
      const claim = await tx.leaveBalance.updateMany({
        where: { id: bal.id, lastGrantPeriod: bal.lastGrantPeriod },
        data:  { lastGrantPeriod: key },
      });
      if (claim.count === 0) return;

      const monthly = company.leaveGrantMode === "monthly_accrual";
      const hours = monthly ? monthlyShare(company, today) : r2(num(company.leaveGrantHours));
      if (hours <= 0) return;
      await grantHours(tx, company, {
        userId:     employee.id,
        policyId:   policy.id,
        hours,
        fiscalYear: currentFy,
        note: monthly
          ? `Monthly accrual — ${moment.utc(today).format("MMMM YYYY")} (${fyLabel(company, currentFy)})`
          : `Annual grant — ${fyLabel(company, currentFy)}`,
      });
      stats.regular += 1;
    });
  }
  return stats;
}

// One full cycle for a company: expire → remind → grant. Expiring first means
// a grant on the same day never mixes with credits that just lapsed.
async function runCompanyCycle(company) {
  const result = {};
  if (company.leaveExpirationEnabled) {
    result.expired = await expireDueCredits(company);
    result.remindersSent = await sendExpiryReminders(company);
  }
  if (company.leaveGrantEnabled) {
    result.grants = await runGrants(company);
  }
  return result;
}

// ── Setup preview / apply ───────────────────────────────────────────────────

const fullName = (u) =>
  `${u.profile?.firstName || ""} ${u.profile?.lastName || ""}`.trim() || u.email;

// Read-only. With `settings` merged over the company (what the admin is about
// to save), shows per employee × leave type how the balance splits into
// fiscal-year lots and what would expire immediately. Before setup the split
// is the opening-balance rule; after setup it's the real lots.
async function buildSetupPreview(company, settings, { expirationEnabled }) {
  const c = { ...company, ...settings };
  const today = todayStr(c);
  const currentFy = fiscalYearOf(c, today);
  const initialized = isTracked(company);

  const balances = await prisma.leaveBalance.findMany({
    where:   { policy: { companyId: c.id }, balanceHours: { not: 0 } },
    include: {
      policy: { select: { id: true, leaveType: true, isArchived: true } },
      user:   { select: { id: true, email: true, status: true, profile: { select: { firstName: true, lastName: true } } } },
    },
  });

  const lotsByBalance = {};
  if (initialized) {
    const lots = await prisma.leaveCredit.findMany({
      where:   { policy: { companyId: c.id }, remainingHours: { gt: 0 } },
      orderBy: { fiscalYear: "desc" },
    });
    for (const l of lots) {
      (lotsByBalance[`${l.userId}:${l.policyId}`] ??= []).push({
        fiscalYear: l.fiscalYear,
        hours:      r2(num(l.remainingHours)),
        expiresOn:  dateColStr(l.expiresOn),
      });
    }
  }

  const totals = { balanceHours: 0, expiringNowHours: 0, balanceAfterHours: 0 };
  const rows = balances
    .map((b) => {
      const balance = r2(num(b.balanceHours));
      const lots = initialized
        ? lotsByBalance[`${b.userId}:${b.policyId}`] ?? []
        : splitOpeningBalance(c, balance, currentFy).map((ch) => ({
            ...ch,
            expiresOn: expiresOnStr(c, ch.fiscalYear),
          }));
      const shaped = lots.map((l) => ({
        ...l,
        label:              fyLabel(c, l.fiscalYear),
        expiresImmediately: expirationEnabled && l.expiresOn < today,
      }));
      const expiringNowHours = r2(shaped.filter((l) => l.expiresImmediately).reduce((s, l) => s + l.hours, 0));
      const balanceAfterHours = r2(balance - expiringNowHours);
      if (b.user.status === "active") {
        totals.balanceHours += balance;
        totals.expiringNowHours += expiringNowHours;
        totals.balanceAfterHours += balanceAfterHours;
      }
      return {
        userId:     b.userId,
        name:       fullName(b.user),
        status:     b.user.status,
        policyId:   b.policyId,
        leaveType:  b.policy.leaveType,
        isArchived: b.policy.isArchived,
        balanceHours: balance,
        lots:       shaped,
        expiringNowHours,
        balanceAfterHours,
      };
    })
    .sort((a, b) => (a.status === "active") === (b.status === "active")
      ? a.name.localeCompare(b.name)
      : a.status === "active" ? -1 : 1);

  // Regularization status of every active employee.
  const employees = await prisma.user.findMany({
    where:  { companyId: c.id, status: "active" },
    select: { id: true, email: true, hireDate: true, profile: { select: { firstName: true, lastName: true } } },
  });
  const missingHireDate = [];
  const inWaitingPeriod = [];
  for (const e of employees) {
    const reg = regularizationDateStr(c, e.hireDate);
    if (reg === null) missingHireDate.push({ userId: e.id, name: fullName(e) });
    else if (today < reg) inWaitingPeriod.push({ userId: e.id, name: fullName(e), regularizationDate: reg });
  }

  return {
    initialized,
    today,
    currentFiscalYear: {
      fiscalYear: currentFy,
      label:      fyLabel(c, currentFy),
      startsOn:   fyStartStr(c, currentFy),
      endsOn:     fyEndStr(c, currentFy),
    },
    rows,
    totals: {
      activeEmployeesWithBalance: rows.filter((r) => r.status === "active").length,
      balanceHours:      r2(totals.balanceHours),
      expiringNowHours:  r2(totals.expiringNowHours),
      balanceAfterHours: r2(totals.balanceAfterHours),
    },
    regularization: { missingHireDate, inWaitingPeriod },
  };
}

// First-time setup: saves settings + toggles, converts every existing balance
// into fiscal-year lots (opening-balance rule), expires lots already past
// their lifetime when expiration is on, and marks the current grant period as
// already granted for every eligible employee — their current-year credits
// are part of the opening balance.
async function initializeCredits(company, settings, toggles) {
  const c = { ...company, ...settings };
  const today = todayStr(c);
  const currentFy = fiscalYearOf(c, today);
  const key = grantPeriodKey(c, today);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const claim = await tx.company.updateMany({
      where: { id: c.id, leaveCreditsInitializedAt: null },
      data:  { ...settings, ...toggles, leaveCreditsInitializedAt: now },
    });
    if (claim.count === 0) {
      const err = new Error("Leave credits were already set up for this company");
      err.status = 409;
      throw err;
    }
    const initialized = { ...c, ...toggles, leaveCreditsInitializedAt: now };

    const balances = await tx.leaveBalance.findMany({
      where: { policy: { companyId: c.id }, balanceHours: { gt: 0 } },
    });
    let expiredHours = 0;
    for (const b of balances) {
      for (const ch of splitOpeningBalance(c, num(b.balanceHours), currentFy)) {
        const lot = await tx.leaveCredit.create({
          data: {
            userId:         b.userId,
            policyId:       b.policyId,
            fiscalYear:     ch.fiscalYear,
            grantedHours:   ch.hours,
            remainingHours: ch.hours,
            expiresOn:      toDateCol(expiresOnStr(c, ch.fiscalYear)),
          },
        });
        if (toggles.leaveExpirationEnabled && dateColStr(lot.expiresOn) < today) {
          expiredHours += await expireLot(
            tx,
            initialized,
            lot,
            `Expired on leave credit setup — ${fyLabel(c, ch.fiscalYear)} credits (usable through ${dateColStr(lot.expiresOn)})`
          );
        }
      }
    }

    for (const { policy, employee } of await eligiblePairs(tx, c.id)) {
      await tx.leaveBalance.upsert({
        where:  { userId_policyId: { userId: employee.id, policyId: policy.id } },
        update: { lastGrantPeriod: key },
        create: { userId: employee.id, policyId: policy.id, balanceHours: 0, lastGrantPeriod: key },
      });
    }

    return { lotsCreatedFor: balances.length, expiredHours: r2(expiredHours) };
  }, { timeout: 120000, maxWait: 10000 });
}

module.exports = {
  COMPANY_CREDIT_SELECT,
  isTracked,
  loadCreditCompany,
  loadCreditCompanyForPolicy,
  normalizeCreditSettings,
  fiscalYearOf,
  fyLabel,
  fyStartStr,
  todayStr,
  dateColStr,
  addToLots,
  consumeFromLots,
  restoreToLots,
  expireDueCredits,
  runCompanyCycle,
  buildSetupPreview,
  initializeCredits,
};
