# BB-120: B. Buddy, remove access to payroll — client hand-off

B. Buddy (the support account, BB-110) no longer works with payroll. The server now refuses every payroll call from a B. Buddy session; the client should stop showing B. Buddy any way into payroll.

**Stays available to B. Buddy:** cutoff review (approve hours, lock / process a cutoff) and the hours reports, including the Punch Logs **Payroll Grid** and **Yearly Total Hours** (hours only, no money).

---

## Server (done)

A B. Buddy session gets **403** with `code: "SYSTEM_AGENT_NOT_ALLOWED"` and `message: "This action isn't available to the B. Buddy account."` on everything under:

- `/api/payroll-system` (payroll runs, import clock hours, payslip / check PDFs, payroll reports)
- `/api/company-information` (payroll config, earning / deduction types, tax rates)
- `/api/employee-payroll-details`
- `/api/payroll`
- `/api/disbursements`
- `/api/payroll-export` (including `/by-cutoff-period/:id`, used by the Employee Cutoff page)

`lib/systemAgent.js` → `getSystemAgentErrorMessage` already turns this code into "This action isn't available in support mode."

The setup guide (`GET /api/company-setup/checklist`) no longer includes the **"Set up payroll details"** step for B. Buddy, so the guide never links B. Buddy to payroll. Nothing to change on the client for this.

---

## What to change

1. **`components/Dashboard/sidebar.jsx` (~line 679):** B. Buddy gets no Payroll group.
   ```js
   // BB-120: B. Buddy has no payroll access (it kept Payroll Management under BB-110)
   const agentFeatures = [];
   ```
   The `features.length > 0 &&` check (~line 739) already hides the empty section.

2. **`lib/systemAgent.js`:** remove the payroll exception so the page redirects like other blocked pages.
   ```js
   // Admin tools that live under the Employee panel but are company-wide
   const ALLOWED_PREFIXES = [];   // BB-120: was ["/dashboard/employee/payroll"]
   ```
   Opening `/dashboard/employee/payroll` (bookmark, old link) as B. Buddy now goes to `SYSTEM_AGENT_HOME` like any other blocked page.

3. **Employee Cutoff page** (`components/Dashboard/DashboardContent/CompanyPanel/Punchlogs&Overtimes&Leaves/EmployeeCutoff.jsx`): hide the **"Preview Payroll Reports"** button (~line 743, the search icon next to Configure) for B. Buddy. Its dialog's View / Download buttons call `/api/payroll-export/…`, which now returns 403.
   ```jsx
   import { isSystemAgentToken } from "@/lib/systemAgent";
   // …
   const isSupport = isSystemAgentToken(token);
   // …
   {!isSupport && (
     <Button variant="outline" size="icon" title="Preview Payroll Reports" onClick={() => setIsReportPreviewOpen(true)}>
       <Search className="w-4 h-4" />
     </Button>
   )}
   ```
   Everything else on the page (review, approve, lock, process, Configure) stays.

---

## To test (signed in as B. Buddy)
- The sidebar has no **Payroll** group.
- Going to `/dashboard/employee/payroll` directly redirects to the Employees page.
- Employee Cutoff: no "Preview Payroll Reports" button; review, approve, lock and process still work.
- The setup guide has no payroll step.
- Punch Logs: PDF, Excel and Payroll Grid still download; Settings → Yearly Total Hours still downloads.
- A normal admin still sees and uses Payroll, Disbursement and the payroll preview exactly as before.
