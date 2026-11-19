-- Face photo stored with a submitted task-report response.
ALTER TABLE "TaskReportFormResponse"
  ADD COLUMN IF NOT EXISTS "facePhotoFileName" TEXT,
  ADD COLUMN IF NOT EXISTS "facePhotoMimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "facePhotoBytes" BYTEA;
