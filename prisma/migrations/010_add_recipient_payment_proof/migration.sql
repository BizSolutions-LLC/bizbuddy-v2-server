-- Per-employee payment-sent proof on disbursement recipients.
ALTER TABLE "DisbursementRecipient"
  ADD COLUMN IF NOT EXISTS "paymentMethod" "DisbursementPaymentMethod",
  ADD COLUMN IF NOT EXISTS "paymentMarkedById" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentMarkedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "paymentProofFileName" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentProofMimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentProofBytes" BYTEA;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DisbursementRecipient_paymentMarkedById_fkey'
  ) THEN
    ALTER TABLE "DisbursementRecipient"
      ADD CONSTRAINT "DisbursementRecipient_paymentMarkedById_fkey"
      FOREIGN KEY ("paymentMarkedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
