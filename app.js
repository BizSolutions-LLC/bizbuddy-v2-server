// app.js

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morganMiddleware = require("@middlewares/morganMiddleware");
const { requestLogger } = require("@middlewares/requestLogger");
const cookieParser = require("cookie-parser");

const app = express();

// Render runs the API behind one proxy hop. Trust exactly that hop so req.ip is
// the real client (rate limiters key on it) and X-Forwarded-For can't be
// spoofed by clients. Without this every user shares the proxy's IP.
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// Rate limiters
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts, please try again in 15 minutes." },
});

// /login only counts failed attempts, so staff sharing one office IP aren't
// blocked by each other's successful sign-ins (BB-110: also caps B. Buddy PIN guessing).
const loginFailureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many failed sign-in attempts, please try again in 15 minutes." },
});

app.use("/api", globalLimiter);
app.use("/api/account/sign-in", authLimiter);
app.use("/api/account/login", loginFailureLimiter);
app.use("/api/account/sign-up", authLimiter);
app.use("/api/system-admin/auth/login", authLimiter);
app.use("/api/system-admin/auth/2fa", authLimiter);

app.use(
  cors({
    origin: ["http://localhost:19006", "https://mybizbuddy.co", "http://localhost:3000", "http://localhost:3001", "https://staging.mybizbuddy.co"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  })
);

app.use(cookieParser());

app.use(morganMiddleware);
app.use(requestLogger);

app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api/payments/stripe-webhook")) {
    next();
  } else if (req.originalUrl.startsWith("/api/schedule-import/confirm")) {
    // BB-103: the confirm body carries every preview item back (up to a few MB).
    express.json({ limit: "5mb" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

module.exports = app;
