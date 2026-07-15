# BizBuddy v2 Server — Project Reference

## Overview

Node.js/Express REST API serving both the **BizBuddy web app** and **mobile apps (iOS & Android)**. Multi-tenant HR/payroll SaaS platform primarily targeting Philippine businesses with full PH statutory compliance (SSS, PhilHealth, Pag-IBIG, withholding tax).

**Current version:** v2.4.0
**Runtime:** Node.js (CommonJS)
**Database:** PostgreSQL via Prisma v6
**Default port:** `5000` (dev: `5001`)

---

## Stack

| Layer | Technology |
|---|---|
| Framework | Express 4 |
| ORM | Prisma v6 + `pg` driver |
| Auth | JWT Bearer + `bcryptjs`; separate system-admin cookie JWT |
| Real-time | Socket.io 4 |
| Push notifications | Firebase Admin SDK (FCM) |
| Email | Nodemailer + Handlebars templates |
| Billing | Stripe |
| PDF generation | PDFKit (payslips, checks) |
| Scheduler | `node-cron` + custom workers |
| Logging | Winston + Morgan → `RequestLog` DB table |
| Path aliases | `module-alias` |
| Date/time | `moment-timezone`, `dayjs`, `date-fns` |

---

## Entry Points

### `app.js`
Configures Express: CORS origins, `cookie-parser`, Morgan, request logger middleware, and a raw-body bypass for the Stripe webhook route (`/api/payments/stripe-webhook`).

### `server.js`
The real boot sequence:
1. Register `module-alias`
2. Load `.env`
3. Mount `/api` router + error middlewares
4. Create HTTP server
5. Init Socket.io → Firebase → Workers/Cron jobs
6. Connect to DB → `server.listen(PORT)`

---

## Module Aliases (`package.json → _moduleAliases`)

| Alias | Path |
|---|---|
| `@root` | `.` |
| `@config` | `./src/config` |
| `@controllers` | `./src/controllers` |
| `@middlewares` | `./src/middlewares` |
| `@routes` | `./src/routes` |
| `@utils` | `./src/utils` |
| `@constants` | `./src/constants` |
| `@services` | `./src/services` |
| `@workers` | `./src/workers` |
| `@jobs` | `./src/jobs` |
| `@emails` | `./src/emails` |

---

## Folder Structure

```
bizbuddy-v2-server/
├── app.js                          # Express app setup
├── server.js                       # Entry point & boot sequence
├── package.json
├── baseline_migration.sql          # Raw SQL baseline snapshot
├── prisma/
│   └── migrations/000_init/        # Single baseline migration
├── docs/
├── logs/
└── src/
    ├── config/
    │   ├── connection.js           # Singleton PrismaClient + connect()
    │   ├── env.js                  # Centralized env var exports
    │   ├── socket.js               # Socket.io init + JWT auth + room management
    │   ├── firebase.js             # Firebase Admin SDK init
    │   └── logger.js               # Winston logger instance
    ├── controllers/
    │   ├── Account/                # Signup, signin, logout, company, payments, subscriptions
    │   ├── Analytics/              # Analytics + system-admin auth
    │   ├── Company/                # Notification settings
    │   ├── Features/               # Core HR features (see Routes section)
    │   ├── PayrollSystem/          # Payroll runs, employee payroll details, company info
    │   └── notificationController.js
    ├── routes/
    │   ├── index.js                # Central router — mounts all route groups under /api
    │   ├── Account/
    │   ├── Analytics/
    │   ├── Cutoff/
    │   ├── Features/
    │   ├── PayrollSystem/
    │   ├── Superadmin/
    │   ├── notificationRoutes.js
    │   └── testRoutes.js
    ├── middlewares/
    │   ├── authMiddleware.js       # JWT Bearer validation + tokenVersion check
    │   ├── roleMiddleware.js       # authorizeRoles(...roles) factory
    │   ├── systemAdminAuth.js      # Separate cookie-based JWT for system-admin tier
    │   ├── requestLogger.js        # Async HTTP audit log to DB + errorLogger
    │   ├── morganMiddleware.js     # Morgan → Winston transport
    │   └── errorHandler.js        # Global error handler
    ├── services/
    │   ├── notificationService.js  # Persist NotificationLog + emit via Socket.io
    │   ├── emailService.js         # Nodemailer email sending
    │   ├── socketService.js        # Socket.io helper wrappers
    │   ├── shiftNotificationService.js
    │   └── Analytics/
    │       └── analyticsService.js
    ├── workers/
    │   ├── leaveAccrualWorker.js   # Scheduled leave balance accrual
    │   ├── clockInReminderWorker.js  # Proactive reminder 30 min before shift
    │   ├── clockOutReminderWorker.js # Proactive reminder 30 min before shift end
    │   └── breakHelpers.js
    ├── jobs/
    │   ├── checkMissedClockIns.js    # Every 5 min: alert on missed clock-in
    │   ├── checkMissedClockOuts.js   # Every 5 min: alert on missed clock-out
    │   ├── autoClockOutSafeguard.js  # Every 10 min: force clock-out after 20h
    │   ├── sendMorningReport.js      # Daily 10:00 AM attendance digest
    │   ├── sendEveningReport.js      # Daily 6:00 PM attendance digest
    │   ├── generateUpcomingUserShifts.js
    │   └── cleanupExpiredOtps.js
    ├── utils/
    │   ├── cronScheduler.js        # Registers all node-cron jobs
    │   ├── generatePayslipPDF.js   # PDFKit payslip generation
    │   ├── generateCheckPDF.js     # PDFKit check generation
    │   ├── leaveUtils.js           # Leave business logic helpers
    │   ├── calculateYTD.js         # Year-to-date calculation
    │   ├── notificationFunction.js # Firebase FCM push dispatch
    │   └── mailer.js               # Nodemailer transport config
    ├── prisma/
    │   ├── schema.prisma           # Prisma schema (source of truth)
    │   └── seed.js                 # DB seed script
    ├── emails/
    │   ├── renderTemplate.js
    │   └── welcome_bizbuddy.html
    └── templates/                  # Handlebars (.hbs) email templates
        ├── autoClockOut.hbs
        ├── missedClockIn.hbs
        ├── missedClockOut.hbs
        └── morningReport.hbs
```

---

## API Routes (all under `/api`)

| Prefix | Route File | Domain |
|---|---|---|
| `/account` | `Account/accountRoutes.js` | Signup, signin, logout, OTP, password reset |
| `/company` | `Superadmin/companyRoutes.js` | Company CRUD (system-admin) |
| `/departments` | `Account/departmentRoutes.js` | Department management |
| `/payments` | `Account/paymentRoutes.js` | Stripe billing + webhook |
| `/subscription-plans` | `Superadmin/subscriptionPlanRoutes.js` | Plan management |
| `/subscriptions` | `Superadmin/subscriptionRoutes.js` | Subscription management |
| `/employee` | `Features/employeeRoutes.js` | Employee CRUD |
| `/timelogs` | `Features/timeLogRoutes.js` | Clock-in/out, time log approvals |
| `/presence` | `Features/userPresenceRoutes.js` | Real-time user presence |
| `/leaves` | `Features/leaveRoutes.js` | Leave requests and approvals |
| `/location` | `Features/locationRoutes.js` | Work location management |
| `/payroll` | `Features/payrollRoutes.js` | Payroll runs and entries |
| `/shifts` | `Features/shiftRoutes.js` | Shift management |
| `/shift-assignments` | `Features/shiftAssignmentRoutes.js` | Shift assignment |
| `/shiftschedules` | `Features/shiftScheduleRoutes.js` | Recurring shift schedules (rrule) |
| `/usershifts` | `Features/userShiftRoutes.js` | User shift records |
| `/employee-location-restriction` | `Features/employeeLocationRestrictionRoutes.js` | Geo-fencing per employee |
| `/analytics` | `Features/analyticsRoutes.js` | Attendance/payroll dashboards |
| `/leave-policies` | `Features/leavePolicyRoutes.js` | Leave policy configuration |
| `/leave-balances` | `Features/leaveBalanceRoutes.js` | Leave balance tracking |
| `/overtime` | `Features/overtimeRoutes.js` | OT requests and approvals |
| `/company-settings` | `Account/companySettingsRoutes.js` | Company config (grace periods, OT threshold) |
| `/employment-details` | `Features/employmentDetailRoutes.js` | Job title, type, supervisor |
| `/account-deletion` | `Features/accountDeletionRoutes.js` | Account deletion requests |
| `/conflicts` | `Features/conflictRoutes.js` | Attendance conflict resolution |
| `/contest-policy` | `Features/contestPolicyRoutes.js` | Policy dispute flows |
| `/request-punch-log` | `Features/requestPunchLogRoutes.js` | Manual punch log requests |
| `/payroll-system` | `PayrollSystem/payrollSystemRoutes.js` | Full payroll system |
| `/company-information` | `PayrollSystem/companyInformationRoutes.js` | Payroll company info |
| `/employee-payroll-details` | `PayrollSystem/employeePayrollDetailsRoutes.js` | Per-employee payroll config |
| `/cutoff-periods` | `Features/cutoffPeriodRoutes.js` | Pay period cutoff records |
| `/notifications` | `notificationRoutes.js` | In-app notification inbox |
| `/cutoff` | `Cutoff/cutoffRoutes.js` | Consolidated cutoff management |
| `/system-admin` | `Analytics/systemAdminRoutes.js` | System-admin dashboard |
| `/test` | `testRoutes.js` | Dev/test endpoints |

---

## Authentication

Three-tier auth system:

1. **Regular users** (`authMiddleware.js`) — JWT Bearer in `Authorization` header. Validates `tokenVersion` on `User` model against DB on every request (enables "logout all devices" by incrementing the field). Attaches `{ id, email, role, companyId }` to `req.user`.

2. **Role-based access** (`roleMiddleware.js`) — `authorizeRoles('admin', 'supervisor', ...)` middleware factory. Re-fetches user from DB to confirm current role.

3. **System admin** (`systemAdminAuth.js`) — Completely separate JWT (`SYSTEM_ADMIN_JWT_SECRET`) stored in a `system-admin-token` cookie. Privileged tier above regular admins.

---

## Database

- **ORM:** Prisma v6
- **Schema:** `src/prisma/schema.prisma`
- **Deployment:** `prisma db push` (schema-push model, not migration-based)
- **Sync script:** `npm run prisma:sync` → `prisma db push --accept-data-loss && prisma generate`
- **Seed:** `node src/prisma/seed.js`

### Key Prisma Models

| Model | Purpose |
|---|---|
| `User` | Core user entity with `tokenVersion` for session invalidation |
| `UserProfile` | Extended personal info |
| `Company` | Multi-tenant root — all data is scoped by `companyId` |
| `Department` | Org units with break configuration |
| `EmploymentDetail` | Job title, type, supervisor, work location |
| `TimeLog` | Clock-in/clock-out records |
| `Shift` / `ShiftSchedule` / `UserShift` | Shift scheduling (rrule for recurrence) |
| `Leave` / `LeavePolicy` / `LeaveBalance` | Leave management and accrual |
| `Overtime` | OT requests and approvals |
| `PaySchedule` / `PayrollRun` / `PayrollEntry` / `PayrollLine` | Full payroll run system |
| `EmployeePayrollDetails` / `EarningType` / `DeductionType` | Per-employee payroll config |
| `AttendanceSummary` | Pre-aggregated daily attendance for fast payroll calculation |
| `CutoffPeriod` | Pay period cutoff management |
| `WithholdingTaxBracket` / `ContributionBracket` | PH statutory tables (multi-country enum) |
| `NotificationLog` | In-app notification inbox |
| `RequestLog` | HTTP request audit log (every request) |
| `Otp` / `PasswordResetToken` | OTP and password reset flows |
| `Subscription` | Stripe subscription tracking |

---

## Notification System

Three delivery channels, all triggered through `notificationService.js`:

1. **In-app** — Socket.io emit to `user:{id}` room, persisted to `NotificationLog`
2. **Email** — Nodemailer via SMTP, Handlebars templates in `src/templates/`
3. **Mobile push** — Firebase FCM via `src/utils/notificationFunction.js`

Socket.io rooms: `user:{id}`, `company:{id}`, `company:{id}:management`

---

## Background Jobs & Workers

All initialized in `server.js` before `listen()`.

| Type | File | Schedule |
|---|---|---|
| Worker | `leaveAccrualWorker.js` | Scheduled leave balance accrual |
| Worker | `clockInReminderWorker.js` | 30 min before shift starts |
| Worker | `clockOutReminderWorker.js` | 30 min before shift ends |
| Cron job | `checkMissedClockIns.js` | Every 5 min |
| Cron job | `checkMissedClockOuts.js` | Every 5 min |
| Cron job | `autoClockOutSafeguard.js` | Every 10 min (force clock-out after 20h) |
| Cron job | `sendMorningReport.js` | Daily 10:00 AM |
| Cron job | `sendEveningReport.js` | Daily 6:00 PM |
| Cron job | `generateUpcomingUserShifts.js` | Scheduled |
| Cron job | `cleanupExpiredOtps.js` | Scheduled |

Cron jobs are pure functions registered via `src/utils/cronScheduler.js` using `node-cron`.

---

## NPM Scripts

| Script | Command |
|---|---|
| `npm run dev` | `PORT=5001 nodemon server.js` |
| `npm start` | `npm run prisma:sync && node server.js` |
| `npm run seed` | `node src/prisma/seed.js` |
| `npm run prisma:sync` | `prisma db push --accept-data-loss && prisma generate` |

---

## Multi-Tenancy

Every major model is scoped to `companyId`. Cascade deletes ensure tenant data isolation. When writing queries, always filter by `companyId` from `req.user.companyId`.

---

## Key Conventions

- Controllers handle request/response; business logic should live in services.
- Always use module aliases (`@controllers`, `@services`, etc.) — no relative path climbing.
- Notifications go through `notificationService.js` — do not call Socket.io or FCM directly from controllers.
- Cron job functions in `/src/jobs/` are pure functions; registration is in `cronScheduler.js`.
- The Stripe webhook route requires a raw body — the bypass in `app.js` must remain.
- `req.user` is populated by `authMiddleware.js` with `{ id, email, role, companyId }`.
- **Async route handlers don't need manual try/catch for unexpected errors** — `express-async-errors` (required at the top of `server.js`, before `app.js`/routes are loaded) auto-forwards any rejected promise from a route handler to `errorHandler.js`. Still use try/catch when you want a *specific* error (e.g. a Prisma error code like `P2003`) to produce a friendlier message/status than the generic 500 — see `deletePolicy` in `leavePolicyController.js` for the pattern. What you must never do is assume an unguarded async route is "probably fine" — before this was added, an unguarded route (`deletePolicy` hitting a foreign-key violation) crashed the entire process, not just that request, because Node terminates on unhandled promise rejections by default. `server.js` also registers `process.on('unhandledRejection'/'uncaughtException')` as a second layer for async code outside the request cycle (cron jobs, workers) — errors there get logged to `logs/error.log` instead of crashing the server.
