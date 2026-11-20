// src/config/connection.js

const { PrismaClient, Prisma } = require("@prisma/client");
// BB-141: never load old questionnaire photo bytes (unused since face photos moved
// to S3 / PunchFacePhoto); they could be megabytes per row. Only when the
// generated client knows the column (a stale client would refuse the option).
const knowsFaceBytes = Boolean(Prisma.TaskReportFormResponseScalarFieldEnum?.facePhotoBytes);
const prisma = new PrismaClient(
  knowsFaceBytes ? { omit: { taskReportFormResponse: { facePhotoBytes: true } } } : undefined
);

async function connect() {
  try {
    await prisma.$connect();
    console.log("Database connected successfully.");
  } catch (error) {
    console.error("Database connection error:", error);
    throw error;
  }
}

module.exports = { prisma, connect };
