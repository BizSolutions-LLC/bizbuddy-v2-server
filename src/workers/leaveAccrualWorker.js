// src/workers/leaveAccrualWorker.js
const cron = require("node-cron");
const { prisma } = require("@config/connection");
const { monthlyIncrement } = require("@utils/leaveUtils");
const dayjs = require("dayjs");

/**
 * Leave Accrual Worker
 *
 * Runs daily at 2:00 AM. Only executes on the 1st of the month.
 *
 * Per-company behaviour (requires company.accrualEnabled = true):
 *
 * MONTHLY accrual  — runs every 1st of the month
 *   - Existing employees : increment by (annualAllocation / 12), capped at annualAllocation
 *   - New employees (no balance yet):
 *       newEmployeeCatchUp = true  → credit all months elapsed in the current leave year
 *       newEmployeeCatchUp = false → credit only the current month (start fresh)
 *
 * YEARLY accrual — runs only on the 1st of company.leaveYearStartMonth
 *   - Handles carry-over (carryOverAllowed / carryOverLimit on policy)
 *   - Grants full annualAllocation for the new year on top of any carry-over
 *
 * NONE — skipped entirely
 *
 * All balances are tracked in hours. annualAllocation in "days" is converted
 * using company.defaultShiftHours before any calculation.
 */

function scheduleLeaveAccrual() {
  cron.schedule("0 2 * * *", async () => {
    const today = dayjs().startOf("day");

    // Only run on the 1st of the month
    if (today.date() !== 1) return;

    const currentMonth = today.month() + 1; // dayjs months are 0-indexed

    console.log(`\n[LeaveAccrual] Starting run for ${today.format("YYYY-MM-DD")}...`);

    try {
      const companies = await prisma.company.findMany({
        where: { accrualEnabled: true },
        select: {
          id: true,
          defaultShiftHours:  true,
          leaveYearStartMonth: true,
          newEmployeeCatchUp:  true,
        },
      });

      if (companies.length === 0) {
        console.log("[LeaveAccrual] No companies with accrual enabled. Done.");
        return;
      }

      for (const company of companies) {
        const shiftHours         = Number(company.defaultShiftHours || 8);
        const yearStartMonth     = company.leaveYearStartMonth ?? 1;
        const catchUp            = company.newEmployeeCatchUp ?? false;
        const isLeaveYearStart   = currentMonth === yearStartMonth;

        // Months elapsed in the current leave year, inclusive of today's month.
        // e.g. yearStart=1 (Jan), currentMonth=4 (Apr) → 4 months elapsed (Jan–Apr)
        const monthsIntoYear = ((currentMonth - yearStartMonth + 12) % 12) + 1;

        console.log(
          `[LeaveAccrual] Company ${company.id} | yearStart=${yearStartMonth} | ` +
          `monthsIntoYear=${monthsIntoYear} | isLeaveYearStart=${isLeaveYearStart} | catchUp=${catchUp}`
        );

        const [policies, employees] = await Promise.all([
          prisma.leavePolicy.findMany({ where: { companyId: company.id } }),
          prisma.user.findMany({
            where:  { companyId: company.id, status: "active" },
            select: { id: true },
          }),
        ]);

        if (employees.length === 0) {
          console.log(`[LeaveAccrual] Company ${company.id} — no active employees, skipping.`);
          continue;
        }

        const employeeIds = employees.map((e) => e.id);

        for (const policy of policies) {
          if (policy.accrualFrequency === "none") continue;

          // Convert annualAllocation to hours regardless of accrualUnit
          const annualHours =
            policy.accrualUnit === "days"
              ? Number(policy.annualAllocation) * shiftHours
              : Number(policy.annualAllocation);

          // ── MONTHLY ────────────────────────────────────────────────────────
          if (policy.accrualFrequency === "monthly") {
            const incr = monthlyIncrement(policy, shiftHours);

            // Load existing balances for this policy in one query
            const existingBalances = await prisma.leaveBalance.findMany({
              where:  { policyId: policy.id, userId: { in: employeeIds } },
              select: { userId: true, balanceHours: true },
            });
            const balanceMap = Object.fromEntries(
              existingBalances.map((b) => [b.userId, Number(b.balanceHours)])
            );

            for (const emp of employees) {
              const hasBalance = emp.id in balanceMap;
              const balanceBefore = hasBalance ? balanceMap[emp.id] : 0;
              let newBalance;

              if (hasBalance) {
                newBalance = Math.min(balanceBefore + incr, annualHours);
              } else {
                newBalance = catchUp
                  ? Math.min(incr * monthsIntoYear, annualHours)
                  : incr;
              }

              await prisma.leaveBalance.upsert({
                where:  { userId_policyId: { userId: emp.id, policyId: policy.id } },
                update: { balanceHours: newBalance, lastAccrualAt: today.toDate() },
                create: { userId: emp.id, policyId: policy.id, balanceHours: newBalance, lastAccrualAt: today.toDate() },
              });

              await prisma.leaveTransaction.create({
                data: {
                  userId:        emp.id,
                  policyId:      policy.id,
                  type:          "accrual",
                  hours:         +(newBalance - balanceBefore).toFixed(2),
                  balanceBefore,
                  balanceAfter:  newBalance,
                  note:          `Monthly accrual — ${today.format("MMMM YYYY")}`,
                },
              });
            }

            console.log(
              `[LeaveAccrual] Monthly | "${policy.leaveType}" | +${incr}h per employee | ` +
              `${employees.length} employees | cap=${annualHours}h`
            );
          }

          // ── YEARLY ─────────────────────────────────────────────────────────
          if (policy.accrualFrequency === "yearly" && isLeaveYearStart) {
            const carryOverLimitHours =
              policy.carryOverLimit != null
                ? policy.accrualUnit === "days"
                  ? Number(policy.carryOverLimit) * shiftHours
                  : Number(policy.carryOverLimit)
                : annualHours; // no explicit limit → carry over up to full annual

            const existingBalances = await prisma.leaveBalance.findMany({
              where:  { policyId: policy.id, userId: { in: employeeIds } },
              select: { userId: true, balanceHours: true },
            });
            const balanceMap = Object.fromEntries(
              existingBalances.map((b) => [b.userId, Number(b.balanceHours)])
            );

            for (const emp of employees) {
              const prevBalance = balanceMap[emp.id] ?? 0;

              const carryOver =
                policy.carryOverAllowed && prevBalance > 0
                  ? Math.min(prevBalance, carryOverLimitHours)
                  : 0;

              const newBalance = carryOver + annualHours;

              await prisma.leaveBalance.upsert({
                where:  { userId_policyId: { userId: emp.id, policyId: policy.id } },
                update: { balanceHours: newBalance, lastAccrualAt: today.toDate() },
                create: { userId: emp.id, policyId: policy.id, balanceHours: newBalance, lastAccrualAt: today.toDate() },
              });

              await prisma.leaveTransaction.create({
                data: {
                  userId:        emp.id,
                  policyId:      policy.id,
                  type:          "accrual",
                  hours:         +(newBalance - prevBalance).toFixed(2),
                  balanceBefore: prevBalance,
                  balanceAfter:  newBalance,
                  note:          `Yearly reset — carry-over ${carryOver}h + annual grant ${annualHours}h (${today.format("YYYY")})`,
                },
              });
            }

            console.log(
              `[LeaveAccrual] Yearly reset | "${policy.leaveType}" | ` +
              `annualGrant=${annualHours}h | carryOver=${policy.carryOverAllowed} (limit=${carryOverLimitHours}h) | ` +
              `${employees.length} employees`
            );
          }
        }
      }

      console.log("[LeaveAccrual] Done.\n");
    } catch (err) {
      console.error("[LeaveAccrual] Fatal error:", err);
    }
  });
}

module.exports = { scheduleLeaveAccrual };
