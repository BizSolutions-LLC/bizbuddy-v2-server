// src/routes/Features/timeLogRoutes.js

const express = require("express");
const multer = require("multer");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { blockSystemAgent } = require("@utils/systemAgent");

const {
  timeIn,
  timeOut,
  getUserTimeLogs,
  deleteTimeLog,
  coffeeBreakStart,
  coffeeBreakEnd,
  lunchBreakStart,
  lunchBreakEnd,
  getCompanyTimeLogs,
  updateTimeLogDateTime,
  getTodayShift,
  clearAutoBreaks,
  upsertLunchBreak,
  deleteLunchBreak,
  updatePunchType,
  adminDeleteTimeLog,
} = require("@controllers/Features/timeLogController");

router.patch("/:id/datetime", authenticate, updateTimeLogDateTime);
router.patch("/:id/punch-type", authenticate, updatePunchType);
router.delete("/:id/auto-breaks", authenticate, clearAutoBreaks);
router.put("/:id/lunch-break", authenticate, upsertLunchBreak);
router.delete("/:id/lunch-break", authenticate, deleteLunchBreak);
router.delete("/:id", authenticate, adminDeleteTimeLog);
router.post("/time-in", authenticate, blockSystemAgent, timeIn);

const faceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function maybeFacePhoto(req, res, next) {
  if (!req.is("multipart/form-data")) return next();
  faceUpload.single("facePhoto")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        message: "The face photo must be a JPEG or PNG under 5 MB.",
        code: "FACE_PHOTO_REQUIRED",
      });
    }
    next();
  });
}

router.post("/time-out", authenticate, blockSystemAgent, maybeFacePhoto, timeOut);
router.get("/user", authenticate, blockSystemAgent, getUserTimeLogs);
router.delete("/delete/:id", authenticate, blockSystemAgent, deleteTimeLog);
router.post("/coffee-break/start", authenticate, blockSystemAgent, coffeeBreakStart);
router.post("/coffee-break/end", authenticate, blockSystemAgent, coffeeBreakEnd);
router.post("/lunch-break/start", authenticate, blockSystemAgent, lunchBreakStart);
router.post("/lunch-break/end", authenticate, blockSystemAgent, lunchBreakEnd);
router.get("/", authenticate, getCompanyTimeLogs);
router.get("/today-shift", authenticate, blockSystemAgent, getTodayShift);

module.exports = router;
