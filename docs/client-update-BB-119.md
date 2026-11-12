# BB-119: client hand-off

BB-119 moves every report onto one server-side template (PDFKit, US Letter), always in the **company's time zone**. Each change the client needs is added here as its own item.

---

## 1. Performance report: add a "View" button

**Where:** System Admin → Performance → Reports → Saved reports.

**Server:** no change. The same endpoint returns the redesigned PDF: `GET /api/system-admin/capacity/reports/:number/pdf` (0 = Baseline). It needs the system-admin Bearer token, the same as today.

**What to build**

1. **`lib/systemAdminFetch.js`:** add `systemAdminView(path)` next to `systemAdminDownload`.
   - **Open the tab first:** call `window.open("", "_blank")` straight away, before any `await`, so pop-up blockers allow it.
   - **Fetch the PDF:** fetch it with the Bearer token, the same way `systemAdminDownload` does. Use the same error handling: a 401 without a `code` clears the token and goes to sign-in, and any other error throws `SystemAdminError` with the server's `message`.
   - **On success:** `URL.createObjectURL(blob)`, then point the opened tab at that address (`tab.location.href = url`). Release the address after about a minute, not straight away, or the tab can't load it.
   - **If the tab was blocked** (`window.open` returned `null`): fall back to the normal download.
   - **If the fetch fails after the tab opened:** close the tab, then throw.
   - **Never put the token in a URL.**
2. **`components/system-admin/performance/ReportsView.jsx`:** add a **View** button before the existing **PDF** button in each row.
   - Use the `Eye` icon from lucide-react, `variant="outline" size="sm"`, and the label "View".
   - Show it as busy with `view:N`, the same way the PDF button uses `pdf:N`. Disable it while any action is busy.
   - Show errors the same way as the PDF button.
   - Keep the **PDF** button as it is. It still saves the file with its proper name (`bizbuddy-performance-…pdf`).

**Known limitation:** saving from the browser's PDF viewer gives the file a random name. The PDF button is the one to use for a named copy.

**To test**
- View opens the report in a new tab, for both the Baseline and a period.
- A partial ("to date") period opens too.
- With pop-ups blocked, it falls back to a download.
- An expired session sends the admin back to sign-in.
- The PDF button still downloads a file with the proper name.

---

## 2. Employees report: download from the server

**Where:** Company panel → Organizations & People → Employees, the **CSV** and **PDF** export buttons.

**Server (new):** `GET /api/reports/employees?format=pdf|csv`, with the normal Bearer token.
- **Who can call it:** admin and superadmin get the whole company. A **supervisor gets only their team**: their department plus their direct reports. Employees get 403.
- **What comes back:** the file, with its name in `Content-Disposition`, which the server already exposes through CORS. For example: `BizBuddy_Employees_Jhenelle_Villanueva_2026-11-10_14-05.pdf`. The time in the file name is in the company's time zone.
- **Errors:** JSON `{ message }`.
- **PDF:** US Letter landscape on the new template. It has a summary, by-department and by-role tables, and the employee list with an account status for each person.
- **CSV:** one header row plus data, with every field: email, exempt status, probation end date, driver, and last sign-in.

**What to change**
1. **`Employees.jsx`, `downloadCSV` and `downloadPDF`:** stop calling `exportEmployeesCSV` / `exportEmployeesPDF`.
   - Fetch `${API}/api/reports/employees?format=csv` (or `pdf`) with `Authorization: Bearer ${token}`.
   - If the response isn't OK, read the JSON and show `message` in the toast.
   - Otherwise read the file name from `Content-Disposition`, turn the blob into an object URL, and save it with a temporary `<a download>`. Keep the existing busy states (`exporting` / `pdfExporting`) and the success toast with the file name.
   - The "No data to export" check can stay.
2. **`lib/exports/employees.js`:** once nothing imports it, it can be deleted.

**Behaviour changes to know about**
- **Columns:** the export no longer follows the table's visible columns. The PDF has a fixed set of columns, and the CSV has every field.
- **Search:** the export still ignores the search box (same as today). It always covers the whole scope above.
- **Employee ID:** it now prints correctly. The old export read the wrong field and always showed "—".
- **Supervisors:** they now get their team only, where before they got the whole company.
- **Dates:** hire dates print as entered. Last sign-in and the generated time use the company's time zone, never the viewer's.

**Page fixes (follow-up)**
3. **Move the table controls out of the export bar.** **Rows per page** and the **column picker** ("6 selected") only change the on-screen table. They don't affect the export. Move both into the table's toolbar next to **Filters**, so the export bar keeps just **CSV**, **PDF** and the note "Exports include every employee you can see, with all fields".
4. **Fix the "Active Employees" card.** It counts full-time plus part-time employment (`employmentDetail.employmentStatus`), which is the employment type, not whether the account is active. Count `status === "active"` instead, so it matches the report's "Active accounts". If you want to keep the employment breakdown, show it as a sub-line, e.g. "X full-time · Y part-time".

**To test**
- **Admin:** PDF and CSV both download with the new names, the PDF shows the whole company, and the CSV opens cleanly in Excel or Sheets.
- **Controls:** changing rows per page, search, filters or visible columns doesn't change what the export contains.
- **Active Employees card:** shows the same number as "Active accounts" in the PDF.
- **Supervisor:** only their department and their direct reports appear.
- **Inactive employees:** they're listed with status "Inactive".

---

## 3. Departments report: download from the server

**Where:** Company panel → Organizations & People → Departments, the **CSV** and **PDF** export buttons.

**Server (new):** `GET /api/reports/departments?format=pdf|csv`, with the normal Bearer token. It works the same way as item 2.
- **Who can call it:** admin and superadmin get **every department**, whatever the search or supervisor filter says. A **supervisor gets only their own department**, and gets 403 "You aren't assigned to a department." if they have none. Employees get 403.
- **What comes back:** the file, with its name in `Content-Disposition`. For example: `BizBuddy_Departments_Jhenelle_Villanueva_2026-11-10_15-30.pdf`. The time in the file name is in the company's time zone.
- **Errors:** JSON `{ message }`.
- **PDF:** US Letter landscape. It has a summary, a departments table (supervisor, headcounts, created date), and a new **Time & pay settings** table. That table shows lunch paid, coffee breaks, auto lunch, auto coffee, fixed hours and cutoff schedule for each department.
- **CSV:** one row per department, with every field.

**What to change**
1. **`Departments.jsx`, the CSV and PDF export handlers:** stop calling `exportDepartmentsCSV` / `exportDepartmentsPDF`. Download from the endpoint the same way as item 2: Bearer token, JSON `message` on error, file name from `Content-Disposition`. Keep the existing busy states and toasts.
2. **`lib/exports/departments.js`:** once nothing imports it, it can be deleted.
3. **Same page fixes as item 2:** move the column picker and rows-per-page out of the export bar, if they're there, and keep the note "Exports include every department you can see, with all fields".
4. **Fix the member count** (the `userCounts` effect and the "Total Users" card).
   - **Today:** it adds 1 when the department's supervisor isn't a member, so the number isn't the real headcount.
   - **Change:** count only the employees assigned to the department, so it matches "Employees" in the report.

**Behaviour changes to know about**
- **Department ID:** it's gone. It was the internal system ID.
- **Members:** now real headcounts, with active, inactive, full-time and part-time shown separately.
- **Filters:** the export ignores the search box and the supervisor filter. It always covers the whole scope above.
- **Supervisors:** they now get their own department only.
- **Inactive supervisors:** a department whose supervisor's account is inactive is flagged "(inactive)".
- **Automatic breaks:** if the company's auto-break basis is set to shifts, or automatic breaks are off, the report says so and marks the department values "(not used)".

**To test**
- **Admin:** both files download, every department is listed, and the "Not in a department" row appears when someone has no department.
- **Supervisor:** only their department appears.
- **Total Users card:** matches the report's total employees.

---

## 4. Leave Requests report: download from the server (PDF and new CSV)

**Where:** Company panel → Leave Requests (`EmployeesLeaveRequests.jsx`), the **Generate PDF** button in the table view. The Calendar PDF stays as it is for now; it's the next item.

**Server (new):** `GET /api/reports/leave/requests?format=pdf|csv&from=YYYY-MM-DD&to=YYYY-MM-DD&status=…`, with the normal Bearer token.
- **`from` / `to`:** optional, in company calendar dates. Leave both out for "All dates". A request is included if any part of it falls inside the range, the same overlap rule as the table.
- **`status`:** `all` (the default), or one or more of `pending,pending_secondary,approved,rejected,cancelled`, comma-separated.
- **Who can call it:** admin and superadmin get the whole company, including inactive employees. A **supervisor gets their department plus their direct reports**, the same as the page. Employees get 403.
- **What comes back:** the file, with its name in `Content-Disposition`, e.g. `BizBuddy_LeaveRequests_…_2026-11-10_16-05.pdf`. Errors are JSON `{ message }`.
- **PDF:** US Letter landscape. It has a summary, a by-leave-type table, and the requests table: real days and hours, pay as a pill, balance now, approver and second approver, who decided and when, submitted date, and status.
- **CSV:** every field, including reason, second approver, and credits used by fiscal year.

**What to change**
1. **`handleGeneratePdf`:** stop calling `exportLeaveRequestsPDF`. Fetch the endpoint with:
   - `format=pdf`
   - `from=tableDateFrom` and `to=tableDateTo`, only if they're set. They're already `YYYY-MM-DD`.
   - `status=tableActiveTab` (`all` or the tab's status value).
   - Download the same way as items 2 and 3. Keep the "No leave requests to export for the current filters." check and the `generatingPdf` state.
2. **Add a CSV button** next to Generate PDF, with the same call and `format=csv`.
3. **Remove the balance lookup:** the `matrixByEmail` step that adds `currentBalance` to each row is no longer needed. The server adds "Balance now".
4. **`lib/exports/leaveRequests.js`:** once nothing imports it, it can be deleted.

**Behaviour changes to know about**
- **Search box:** the export ignores it. Only the date range and the status tab apply.
- **Days and hours:** days and hours are the leave days actually counted once a request is decided. They're no longer the calendar span, which counted weekends. A pending request shows its calendar span in grey and "—" for hours.
- **Dates:** every date is in the company's time zone, as MM-DD-YYYY.
- **Supervisors:** they now get their department plus direct reports, the same as on the page.

**To test**
- **Filters:** date range and status tab are applied. The search box is not.
- **Two-step approval:** a request needing a second approval shows both approvers.
- **Decided requests:** an approved multi-day leave that excludes weekends shows fewer days than its calendar span.
- **CSV:** opens cleanly and includes the reason.

---

## 5. Leave Calendar: download from the server

**Where:** Company panel → Leave Requests → Calendar view, the **Generate PDF** dialog (status checkboxes) and `handleGenerateCalendarPdf`.

**Server (new):** `GET /api/reports/leave/calendar?month=YYYY-MM&status=…`, with the normal Bearer token. PDF only.
- **`month`:** the month shown in the calendar (`calendarMonth`), as `YYYY-MM`. Without it, the server uses the current month in the company's time zone.
- **`status`:** the ticked checkboxes, comma-separated, from `pending,approved,rejected,cancelled`. `pending` already includes "pending final" on the server, so don't send `pending_secondary`. Without it, all four are used.
- **Who can call it:** admin and superadmin get the whole company. A **supervisor gets their department plus their direct reports**. Employees get 403.
- **What comes back:** the PDF, with its name in `Content-Disposition`, e.g. `BizBuddy_LeaveCalendar_2026-11_…_2026-11-10_16-40.pdf`. Errors are JSON `{ message }`.
- **PDF:** US Letter landscape.
  - **Page 1:** the month grid. Each day has one chip per person, coloured by status, earliest submitter first, with weekends shaded and a count of how many people are off.
  - **Following pages:** **"Leave in {Month}"** lists every leave touching the month: type, dates, days and hours this month, pay, status and submitted date. Nobody hidden behind "+N more" is lost.

**What to change**
1. **`handleGenerateCalendarPdf`:** stop calling `exportLeaveCalendarPDF`.
   - Fetch `${API}/api/reports/leave/calendar?month=${format(calendarMonth, "yyyy-MM")}&status=${ticked.join(",")}`.
   - Download it the same way as the other items, then close the dialog on success.
   - Keep the "pick at least one status" guard. The "no leave requests" check can go: the server returns an empty calendar with "No leave requests match…" instead of failing.
2. **`lib/exports/leaveCalendar.js`:** once nothing imports it, it can be deleted.

**Behaviour changes to know about**
- **Approved leaves mark only the days actually counted.** Weekends and days without shifts can be left out, so someone is no longer shown off on a Saturday they weren't charged for.
- **Pending, rejected and cancelled requests** mark the requested days, skipping Saturday and Sunday when the request excludes weekends.
- **Everyone appears in the list,** even on days too busy for all the chips to fit.

**To test**
- **Weekends excluded:** an approved Mon–Fri leave that excludes weekends shows no chips on Saturday or Sunday.
- **Busy days:** a day with many people shows "+N more", and every one of them is in the list.
- **Statuses:** only the ticked statuses appear, and "Pending" includes pending final.
- **Supervisor:** sees only their department and direct reports.

---

## 6. Contest Time Logs report: download from the server (two pages)

**Server (new):** `GET /api/reports/contests?format=pdf|csv&scope=mine|team&from=YYYY-MM-DD&to=YYYY-MM-DD&status=…`, with the normal Bearer token.
- **`scope=mine`** (the default): the signed-in user's own contests. Any role can use it.
- **`scope=team`:** admin and superadmin get the whole company. A **supervisor gets their department plus their direct reports**. Employees get 403.
- **`from` / `to`:** optional. They filter on the **punch date**, meaning the day of the original clock-in in the company's time zone, not the date the contest was submitted. Both days are fully included.
- **`status`:** `all` (the default), or one or more of `pending,approved,rejected`.
- **What comes back:** the file, with its name in `Content-Disposition`, e.g. `BizBuddy_Contests_…_2026-11-10_17-10.pdf`. Errors are JSON `{ message }`.
- **No 50-row limit:** every matching contest is included. The page itself only ever loaded the latest 50.
- **PDF:** US Letter landscape.
  - **Summary:** contests, pending, approved, rejected, and net time change from approved contests.
  - **Contests table:** punch date, original in–out, requested in–out, change (+/− hours), reason, status, reviewer, reviewed date and submitted date. Times are in company time as 12-hour, e.g. 8:30 AM.
  - **Team reports** add an Employee column.
- **CSV:** every field. Internal IDs are no longer included.

**What to change**
1. **Employee page `app/dashboard/employee/(C_TimeKeeping)/contest-time-logs/page.jsx`:**
   - **CSV and PDF buttons:** stop calling `exportContestLogsCSV` / `exportContestLogsPDF`. Fetch the endpoint with `scope=mine`, the page's `dateFrom` / `dateTo` (as `YYYY-MM-DD`) and `status=statusFilter`, then download the same way as the other items.
   - **Search box:** the export ignores it, the same as the other reports.
2. **Company page `app/dashboard/company/contest-requests/page.jsx`:** add **CSV** and **PDF** export buttons. They use the same call with `scope=team`, plus the page's date range and status filter if it has them.
3. **`lib/exports/contestLogs.js`:** once nothing imports it, it can be deleted.

**Page bugs to fix while you're there (employee page)**
- **Only the latest 50 load:** `fetchContestLogs` never passes `limit`, and the server's default is 50, so older contests never appear. Pass a larger `limit`, or page through the results.
- **Wrong dates in the date filter:** it reads `log.contestDate`, which doesn't exist, so it falls back to `createdAt` (the submitted time). It also compares `new Date(dateTo)`, which drops most of that last day. Filter on the punch date, the same as the report.
- **Two columns always blank:** "Approver" reads `approverName` and "Reviewed at" reads `reviewedAt`, neither of which exists. Use `approver.profile` (name) and `approvedAt`.

**To test**
- **Employee:** gets only their own contests, all of them (not just 50), with times in company time.
- **Admin:** on Contest Requests, gets the whole company with an Employee column.
- **Supervisor:** gets only their department and direct reports.
- **Date range:** a contest for an Oct 31 punch submitted on Nov 2 appears in an October range.

---

## 7. Punch Logs PDF: download from the server (two pages, PDF only)

**Server (new):** `GET /api/reports/punch-logs?format=pdf&scope=mine|team&…`, with the normal Bearer token. One shared server builder makes both PDFs, so the same punch shows the same hours, overtime and cutoff status for the employee and the admin.
- **`scope=mine`:** the signed-in user's own punches. Any role.
- **`scope=team`:** admin and superadmin get the whole company. A **supervisor gets their department plus their direct reports**. Employees get 403.
- **Period:** send **either**
  - `cutoffPeriodIds=a,b`: one or more cutoff period ids. Locked or processed cutoffs show the **reviewed, paid hours**, and open ones show live punches. Or
  - `from=YYYY-MM-DD&to=YYYY-MM-DD`: live punches, both days fully included, in company time.
- **Optional filters:** `departmentId`, `employeeIds=a,b`, `punchType` (`REGULAR`, `TRAINING`, `DRIVER_AIDE`, `DRIVER_AIDE_AM`, `DRIVER_AIDE_PM`, or leave it out for all), `status` (`active` or `completed`, or leave it out for all).
- **What comes back:** the PDF, with its name in `Content-Disposition`, e.g. `BizBuddy_PunchLogs_…_2026-10-14_2026-10-31_2026-11-11_14-05.pdf`. Errors are JSON `{ message }`.
- **PDF:** US Letter landscape, Client report.
  - **Badge next to the title:** **Final**, **Preliminary** or **Partly final**.
  - **Summary.**
  - **Cutoff periods,** when reported by cutoff.
  - **By employee,** team only.
  - **Punches table** with fixed columns: Employee (team, as "Last, First"), Date, In, Out, Punch type, Worked, Scheduled, OT, OT status, Late, Undertime, Cutoff status. Driver/Aide AM / Regular / PM appear only when there are Driver/Aide punches. OT and OT status are left out when the company counts overtime per cutoff.
  - **Overtime by cutoff,** for companies that count overtime per cutoff.
  - **Fixed hours,** BB-089, when any.

**Only the PDF changes in this item.** The CSV Detail and Payroll Grid CSV buttons keep using the browser exporters for now. They'll be a separate item.

**What to change** (both pages need `import { downloadServerReport } from "@/lib/reportDownload";`)
1. **Employee page `components/Dashboard/DashboardContent/EmployeePanel/TimeKeeping/PunchLogs.jsx`, `exportPDF` (~line 940):**
   - Stop calling `fetchExportData` and `exportPunchLogsPDF`. Call `downloadServerReport` from `lib/reportDownload.js` instead:
     ```js
     const p = new URLSearchParams({ format: "pdf", scope: "mine" });
     // A cutoff picked in the dropdown → send that cutoff's id, so a locked cutoff prints the reviewed (paid) hours.
     const period = selectedCutoffId !== "all"
       ? cutoffPeriods.find((cp) => periodRangeKey(cp) === selectedCutoffId &&
           (cp.departmentId === employeeDeptId || !cp.departmentId))
       : null;
     if (period) p.set("cutoffPeriodIds", period.id);
     else { p.set("from", queryParams.from); p.set("to", queryParams.to); }
     if (queryParams.status    !== "all") p.set("status",    queryParams.status);
     if (queryParams.punchType !== "all") p.set("punchType", queryParams.punchType);
     const filename = await downloadServerReport({ apiUrl: API_URL, token, path: `/api/reports/punch-logs?${p}`, fallbackFilename: "punch-logs.pdf" });
     toast.success(filename);
     ```
   - Pick the employee's **own department's** period (or a company-wide one). The server only includes punches that belong to the chosen period's department.
   - The "No records to export" guard can stay.
2. **Company page `components/Dashboard/DashboardContent/CompanyPanel/Punchlogs&Overtimes&Leaves/EmployeesPunchLogs.jsx`, `handleGenerateReport` (~line 1954):**
   - When `type === "pdf"`, return early, **before** the approvals and live data fetching, and download from the server instead:
     ```js
     if (type === "pdf") {
       const p = new URLSearchParams({ format: "pdf", scope: "team" });
       if (cutoffId && cutoffId !== "all" && cutoffPeriodIds?.length) p.set("cutoffPeriodIds", cutoffPeriodIds.join(","));
       else { p.set("from", from); p.set("to", to); }
       if (filters.departmentId !== "all") p.set("departmentId", filters.departmentId);
       const ids = (filters.employeeIds || []).filter((id) => id !== "all");
       if (ids.length) p.set("employeeIds", ids.join(","));
       if (filters.punchType !== "all") p.set("punchType", filters.punchType);
       if (filters.status    !== "all") p.set("status",    filters.status);
       const filename = await downloadServerReport({ apiUrl: API_URL, token, path: `/api/reports/punch-logs?${p}`, fallbackFilename: "punch-logs.pdf" });
       toast.success(filename);
       setGenerateModalOpen(false);
       return;
     }
     ```
   - Keep `setGenerating(true)`/`finally setGenerating(false)` around it, as today.
   - **CSV types** (`csv-detail`, `csv-payroll`) stay exactly as they are.
   - **Generate Report dialog:** the PDF's columns are now fixed, so the **column picker doesn't apply to PDF**. Hide it when PDF is selected, or leave it for the CSV options only.
   - **The search box** is ignored by the export, the same as the other reports.
3. **Don't delete anything yet:**
   - `exportPunchLogsPDF` (`lib/exports/punchLogs.js`) and `exportEmployeePunchLogsPDF` (`lib/exports/employeePunchLogs.js`) become unused, but the CSV exporters in the same files are still in use.
   - Remove the PDF functions only once you've confirmed the new PDFs.

**Behaviour changes to know about**
- **Employee, locked cutoff:** the PDF now shows the **reviewed, paid hours**, the same as the company report. Before, it showed live hours. Pick a cutoff in the dropdown to get this; a typed date range always shows live punches.
- **Overtime is consistent** on both pages.
  - **B&C:** the cutoff's daily OT blocks.
  - **Daycare counted per cutoff** (OT Configuration "Cutoff", e.g. 80h): overtime is one figure per employee per cutoff, not per day. The punch rows have no OT columns, and a new **"Overtime by cutoff"** table plus the By employee table show the hours with Approved / Pending / Excluded. A date-range report can't show this overtime, so pick cutoff periods to see it.
  - **Daycare daily or weekly:** approved OT requests, "Pending", or **"Not requested"** when extra time was recorded without a request. "No Approval" is gone, and regular punches no longer always show 0.00 OT.
- **Cutoff status per row:** Approved, Pending, Excluded, or No cutoff.
- **Times are in company time.** "(+1)" means the clock-out was the next day, and `*` means the reviewed clock time differs from the actual punch.

**To test**
- **Employee, open date range:** totals match the page, and the badge says **Preliminary**.
- **Employee, locked cutoff picked in the dropdown:** the badge says **Final**, and worked hours match what the cutoff review approved.
- **Company, locked cutoff:** worked hours per employee match the cutoff review page, and fixed-hours employees appear in the Fixed hours table.
- **Company, a cutoff with one department locked and one open:** the badge says **Partly final**.
- **Driver/Aide punches:** AM / Regular / PM columns appear, and Worked is their sum.
- **Supervisor:** sees only their department and direct reports.
- **CSV buttons:** still work as before.

---

## 8. Employee Punch Logs: PDF only (remove both CSV exports)

**Why:** employees only need a readable copy of their own punches. The **Grid CSV (Payroll)** is a payroll file and belongs on the company page. Everything in the **CSV (Details)** that matters to an employee is now in the server PDF (item 7). Three export options on the employee page was too much.

**Server:** no change. The employee page keeps using `GET /api/reports/punch-logs?format=pdf&scope=mine` (item 7).

**What to change, `components/Dashboard/DashboardContent/EmployeePanel/TimeKeeping/PunchLogs.jsx`**
1. **Replace the Export dropdown (~line 1029)** with a single button that calls `exportPDF`. Keep the same classes, including `hidden sm:inline-flex` (desktop only, as today), and `disabled={exporting}`:
   ```jsx
   <Button variant="outline" className="hidden sm:inline-flex h-8 text-xs rounded-lg px-2.5 gap-1.5"
     onClick={exportPDF} disabled={exporting}>
     <FileText className="h-3.5 w-3.5" />
     Export PDF
   </Button>
   ```
2. **Remove `exportCSV` (~line 928), `exportGridCSV` (~line 963) and `fetchExportData` (~line 875).** Nothing else on the page uses them once the CSV options are gone; `exportPDF` no longer calls `fetchExportData`.
3. **Clean up imports** no longer used: `DropdownMenu*` (if nothing else on the page uses them), `ChevronDown`, `LayoutTemplate`, `Download`.

**Then delete the old exporter**
- **`lib/exports/punchLogs.js`:** after step 2, nothing imports it. `exportPunchLogsCSV`, `exportPunchLogsPDF`, `exportPunchLogsCSV_v2` and `exportBoth` all go.
- **`lib/exportUtils.js` line 3:** remove `export * from "./exports/punchLogs.js";`. Nothing imports `exportUtils`, but the re-export would break the build once the file is deleted.

**Not changing:** the company page's CSV Detail and Payroll Grid CSV in `EmployeesPunchLogs.jsx`, and `lib/exports/employeePunchLogs.js`. Those come up in the CSV template discussion.

**To test**
- **Employee Punch Logs page:** shows a single **Export PDF** button, and it downloads the server PDF.
- **Admin or supervisor on their own employee Punch Logs page:** same single button, own punches only.
- **Company Punch Logs page:** Generate Report still offers PDF, CSV Detail and Payroll Grid CSV.
- **The build passes** with `lib/exports/punchLogs.js` deleted.

---

## 9. Employees report: Excel instead of CSV

**Server (new format):** `GET /api/reports/employees?format=xlsx`. Same access and data as the PDF and CSV (item 2). `format=csv` still works on the server, but the page no longer needs it.
- **What comes back:** an `.xlsx`, with its name in `Content-Disposition`, e.g. `BizBuddy_Employees_…_2026-11-11_10-30.xlsx`.
- **Workbook**, on the new shared Excel template (every Excel report will use it):
  - **"Employees" sheet:** every employee and every field, with the BizBuddy logo and title block (company, requested by, generated time in company time, "Client report"), an orange header row with filter buttons, and the ID and name columns frozen. Hire date, probation end and added on are real dates (MM-DD-YYYY); last sign-in is a real date and time.
  - **"Summary" sheet:** headcounts, plus by department (with totals) and by role.
  - **"This came from BizBuddy" marks:** a faint diagonal "CONFIDENTIAL · Generated by BizBuddy" watermark behind the cells, a line saying the file is a copy of BizBuddy records, and, when printed, a page header and a footer with "Confidential — {company}" and page numbers. The file's properties name BizBuddy as the author.

**What to change, `components/Dashboard/DashboardContent/CompanyPanel/Organizations&People/Employees.jsx`**
1. **`downloadCSV` (~line 724):** change the path to `/api/reports/employees?format=xlsx` and the fallback name to `BizBuddy_Employees.xlsx`. Renaming the function to `downloadExcel` is optional.
2. **The button (~line 871):** tooltip "Export Excel: every employee you can see, all fields". Use a spreadsheet icon (e.g. `FileSpreadsheet` from lucide-react) so it isn't confused with **Import CSV** next to it.
3. **Import CSV and its template are unchanged.** The Excel export isn't meant to be edited and imported back.

**To test**
- **Opens in Excel** (and Google Sheets or Numbers) with the logo, title block, orange header and filters. Scrolling right keeps the ID and names in view.
- **Watermark:** the diagonal "CONFIDENTIAL" shows behind the cells in desktop Excel. Google Sheets and Numbers don't show sheet backgrounds; the title block and printed header/footer still mark the file.
- **Dates:** sorting by Hire date sorts by date, not as text.
- **Print preview:** one page wide, header row repeated on each page, "Confidential — {company}" and "Page X of Y" in the footer.
- **Supervisor:** sees only their department and direct reports.

---

## 10. Departments report: Excel instead of CSV

**Server (new format):** `GET /api/reports/departments?format=xlsx`. Same access and data as the PDF and CSV (item 3). `format=csv` still works on the server.
- **Workbook**, on the same Excel template as item 9 (logo and title block, watermark, printed header and footer, "Confidential — {company}"):
  - **"Departments" sheet:** one row per department. Supervisor (and whether their account is active), headcounts (employees, active, inactive, full-time, part-time) with a **Total** row, then the time and pay settings in readable form: lunch paid, coffee breaks, auto lunch, auto coffee (marked "(not used)" when a company setting keeps them off), fixed hours per cutoff, cutoff schedule, and created on (a real date). Filter buttons, department column frozen.
  - **"Summary" sheet:** departments with and without a supervisor, employees in departments, employees without a department, departments on fixed hours or with their own cutoff schedule.

**What to change, `components/Dashboard/DashboardContent/CompanyPanel/Organizations&People/Departments.jsx`**
1. **The CSV download (~line 184):** change the path to `/api/reports/departments?format=xlsx` and the fallback name to `BizBuddy_Departments.xlsx`.
2. **The button:** tooltip "Export Excel", with a spreadsheet icon (e.g. `FileSpreadsheet`), the same as the Employees page.

**To test**
- **Totals:** the Total row matches the sum of the departments; the Summary matches the PDF.
- **Auto breaks:** in a company whose automatic breaks follow shifts (or are off), department auto lunch/coffee show "(not used)", and the company note appears under the table and on the Summary.
- **Supervisor:** gets only their own department.

---

## 11. Leave Requests report: Excel instead of CSV

**Server (new format):** `GET /api/reports/leave/requests?format=xlsx&from=&to=&status=`. Same access, filters and data as the PDF and CSV (item 4). `format=csv` still works on the server.
- **Workbook**, on the same Excel template as items 9 and 10 (logo and title block, watermark, printed header and footer, "Confidential — {company}"):
  - **"Leave requests" sheet:** one row per request, oldest start date first. Employee, email, department, leave type, start and end dates (real dates), days and days basis, hours, paid and unpaid hours, pay, status, reason, approver, second approver, decided by and on, submitted on, balance now, credits used by fiscal year. A **Total** row for hours, paid and unpaid hours. Filter buttons, employee column frozen.
  - **"Summary" sheet:** requests and employees, pending (and waiting for final approval), approved, rejected, cancelled, paid and unpaid hours, and a by-leave-type table with totals.

**What to change, `components/Dashboard/DashboardContent/CompanyPanel/Punchlogs&Overtimes&Leaves/EmployeesLeaveRequests.jsx`**
1. **The "Generate CSV" button (~line 905):** call `handleLeaveRequestsReport("xlsx")` and label it **"Generate Excel"** (it already uses the `FileSpreadsheet` icon).
2. **`handleLeaveRequestsReport` (~line 533):** nothing else changes. It already sends `format`, the status tab and the date range, and the fallback name becomes `BizBuddy_LeaveRequests.xlsx` on its own. `setBusy` treats anything that isn't `"pdf"` as the spreadsheet button, so the spinner still works.

**To test**
- **Same filters as the PDF:** the status tab and date range give the same requests in the Excel file and the PDF; the search box doesn't filter either.
- **Totals:** the Total row matches the Summary's paid and unpaid hours.
- **Dates:** sorting by Start date sorts by date.
- **Supervisor:** sees only their department and direct reports.

---

## 12. Contest Time Logs report: Excel instead of CSV (two pages)

**Server (new format):** `GET /api/reports/contests?format=xlsx&scope=mine|team&from=&to=&status=`. Same access, filters and data as the PDF and CSV (item 6). `format=csv` still works on the server.
- **Workbook**, on the same Excel template as items 9–11 (logo and title block, watermark, printed header and footer, "Confidential — {company}"):
  - **"Contests" sheet:** one row per contest, newest punch first. Punch date, original and requested clock-in/out as real date-times (company time), original and requested hours, the signed change (e.g. `+0.50`, `-1.25`), status, reason, details, reviewer, reviewed on, decision note, submitted on. **Team reports** (`scope=team`) add Employee, Email and Department, with the employee column frozen. Filter buttons.
  - **"Summary" sheet:** contests (and employees, on team reports), pending, approved, rejected, and the net time change from approved contests.

**What to change**
1. **Employee page `app/dashboard/employee/(C_TimeKeeping)/contest-time-logs/page.jsx` (~line 396):** the "Export CSV" menu item calls `exportReport("xlsx")` and is labelled **"Export Excel"**. `exportReport` already sends `format`, and the fallback name becomes `BizBuddy_Contests.xlsx` on its own.
2. **Company page `app/dashboard/company/contest-requests/page.jsx` (~line 431):** the CSV button calls `exportReport("xlsx")`, tooltip **"Export Excel: date range and status filter apply"**. `setBusy` treats anything that isn't `"pdf"` as the spreadsheet button, so the spinner still works.

**To test**
- **Employee:** the file has no Employee columns and only their own contests.
- **Admin on Contest Requests:** the whole company, with Employee, Email and Department.
- **Supervisor:** only their department and direct reports.
- **Times:** original and requested clock times match the PDF; a clock-out after midnight shows the next day's date.
- **Change:** an approved contest that adds 30 minutes shows `+0.50`; the Summary's net time change adds up approved contests only.

---

## 13. Company Punch Logs: "CSV — Detail" becomes a server Excel file

**Server (new format):** `GET /api/reports/punch-logs?format=xlsx&scope=team&…`. The same parameters, access, cutoff logic and data basis as the PDF (item 7). It replaces the browser-built CSV Detail (`exportEmployeePunchLogsCSV`) and keeps its core contents:
- **Title block** (Excel template, items 9–12): company, requested by, generated time, company time zone, filters, data basis. The old requester **User ID and username are dropped** (no system IDs on reports), and so is the per-record **ID** column.
- **"Punches" sheet**, one row per punch (one row per employee per day on locked cutoffs): Last name, First name, Employee ID, Department, Date, Time in, Time out (real date-times), Adjusted in review, Status (Active / Completed), Punch type, Scheduled / Unscheduled, Worked hours, Gross hours, Driver/Aide AM / Regular / PM (when there are Driver/Aide punches), Scheduled hours, OT hours and OT status (left out for companies that count overtime per cutoff), Late, Undertime, Coffee and Lunch minutes, Lunch start / end (or "Auto-deducted"), Cutoff status, Data (Reviewed / Live), Location required, Check-in / Check-out location, Device in / out. Filter buttons; names frozen.
- **"Summary" sheet:** data basis; employees; records; active, completed and scheduled sessions; worked, gross, scheduled, overtime and late hours. Then **By employee** (worked, scheduled, overtime, days worked, average hours per day, late, fixed hours; fixed-hours employees marked "(fixed hours)", including those with no punches) with a Total row, **Cutoff periods**, **Overtime by cutoff** (cutoff-basis companies) and **Fixed hours** when they apply.
- **Accountability notice:** kept, as a note on both sheets plus the "Confidential — {company}" footer.

**What to change, `components/Dashboard/DashboardContent/CompanyPanel/Punchlogs&Overtimes&Leaves/EmployeesPunchLogs.jsx`**
1. **`handleGenerateReport` (~line 1960):** send `"csv-detail"` to the server too. Change the early return to cover both types and pick the format:
   ```js
   if (type === "pdf" || type === "csv-detail") {
     const p = new URLSearchParams({ format: type === "pdf" ? "pdf" : "xlsx", scope: "team" });
     // …the same cutoff / date range and filter parameters as today…
     const filename = await downloadServerReport({ apiUrl: API_URL, token, path: `/api/reports/punch-logs?${p}`,
       fallbackFilename: type === "pdf" ? "punch-logs.pdf" : "punch-logs.xlsx" });
     toast.success(filename);
     setGenerateModalOpen(false);
     return;
   }
   ```
2. **Remove the `csv-detail` branch** further down (~line 2115). `csv-payroll` stays exactly as it is for now (the Payroll Grid is the next item).
3. **Generate Report dialog (~line 1255):** relabel the option **"Excel — Detail"** (keep the value `csv-detail`, or rename it to `xlsx-detail` in both places). **Remove the column picker** (~line 1340): the Excel file has a fixed column set, like the PDF.
4. **`lib/exports/employeePunchLogs.js`:** `exportEmployeePunchLogsCSV` (and `exportEmployeePunchLogsPDF`, unused since item 7) can be deleted once nothing imports them. Keep `exportEmployeePunchLogsCSV_v2` (Payroll Grid) and the helpers it uses.

**To test**
- **Same numbers as the PDF:** for the same cutoff or date range and filters, the Summary totals and By employee match the PDF.
- **Locked cutoff:** Data = Final; rows are reviewed, paid hours; fixed-hours employees appear in By employee and Fixed hours.
- **Open cutoff or date range:** Data = Preliminary; active punches show Status = Active and no time out.
- **Cutoff-basis company (e.g. 80h):** no OT columns on Punches; overtime is under "Overtime by cutoff".
- **B&C:** OT hours and status come from the daily OT blocks; lunch start and end are filled.
- **Payroll Grid CSV** still works unchanged.

---

## 14. Company Punch Logs: Payroll Grid from the server, as Excel

**Server (new format):** `GET /api/reports/punch-logs?format=payroll&…`, with the same cutoff / date range and filter parameters as the PDF and Excel (items 7 and 13). Admin, superadmin and supervisor (department + direct reports); `scope` is always the team. Returns an **Excel** file named like `BizBuddy_PunchLogs_PayrollGrid_…xlsx`. (`format=payroll-csv` returns the same grid in the original CSV layout, for anyone who imports it; the page doesn't need it.)

**The Excel grid keeps the core idea of the sheet: one column group per date with that day's hours.**
- **Header, two rows:** ID, Name of Employee, Role; then each date (e.g. "Mon 10-14") over its **AM / Regular / PM** columns; then **Total Hours** (Driver Aide AM / Regular / Driver Aide PM), Driving Hrs (AM + PM), TR, SL, OT and Total.
- **Rows:** one per employee (Last, First) with the hours as real numbers (0.00, empty when 0), and a bold **Total** row.
- **Easier to read:** Saturday and Sunday columns are tinted; ID, name, role and both header rows stay in view when scrolling; the legend (TR, SL, OT, Driving) and notes are under the grid.
- **Same template as the other Excel reports:** title block, watermark, printed header and footer.

**Same figures and rules as today's grid** (`exportEmployeePunchLogsCSV_v2`): the day-number row, the "ID / Name of Employee / Role / Driver Aide AM · Regular · Driver Aide PM" row, one row per employee (Last, First), and a Total row. Daily cells, totals (AM, Regular, PM, Driving Hrs, TR, SL, OT, Total), training shown under Regular per day, and the BB-089 fixed-hours rules (Regular = fixed hours − SL, "(fixed hours)" on the role, Total = Regular + approved off-day OT, listed even with no punches) all work the same way. Locked cutoffs use the reviewed hours and the cutoff's own leave days; open cutoffs and date ranges use live punches.

**Expected differences when you compare old and new files**
- **SL can be higher (fixed):** the page only loaded its **newest 50 leave requests** (`GET /api/leaves` without a limit), so older paid sick leave could be missing. The server reads every approved, paid sick leave in the range, using the leave's actual paid days.
- **OT follows the approved OT records:**
  - **Cutoff-basis companies (e.g. 80h):** the approved per-cutoff overtime, the same figure as Cutoff Review. The old grid recalculated it as worked − 80, which also counted **training** hours; Cutoff Review leaves training out (v2.10.18 rule), so the old figure could be too high.
  - **B&C:** the approved daily OT blocks (the old grid showed none on live data and a wrong figure on locked cutoffs).
  - **Daily or weekly OT companies:** the approved OT requests (the old grid always showed none).
- **ID column:** the company employee ID only. When an employee has none, it's blank instead of the internal user id.

**What to change, `components/Dashboard/DashboardContent/CompanyPanel/Punchlogs&Overtimes&Leaves/EmployeesPunchLogs.jsx`**
1. **`handleGenerateReport` (~line 1801):** add `csv-payroll` to the server early return:
   ```js
   if (type === "pdf" || type === "xlsx-detail" || type === "csv-payroll") {
     const format = type === "pdf" ? "pdf" : type === "xlsx-detail" ? "xlsx" : "payroll";
     const p = new URLSearchParams({ format, scope: "team" });
     // …the same cutoff / date range and filter parameters as today…
     const filename = await downloadServerReport({ apiUrl: API_URL, token, path: `/api/reports/punch-logs?${p}`,
       fallbackFilename: format === "pdf" ? "punch-logs.pdf" : format === "xlsx" ? "punch-logs.xlsx" : "punch-logs-payroll.xlsx" });
     toast.success(filename);
     setGenerateModalOpen(false);
     return;
   }
   ```
2. **Remove everything after that early return** in `handleGenerateReport`: the company time zone fetch, the approvals and live fetching, `enrichTimelogs` for the report, the leave merging and the `csv-payroll` call. Nothing else uses that path any more.
3. **Then delete** `buildRowsFromApprovals`, `buildLeavesFromApprovals` and `lib/exports/employeePunchLogs.js` (`exportEmployeePunchLogsCSV_v2`), plus `fetchApprovedLeaves` / `approvedLeaves` if nothing else on the page uses them. **Keep `enrichTimelogs`**: the on-screen table still uses it.

**Generate Report dialog:** relabel the option **"Excel — Payroll Grid"** (keep the value `csv-payroll`, or rename it in both places).

**To test (compare old and new for the same period before deleting the old code)**
- **Locked cutoff, Daycare:** AM / Regular / PM per day and the totals match the old file; SL matches or is higher (older sick leave now included); OT matches Cutoff Review.
- **Fixed-hours employees:** Regular = fixed hours − SL, "(fixed hours)" on the role, Total = Regular + approved off-day OT.
- **Open cutoff or date range:** live hours per day match the old file.
- **Double punches on one day:** both records count, as before.
