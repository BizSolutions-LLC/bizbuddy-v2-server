// scripts/create-demo-user.js
//
// Creates a demo company-owner account (admin role), matching signup:
// User + UserProfile + Company (owner link) + an active Subscription.
// Does not send email.
//
// Refuses to run if the company name or username/email already exists.
// If no subscription plan exists yet, creates a zero-price "Demo" plan
// with leaves, payroll, and timekeeping enabled.
//
// Usage (from repo root; loads DATABASE_URL from .env):
//   node scripts/create-demo-user.js

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const EMAIL = "test@gmail.com";
const COMPANY_NAME = "test";
const PASSWORD = "Password@123";
const FIRST_NAME = "Demo";
const LAST_NAME = "Account";

async function main() {
  const email = EMAIL.trim().toLowerCase();
  const companyName = COMPANY_NAME.trim();
  const username = email;

  const existingCompany = await prisma.company.findFirst({
    where: { name: { equals: companyName, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (existingCompany) {
    throw new Error(
      `Company "${existingCompany.name}" already exists (${existingCompany.id}).`
    );
  }

  const existingUser = await prisma.user.findFirst({
    where: { OR: [{ username }, { email }] },
    select: { id: true, email: true, username: true },
  });
  if (existingUser) {
    throw new Error(
      `User already exists: ${existingUser.email} / ${existingUser.username} (${existingUser.id}).`
    );
  }

  const existingProfile = await prisma.userProfile.findUnique({
    where: { username },
    select: { id: true },
  });
  if (existingProfile) {
    throw new Error(`Profile username "${username}" already exists.`);
  }

  let plan = await prisma.subscriptionPlan.findFirst({
    orderBy: { price: "desc" },
  });
  if (!plan) {
    plan = await prisma.subscriptionPlan.create({
      data: {
        name: "Demo",
        rangeOfUsers: "1-99",
        description:
          "Created by scripts/create-demo-user.js because no subscription plan existed.",
        price: 0,
        features: {
          leaves: true,
          payroll: true,
          timekeeping: true,
          "timekeeping-punch-offline": true,
        },
      },
    });
    console.log(`No subscription plan found. Created plan "${plan.name}" (${plan.id}).`);
  }

  const hashedPassword = await bcrypt.hash(PASSWORD, 10);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        role: "admin",
        status: "active",
      },
    });

    await tx.userProfile.create({
      data: {
        userId: user.id,
        username,
        email,
        firstName: FIRST_NAME,
        lastName: LAST_NAME,
      },
    });

    const company = await tx.company.create({
      data: {
        name: companyName,
        userId: user.id,
      },
    });

    await tx.user.update({
      where: { id: user.id },
      data: { companyId: company.id },
    });

    const subscription = await tx.subscription.create({
      data: {
        userId: user.id,
        companyId: company.id,
        planId: plan.id,
        active: true,
        startDate: new Date(),
      },
    });

    return { user, company, subscription };
  });

  console.log("Demo account created.");
  console.log({
    email,
    name: `${FIRST_NAME} ${LAST_NAME}`,
    role: result.user.role,
    userId: result.user.id,
    company: result.company.name,
    companyId: result.company.id,
    plan: `${plan.name} (${plan.id})`,
    subscriptionId: result.subscription.id,
  });
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
