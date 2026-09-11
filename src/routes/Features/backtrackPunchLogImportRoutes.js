// src/routes/Features/backtrackPunchLogImportRoutes.js
// BB-086 — historical "backtrack" punch-log import from the legacy PadPro
// payroll-summary CSV format.

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");
const {
  previewBacktrack,
  confirmBacktrack,
} = require("@controllers/Features/backtrackPunchLogImportController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const isCsv =
      /\.csv$/i.test(file.originalname) ||
      ["text/csv", "application/vnd.ms-excel", "application/csv"].includes(file.mimetype);
    if (!isCsv) {
      const err = new Error("Only CSV files are accepted.");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

router.post(
  "/preview",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  upload.single("file"),
  previewBacktrack
);

router.post(
  "/confirm",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  confirmBacktrack
);

module.exports = router;
