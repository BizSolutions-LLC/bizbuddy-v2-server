// scripts/find-jhenelle-leave.js
// Diagnostic: locate Jhenelle Villanueva's leave records (the ID from the UI
// screenshot didn't match any row, so we look up by user instead).

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: "jvillanueva", mode: "insensitive" } },
        { email: { contains: "jhenelle", mode: "insensitive" } },
      ],
    },
    include: { profile: true },
  });

  console.log("Matching users:");
  for (const u of users) {
    console.log(`  id=${u.id} username=${u.username} email=${u.email} name=${u.profile ? `${u.profile.firstName} ${u.profile.lastName}` : null}`);
  }

  for (const u of users) {
    const leaves = await prisma.leave.findMany({
      where:   { userId: u.id },
      orderBy: { createdAt: "desc" },
      take:    10,
    });
    console.log(`\nLeaves for ${u.username}:`);
    if (leaves.length === 0) console.log("  (none)");
    for (const l of leaves) {
      console.log(`  id=${l.id} start=${l.startDate.toISOString().slice(0, 10)} end=${l.endDate.toISOString().slice(0, 10)} status=${l.status} type=${l.leaveType} paid=${l.isPaid}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
