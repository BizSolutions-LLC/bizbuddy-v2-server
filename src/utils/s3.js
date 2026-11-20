// src/utils/s3.js
//
// Minimal private-S3 helper. Region and keys come from the environment
// (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; the SDK reads the keys).
// Buckets:
//   - "photos" → AWS_S3_BUCKET        (BB-141 face photos, prefix face-photos/)
//   - "email"  → AWS_S3_EMAIL_BUCKET  (BB-140 email copies, whole bucket, 90 days)
// Both buckets are private: files are only reachable through short-lived signed
// links (signedGetUrl) or read by the server (getObjectText).

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const BUCKET_ENV = { photos: "AWS_S3_BUCKET", email: "AWS_S3_EMAIL_BUCKET" };

let client = null;

function bucketName(which = "photos") {
  return process.env[BUCKET_ENV[which]] || null;
}

function isConfigured(which = "photos") {
  return Boolean(process.env.AWS_REGION && bucketName(which));
}

function s3(which) {
  if (!isConfigured(which)) {
    throw new Error(`S3 is not configured (AWS_REGION / ${BUCKET_ENV[which]} missing).`);
  }
  if (!client) client = new S3Client({ region: process.env.AWS_REGION });
  return client;
}

async function putObject(key, body, contentType, which = "photos") {
  await s3(which).send(
    new PutObjectCommand({ Bucket: bucketName(which), Key: key, Body: body, ContentType: contentType })
  );
}

async function deleteObject(key, which = "photos") {
  await s3(which).send(new DeleteObjectCommand({ Bucket: bucketName(which), Key: key }));
}

/** The object's content as a UTF-8 string, or null when it no longer exists. */
async function getObjectText(key, which = "photos") {
  try {
    const out = await s3(which).send(new GetObjectCommand({ Bucket: bucketName(which), Key: key }));
    return await out.Body.transformToString("utf-8");
  } catch (err) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Signed GET link, valid for `expiresIn` seconds (default 5 minutes). */
async function signedGetUrl(key, expiresIn = 300, which = "photos") {
  return getSignedUrl(s3(which), new GetObjectCommand({ Bucket: bucketName(which), Key: key }), { expiresIn });
}

module.exports = { isConfigured, putObject, deleteObject, getObjectText, signedGetUrl };
