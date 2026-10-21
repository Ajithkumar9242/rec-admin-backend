-- CreateTable
CREATE TABLE "application_stage_histories" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "previousStageId" TEXT,
    "destinationStageId" TEXT NOT NULL,
    "actorId" TEXT,
    "notes" TEXT,
    "reviewerNotes" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_stage_histories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_stage_histories_applicationId_idx" ON "application_stage_histories"("applicationId");

-- CreateIndex
CREATE INDEX "application_stage_histories_destinationStageId_idx" ON "application_stage_histories"("destinationStageId");

-- CreateIndex
CREATE INDEX "application_stage_histories_previousStageId_idx" ON "application_stage_histories"("previousStageId");

-- CreateIndex
CREATE INDEX "application_stage_histories_actorId_idx" ON "application_stage_histories"("actorId");

-- CreateIndex
CREATE INDEX "application_stage_histories_createdAt_idx" ON "application_stage_histories"("createdAt");

-- AddForeignKey
ALTER TABLE "application_stage_histories" ADD CONSTRAINT "application_stage_histories_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "job_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_stage_histories" ADD CONSTRAINT "application_stage_histories_previousStageId_fkey" FOREIGN KEY ("previousStageId") REFERENCES "recruitment_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_stage_histories" ADD CONSTRAINT "application_stage_histories_destinationStageId_fkey" FOREIGN KEY ("destinationStageId") REFERENCES "recruitment_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_stage_histories" ADD CONSTRAINT "application_stage_histories_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
