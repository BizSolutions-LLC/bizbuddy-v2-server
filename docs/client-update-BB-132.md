# Client update: BB-132 Subscription Plans (System Admin Dashboard)

**Server version:** next release (planned v2.11.15). **System Admin Dashboard only.** The company web app and mobile app are not affected.

## What changed on the server
There are two new **read-only** endpoints under `/api/system-admin`. Any signed-in system admin can call them (same cookie or Bearer token as the other System Admin pages). Nothing existing changed:
- `GET /api/system-admin/subscription-plans` (the "Add company" dropdown) keeps its current shape.
- There is no create, edit or delete from System Admin. This ticket is a showcase only.

Counting rules (the same on both endpoints):
- Only **active** subscriptions count. A company is counted once, under its latest active plan.
- **Retired** means the company is deactivated (`Company.isActive = false`). Retired companies are counted separately, never in `active`.
- `activeEmployees` counts **active human users** of the plan's active companies. The hidden B. Buddy accounts are excluded.
- `price` is a number (e.g. `25.99`). `features` is the plan's raw JSON object (e.g. `{ "leaves": true, "payroll": false, ... }`).

---

### 1. Plans overview
```http
GET /api/system-admin/subscription-plans/overview
```
```json
{
  "success": true,
  "data": {
    "plans": [
      {
        "id": "cll9abc201",
        "name": "Free",
        "rangeOfUsers": "1",
        "price": 0,
        "description": "A great way to explore BizBuddy ...",
        "features": { "leaves": false, "payroll": false, "timekeeping": true, "timekeeping-punch-offline": false },
        "createdAt": "2025-02-26T12:55:01.000Z",
        "updatedAt": "2025-02-26T12:55:01.000Z",
        "companies": { "active": 3, "retired": 1 },
        "activeEmployees": 3
      }
    ],
    "totals": {
      "plans": 6,
      "subscribedCompanies": 14,
      "retiredCompanies": 4,
      "companiesWithoutPlan": 2,
      "estimatedMonthly": 311.88
    },
    "featureKeys": ["leaves", "payroll", "timekeeping", "timekeeping-punch-offline"]
  }
}
```
- `plans` is sorted by price (lowest first), then by name.
- `totals.subscribedCompanies`: active companies with an active plan.
- `totals.companiesWithoutPlan`: active companies with no active plan.
- `totals.estimatedMonthly`: each plan's price × its active companies. **Label it as an estimate.** Nothing is billed through BizBuddy.
- `featureKeys`: every feature key used by any plan, sorted. Use it for the comparison table's rows so no key is hard-coded. A plan missing a key = not included.

### 2. One plan + its companies
```http
GET /api/system-admin/subscription-plans/:id
GET /api/system-admin/subscription-plans/:id?includeRetired=true
```
```json
{
  "success": true,
  "data": {
    "id": "cll9abc202",
    "name": "Basic",
    "rangeOfUsers": "2-9",
    "price": 25.99,
    "description": "...",
    "features": { "leaves": true, "payroll": true, "timekeeping": true, "timekeeping-punch-offline": false },
    "createdAt": "...",
    "updatedAt": "...",
    "companies": { "active": 5, "retired": 2 },
    "activeEmployees": 31,
    "companyList": [
      { "id": "...", "name": "Acme LLC", "isActive": true, "subscribedAt": "2026-03-01T00:00:00.000Z", "endDate": null, "activeEmployees": 7 },
      { "id": "...", "name": "Old Co", "isActive": false, "subscribedAt": "...", "endDate": null, "activeEmployees": null }
    ]
  }
}
```
- `companyList` lists active companies first, then by name. Retired companies appear only with `?includeRetired=true` (`activeEmployees: null` for them). `companies.retired` always has their count, so you can show a "Show N retired" toggle.
- **404** `{ "success": false, "message": "Subscription plan not found." }` for an unknown id.
- **401** without a valid system-admin session (same as the other pages).

---

## UI to build (suggestion)
1. **New System Admin page "Subscription Plans"** (sidebar, next to the Companies / Database pages).
2. **Summary row** from `totals`: Plans, Subscribed companies, Companies without a plan, Retired, Estimated monthly (with an "estimate" hint).
3. **Plan cards** from `plans`: name, user range, price/month, description, active companies (+ retired in muted text) and active employees.
4. **Feature comparison table**: one row per `featureKeys` entry, one column per plan, ✓ / ✗ from `features[key] === true`. Show keys in a readable form (e.g. `timekeeping-punch-offline` → "Timekeeping: punch offline").
5. **Plan detail** (card click → drawer or page): `GET /subscription-plans/:id`, a company table (name, subscribed since, active employees, Retired badge), and a "Show retired" toggle that refetches with `?includeRetired=true`.

Read-only: no edit, delete or "change plan" buttons on this page.
