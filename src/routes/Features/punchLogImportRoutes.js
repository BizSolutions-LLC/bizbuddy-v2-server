// src/routes/Features/punchLogImportRoutes.js
// BB-077 — CSV bulk import of historical punch logs.

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");
const {
  downloadPunchLogTemplate,
  bulkImportPunchLogs,
} = require("@controllers/Features/punchLogImportController");

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

router.get(
  "/template",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  downloadPunchLogTemplate
);

router.post(
  "/upload",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  upload.single("file"),
  bulkImportPunchLogs
);

module.exports = router;
