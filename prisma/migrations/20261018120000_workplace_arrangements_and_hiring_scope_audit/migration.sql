-- AlterTable: Add workArrangements array column
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "workArrangements" "JobWorkArrangement"[] NOT NULL DEFAULT ARRAY['ON_SITE']::"JobWorkArrangement"[];

-- Backfill workArrangements from existing workArrangement column
UPDATE "jobs" SET "workArrangements" = ARRAY["workArrangement"]::"JobWorkArrangement"[];

-- Fix hiringScopes for existing single-scope jobs where accidental default [DOMESTIC] was applied
-- Preserves legitimate multi-scope selections while restoring original single scope where accidental default occurred
UPDATE "jobs"
SET "hiringScopes" = ARRAY["hiringScope"]::"JobHiringScope"[]
WHERE ("hiringScopes" = ARRAY['DOMESTIC']::"JobHiringScope"[] AND "hiringScope" != 'DOMESTIC')
   OR "hiringScopes" IS NULL
   OR "hiringScopes" = ARRAY[]::"JobHiringScope"[];
