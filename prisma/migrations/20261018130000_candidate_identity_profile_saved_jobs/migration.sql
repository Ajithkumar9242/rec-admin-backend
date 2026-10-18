-- AlterTable
ALTER TABLE "candidates" ADD COLUMN "middleName" TEXT,
ADD COLUMN "fullName" TEXT,
ADD COLUMN "alternateMobile" TEXT,
ADD COLUMN "dateOfBirth" TIMESTAMP(3),
ADD COLUMN "gender" TEXT,
ADD COLUMN "maritalStatus" TEXT,
ADD COLUMN "nationality" TEXT,
ADD COLUMN "addressLine1" TEXT,
ADD COLUMN "addressLine2" TEXT,
ADD COLUMN "state" TEXT,
ADD COLUMN "postalCode" TEXT,
ADD COLUMN "profession" TEXT,
ADD COLUMN "employmentType" TEXT,
ADD COLUMN "currentJobTitle" TEXT,
ADD COLUMN "currentCompany" TEXT,
ADD COLUMN "yearsOfExperience" DECIMAL(4,1),
ADD COLUMN "noticePeriodDays" INTEGER,
ADD COLUMN "currentSalary" DECIMAL(12,2),
ADD COLUMN "expectedSalary" DECIMAL(12,2),
ADD COLUMN "preferredLocation" TEXT,
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'CAREER_PORTAL',
ADD COLUMN "passportNumber" TEXT,
ADD COLUMN "passportExpiryDate" TIMESTAMP(3),
ADD COLUMN "visaStatus" TEXT,
ADD COLUMN "workPermitAuthorized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "linkedinUrl" TEXT,
ADD COLUMN "portfolioUrl" TEXT,
ADD COLUMN "githubUrl" TEXT,
ADD COLUMN "profileCompletion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "passwordHash" TEXT,
ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "verificationTokenHash" TEXT,
ADD COLUMN "passwordResetTokenHash" TEXT,
ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3),
ADD COLUMN "lastLoginAt" TIMESTAMP(3),
ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lockedUntil" TIMESTAMP(3);

-- Backfill fullName for existing candidates
UPDATE "candidates" SET "fullName" = TRIM(CONCAT("firstName", ' ', "lastName")) WHERE "fullName" IS NULL;

-- CreateIndex
CREATE INDEX "candidates_profession_idx" ON "candidates"("profession");
CREATE INDEX "candidates_deletedAt_idx" ON "candidates"("deletedAt");

-- CreateTable
CREATE TABLE "saved_jobs" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "saved_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saved_jobs_candidateId_jobId_key" ON "saved_jobs"("candidateId", "jobId");
CREATE INDEX "saved_jobs_candidateId_idx" ON "saved_jobs"("candidateId");
CREATE INDEX "saved_jobs_jobId_idx" ON "saved_jobs"("jobId");

-- AddForeignKey
ALTER TABLE "saved_jobs" ADD CONSTRAINT "saved_jobs_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "saved_jobs" ADD CONSTRAINT "saved_jobs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
