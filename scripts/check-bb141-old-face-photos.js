// scripts/check-bb141-old-face-photos.js
//
// BB-141: before face photos moved to S3 (PunchFacePhoto), the custom-forms
// questionnaire stored the photo bytes inside TaskReportFormResponse
// (facePhotoBytes). Are there any? Per company: how many rows, total size,
// oldest / newest. Also prints the companies with face capture turned on.
// This is a READ-ONLY script: no writes. Raw SQL, so it works with any
// generated Prisma client.
//
// If it finds none, the old columns can be dropped in a later push.
// If it finds some, tell Claude: a move-to-S3 script would be written then.
//
// Usage: node scripts/check-bb141-old-face-photos.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const mb = (bytes) => (Number(bytes || 0) / 1024 / 1024).toFixed(2);

async function main() {
  const rows = await prisma.$queryRaw`
    SELECT c."id" AS "companyId", c."name" AS "company",
           COUNT(*)::int AS "photos",
           COALESCE(SUM(OCTET_LENGTH(r."facePhotoBytes")), 0)::bigint AS "bytes",
           MIN(r."submittedAt") AS "oldest", MAX(r."submittedAt") AS "newest"
    FROM "TaskReportFormResponse" r
    JOIN "Company" c ON c."id" = r."companyId"
    WHERE r."facePhotoBytes" IS NOT NULL
    GROUP BY c."id", c."name"
    ORDER BY "photos" DESC`;

  console.log("\nOld questionnaire face photos stored in the database (TaskReportFormResponse.facePhotoBytes):");
  if (!rows.length) {
    console.log("  none ✅");
  } else {
    let total = 0n;
    for (const r of rows) {
      total += BigInt(r.bytes);
      console.log(`  ${r.company} (${r.companyId}): ${r.photos} photo(s), ${mb(r.bytes)} MB, ${r.oldest?.toISOString?.() ?? "-"} → ${r.newest?.toISOString?.() ?? "-"}`);
    }
    console.log(`  total: ${mb(total)} MB`);
  }

  // The BB-141 columns exist only after scripts/add-punch-face-photos.sql.
  const [col] = await prisma.$queryRaw`
    SELECT 1 AS ok FROM information_schema.columns
    WHERE table_name = 'Company' AND column_name = 'taskReportFaceCapture'`;
  if (!col) {
    console.log("\nCompany.taskReportFaceCapture doesn't exist yet (run scripts/add-punch-face-photos.sql first).");
    return;
  }
  const on = await prisma.$queryRaw`
    SELECT "id", "name", "taskReportEnabled", "taskReportMode", "taskReportFaceCaptureClockIn"
    FROM "Company" WHERE "taskReportFaceCapture" = true ORDER BY "name"`;
  console.log("\nCompanies with face capture switched on:");
  if (!on.length) console.log("  none");
  for (const c of on) {
    const applies = c.taskReportEnabled && c.taskReportMode === "forms";
    console.log(`  ${c.name} (${c.id}): clock-in too: ${c.taskReportFaceCaptureClockIn ? "yes" : "no"}; ${applies ? "APPLIES (documentation on, forms mode)" : "not applying (documentation off or free-form)"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
