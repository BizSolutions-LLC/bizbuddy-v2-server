# Client update: BB-139 New Business Requirement Details workbook (System Admin Dashboard)

**Server version:** next release. **System Admin Dashboard only.** Neither the company web app nor the mobile app is affected.

## What changed on the server
There is one new **read-only** endpoint under `/api/system-admin`. Any signed-in system admin can call it, using the same cookie or Bearer token as the other System Admin pages. It returns a blank Excel workbook. A system admin sends it to a new business, which fills in the details we need to create its company and accounts. No existing endpoint changed.

```http
GET /api/system-admin/onboarding-workbook
```

**Success: 200**, the file itself:
- `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `Content-Disposition: attachment; filename="BizBuddy_New_Business_Requirements_YYYY-MM-DD.xlsx"`

**Errors:** these come back as JSON.
- `401` / `403`: not signed in as a system admin. Same as the other System Admin endpoints.
- `500`: `{ "message": "Failed to build the onboarding workbook." }`

It takes no query parameters and no body.

## What the workbook contains (for the button's tooltip / help text)
- **Required sheets** (orange tabs): Company, Admin Account, Supervisors, Employees.
- **Optional sheets**: Departments (only the names are needed), Shifts & Schedules, Payroll & Cutoff, and Leave, Holidays, Locations. B. Buddy can also set these up after the company is created.
- **Not collected**: passwords and sensitive data. Each person gets a welcome email.

## What the client should do
1. Add a **"Download onboarding workbook"** button on the **Add Company** screen, or next to it.
2. Fetch the file as a **blob** with the system-admin auth. Read the filename from `Content-Disposition`, falling back to `BizBuddy_New_Business_Requirements.xlsx`. Then trigger the download.
3. If the response is not 200, parse the JSON error and show its `message`.

```js
const res = await fetch(`${API}/api/system-admin/onboarding-workbook`, { credentials: "include" /* or Bearer */ });
if (!res.ok) throw new Error((await res.json()).message);
const blob = await res.blob();
const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1]
  || "BizBuddy_New_Business_Requirements.xlsx";
const url = URL.createObjectURL(blob);
Object.assign(document.createElement("a"), { href: url, download: name }).click();
URL.revokeObjectURL(url);
```

**Cross-origin note:** if the dashboard runs on another origin, the browser hides `Content-Disposition` from the client unless the server's CORS `exposedHeaders` lists it. If it doesn't, use the fallback filename.
