// src/config/env.js

module.exports = {
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  DATABASE_URL: process.env.DATABASE_URL,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  // BB-110: shared B. Buddy login created for every new company (bcrypt hash, never plain text)
  BBUDDY_EMAIL: process.env.BBUDDY_EMAIL,
  BBUDDY_PASSWORD_HASH: process.env.BBUDDY_PASSWORD_HASH,
};
