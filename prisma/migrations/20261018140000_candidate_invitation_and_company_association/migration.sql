-- AlterTable
ALTER TABLE "candidates" ADD COLUMN "companyId" TEXT,
ADD COLUMN "invitationTokenHash" TEXT,
ADD COLUMN "invitationExpiresAt" TIMESTAMP(3),
ADD COLUMN "invitationSentAt" TIMESTAMP(3),
ADD COLUMN "invitationStatus" TEXT DEFAULT 'NONE';

-- CreateIndex
CREATE INDEX "candidates_companyId_idx" ON "candidates"("companyId");
CREATE INDEX "candidates_invitationTokenHash_idx" ON "candidates"("invitationTokenHash");

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
