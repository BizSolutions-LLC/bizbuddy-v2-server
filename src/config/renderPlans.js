// src/config/renderPlans.js
//
// BB-112: Render instance plans for the Performance page's upgrade advice.
// Codes, limits and monthly prices copied from the Render dashboard on 2026-10-29 —
// update these tables when Render changes them. The plans in use come from
// RENDER_WEB_PLAN / RENDER_DB_PLAN (Render's code, e.g. "0.5c-512mb").

const WEB_PLANS = [
  { code: "free", cpu: 0.1, ramMb: 512, monthly: 0 },
  { code: "0.5c-512mb", cpu: 0.5, ramMb: 512, monthly: 7 },
  { code: "1c-2g", cpu: 1, ramMb: 2048, monthly: 25 },
  { code: "2c-4g", cpu: 2, ramMb: 4096, monthly: 85 },
  { code: "2c-8g", cpu: 2, ramMb: 8192, monthly: 135 },
  { code: "4c-8g", cpu: 4, ramMb: 8192, monthly: 175 },
  { code: "2c-16g", cpu: 2, ramMb: 16384, monthly: 200 },
  { code: "4c-16g", cpu: 4, ramMb: 16384, monthly: 225 },
  { code: "8c-16g", cpu: 8, ramMb: 16384, monthly: 300 },
  { code: "4c-32g", cpu: 4, ramMb: 32768, monthly: 350 },
  { code: "8c-32g", cpu: 8, ramMb: 32768, monthly: 450 },
  { code: "12c-24g", cpu: 12, ramMb: 24576, monthly: 450 },
  { code: "12c-48g", cpu: 12, ramMb: 49152, monthly: 800 },
  { code: "8c-64g", cpu: 8, ramMb: 65536, monthly: 1000 },
  { code: "12c-96g", cpu: 12, ramMb: 98304, monthly: 1500 },
];

const DB_PLANS = [
  { code: "free", cpu: 0.1, ramMb: 256, monthly: 0 },
  { code: "0.1c-256mb", cpu: 0.1, ramMb: 256, monthly: 6 },
  { code: "0.5c-1g", cpu: 0.5, ramMb: 1024, monthly: 19 },
  { code: "1c-2g", cpu: 1, ramMb: 2048, monthly: 40 },
  { code: "1c-4g", cpu: 1, ramMb: 4096, monthly: 55 },
  { code: "2c-4g", cpu: 2, ramMb: 4096, monthly: 75 },
  { code: "2c-8g", cpu: 2, ramMb: 8192, monthly: 100 },
  { code: "2c-16g", cpu: 2, ramMb: 16384, monthly: 160 },
  { code: "4c-16g", cpu: 4, ramMb: 16384, monthly: 200 },
  { code: "4c-32g", cpu: 4, ramMb: 32768, monthly: 350 },
  { code: "8c-32g", cpu: 8, ramMb: 32768, monthly: 400 },
  { code: "8c-64g", cpu: 8, ramMb: 65536, monthly: 750 },
  { code: "16c-64g", cpu: 16, ramMb: 65536, monthly: 800 },
  { code: "16c-128g", cpu: 16, ramMb: 131072, monthly: 1500 },
  { code: "32c-128g", cpu: 32, ramMb: 131072, monthly: 1700 },
  { code: "32c-256g", cpu: 32, ramMb: 262144, monthly: 2500 },
  { code: "48c-192g", cpu: 48, ramMb: 196608, monthly: 2500 },
];

function findPlan(plans, code) {
  if (!code) return null;
  const wanted = String(code).trim().toLowerCase();
  return plans.find((p) => p.code === wanted) || null;
}

// Cheapest plan with more of `resource` ("cpu" | "ramMb") and no less of the other.
function nextPlan(plans, current, resource) {
  if (!current || !resource) return null;
  const other = resource === "cpu" ? "ramMb" : "cpu";
  return (
    plans
      .filter((p) => p[resource] > current[resource] && p[other] >= current[other] && p.monthly > current.monthly)
      .sort((a, b) => a.monthly - b.monthly || b[resource] - a[resource])[0] || null
  );
}

function currentPlans() {
  return {
    web: findPlan(WEB_PLANS, process.env.RENDER_WEB_PLAN),
    db: findPlan(DB_PLANS, process.env.RENDER_DB_PLAN),
  };
}

module.exports = { WEB_PLANS, DB_PLANS, findPlan, nextPlan, currentPlans };
