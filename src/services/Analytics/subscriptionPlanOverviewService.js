// src/services/Analytics/subscriptionPlanOverviewService.js
//
// BB-132: read-only subscription plan showcase for the system-admin dashboard.
// Every plan with its full details, plus which companies are on it.
// Only active Subscription rows count; "retired" = Company.isActive = false.
// Employee counts are human, active users only (B. Buddy agents excluded).

const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

const PLAN_SELECT = {
  id: true,
  name: true,
  rangeOfUsers: true,
  price: true,
  description: true,
  features: true,
  createdAt: true,
  updatedAt: true,
};

function toPlan(p) {
  return { ...p, price: p.price == null ? 0 : Number(p.price) };
}

/**
 * Active subscriptions, one per company (latest startDate wins if a company
 * somehow has more than one active row).
 */
async function activeSubscriptionsByCompany() {
  const subs = await prisma.subscription.findMany({
    where: { active: true },
    orderBy: { startDate: "desc" },
    select: {
      planId: true,
      startDate: true,
      endDate: true,
      company: { select: { id: true, name: true, isActive: true } },
    },
  });
  const byCompany = new Map();
  for (const s of subs) {
    if (!byCompany.has(s.company.id)) byCompany.set(s.company.id, s);
  }
  return byCompany;
}

/** Map companyId → count of active human users, for the given companies. */
async function activeEmployeeCounts(companyIds) {
  if (!companyIds.length) return new Map();
  const rows = await prisma.user.groupBy({
    by: ["companyId"],
    where: { ...HUMAN_ONLY, status: "active", companyId: { in: companyIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.companyId, r._count._all]));
}

/** GET /api/system-admin/subscription-plans/overview */
async function getOverview() {
  const [plans, byCompany, activeCompanyCount] = await Promise.all([
    prisma.subscriptionPlan.findMany({ orderBy: [{ price: "asc" }, { name: "asc" }], select: PLAN_SELECT }),
    activeSubscriptionsByCompany(),
    prisma.company.count({ where: { isActive: true } }),
  ]);

  const subs = [...byCompany.values()];
  const activeIds = subs.filter((s) => s.company.isActive).map((s) => s.company.id);
  const employees = await activeEmployeeCounts(activeIds);

  const stats = new Map(plans.map((p) => [p.id, { active: 0, retired: 0, activeEmployees: 0 }]));
  for (const s of subs) {
    const st = stats.get(s.planId);
    if (!st) continue;
    if (s.company.isActive) {
      st.active += 1;
      st.activeEmployees += employees.get(s.company.id) || 0;
    } else {
      st.retired += 1;
    }
  }

  const featureKeys = new Set();
  let estimatedMonthly = 0;
  let subscribedCompanies = 0;
  let retiredCompanies = 0;

  const planRows = plans.map((raw) => {
    const p = toPlan(raw);
    const st = stats.get(p.id);
    if (p.features && typeof p.features === "object" && !Array.isArray(p.features)) {
      Object.keys(p.features).forEach((k) => featureKeys.add(k));
    }
    estimatedMonthly += p.price * st.active;
    subscribedCompanies += st.active;
    retiredCompanies += st.retired;
    return {
      ...p,
      companies: { active: st.active, retired: st.retired },
      activeEmployees: st.activeEmployees,
    };
  });

  return {
    plans: planRows,
    totals: {
      plans: plans.length,
      subscribedCompanies,
      retiredCompanies,
      companiesWithoutPlan: Math.max(0, activeCompanyCount - subscribedCompanies),
      estimatedMonthly: Number(estimatedMonthly.toFixed(2)),
    },
    featureKeys: [...featureKeys].sort(),
  };
}

/**
 * GET /api/system-admin/subscription-plans/:id
 * Returns null when the plan doesn't exist.
 */
async function getPlanDetail(planId, { includeRetired = false } = {}) {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId }, select: PLAN_SELECT });
  if (!plan) return null;

  // Use the full set so a company with several active rows is only listed
  // under its latest plan, same as the overview.
  const byCompany = await activeSubscriptionsByCompany();
  const subs = [...byCompany.values()].filter((s) => s.planId === planId);

  const activeIds = subs.filter((s) => s.company.isActive).map((s) => s.company.id);
  const employees = await activeEmployeeCounts(activeIds);

  let active = 0;
  let retired = 0;
  let activeEmployees = 0;
  const companies = [];
  for (const s of subs) {
    if (s.company.isActive) {
      active += 1;
      activeEmployees += employees.get(s.company.id) || 0;
    } else {
      retired += 1;
      if (!includeRetired) continue;
    }
    companies.push({
      id: s.company.id,
      name: s.company.name,
      isActive: s.company.isActive,
      subscribedAt: s.startDate,
      endDate: s.endDate,
      activeEmployees: s.company.isActive ? employees.get(s.company.id) || 0 : null,
    });
  }

  companies.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    ...toPlan(plan),
    companies: { active, retired },
    activeEmployees,
    companyList: companies,
  };
}

module.exports = { getOverview, getPlanDetail };
