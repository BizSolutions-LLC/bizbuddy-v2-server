-- Optional per-employee payslip remark captured when marking a recipient paid.
ALTER TABLE "DisbursementRecipient"
  ADD COLUMN IF NOT EXISTS "payslipRemark" TEXT;
