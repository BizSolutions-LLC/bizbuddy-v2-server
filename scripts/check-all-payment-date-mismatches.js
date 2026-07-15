// scripts/check-all-payment-date-mismatches.js
// Diagnostic (read-only): for company cmnegwuxm0004rf7fzo6wjrw2, scan every
// CutoffPeriod row and flag any whose stored paymentDate doesn't match what
// the department's CURRENT DepartmentCutoffSettings.paymentOffsetDays would
// produce (expected = periodEnd + paymentOffsetDays). Same class of bug as
// the Jun24-Jul7 Staff/Staff Supervisor issue fixed in
// scripts/fix-payment-date-jun24-cutoff-period.js.
//
// Note: DepartmentCutoffSettings has no history — only the current value is
// stored. A mismatch here doesn't always prove a bug (offset could have been
// legitimately changed after the period was generated on purpose), but it's
// the same signal that caught the confirmed bug, so every mismatch is listed
// for manual review.
//
// Usage: node scripts/check-all-payment-date-mismatches.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2";

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const departments = await prisma.department.findMany({
    where: { companyId: COMPANY_ID },
    select: { id: true, name: true },
  });
  const deptById = Object.fromEntries(departments.map((d) => [d.id, d.name]));

  const settings = await prisma.departmentCutoffSettings.findMany({
    where: { companyId: COMPANY_ID },
  });
  // key: departmentId ?? "COMPANY_WIDE"
  const settingsByDept = Object.fromEntries(
    settings.map((s) => [s.departmentId ?? "COMPANY_WIDE", s])
  );

  console.log("DepartmentCutoffSettings:");
  for (const s of settings) {
    console.log(
      `  ${deptById[s.departmentId] ?? "COMPANY-WIDE"}: paymentOffsetDays=${s.paymentOffsetDays} frequency=${s.frequency} isActive=${s.isActive}`
    );
  }

  const periods = await prisma.cutoffPeriod.findMany({
    where: { companyId: COMPANY_ID },
    orderBy: [{ departmentId: "asc" }, { periodStart: "asc" }],
  });

  console.log(`\nTotal CutoffPeriod rows: ${periods.length}\n`);

  const mismatches = [];

  for (const p of periods) {
    const key = p.departmentId ?? "COMPANY_WIDE";
    const setting = settingsByDept[key];
    const deptName = deptById[p.departmentId] ?? "COMPANY-WIDE";

    if (!setting) {
      console.log(
        `⚠️  ${deptName} ${fmt(p.periodStart)}..${fmt(p.periodEnd)} (id=${p.id}): no DepartmentCutoffSettings row found for this department — can't verify.`
      );
      continue;
    }

    const expected = addDays(p.periodEnd, setting.paymentOffsetDays);
    const actual = p.paymentDate;

    if (fmt(expected) !== fmt(actual)) {
      mismatches.push({
        id: p.id,
        dept: deptName,
        periodStart: fmt(p.periodStart),
        periodEnd: fmt(p.periodEnd),
        status: p.status,
        offsetDays: setting.paymentOffsetDays,
        expected: fmt(expected),
        actual: fmt(actual),
      });
    }
  }

  if (mismatches.length === 0) {
    console.log("✅ No mismatches found — every stored paymentDate matches its department's current offset setting.");
    return;
  }

  console.log(`❌ Found ${mismatches.length} mismatch(es):\n`);
  for (const m of mismatches) {
    console.log(
      `  [${m.dept}] id=${m.id} period=${m.periodStart}..${m.periodEnd} status=${m.status} offsetDays=${m.offsetDays} expected=${m.expected} actual(stored)=${m.actual}`
    );
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
