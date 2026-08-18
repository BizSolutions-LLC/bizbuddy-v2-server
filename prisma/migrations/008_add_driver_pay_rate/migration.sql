-- Migration: add driverPayRate to EmployeePayrollDetails
ALTER TABLE "EmployeePayrollDetails"
  ADD COLUMN IF NOT EXISTS "driverPayRate" DECIMAL(10,2);
