-- AlterTable
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "hiringScopes" "JobHiringScope"[] NOT NULL DEFAULT ARRAY['DOMESTIC']::"JobHiringScope"[];

-- Backfill hiringScopes from existing single hiringScope column
UPDATE "jobs" SET "hiringScopes" = ARRAY["hiringScope"]::"JobHiringScope"[] WHERE "hiringScopes" IS NULL OR "hiringScopes" = ARRAY[]::"JobHiringScope"[];

-- Make germanLevel optional with no default
ALTER TABLE "jobs" ALTER COLUMN "germanLevel" DROP NOT NULL;
ALTER TABLE "jobs" ALTER COLUMN "germanLevel" DROP DEFAULT;
