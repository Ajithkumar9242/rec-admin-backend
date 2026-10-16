-- CreateEnum
CREATE TYPE "ConfigurationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DocumentTargetType" AS ENUM ('COMPANY', 'CANDIDATE');

-- CreateEnum
CREATE TYPE "StageCategory" AS ENUM ('SOURCING', 'SCREENING', 'INTERVIEW', 'EVALUATION', 'OFFER', 'HIRED', 'REJECTED', 'OTHER');

-- CreateTable
CREATE TABLE "industries" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "parentId" TEXT,
    "status" "ConfigurationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "industries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_definitions" (
    "id" TEXT NOT NULL,
    "targetType" "DocumentTargetType" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "acceptedFileTypes" TEXT[],
    "maxFileSizeMb" INTEGER NOT NULL DEFAULT 10,
    "status" "ConfigurationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "document_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_stages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "StageCategory" NOT NULL DEFAULT 'SCREENING',
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" "ConfigurationStatus" NOT NULL DEFAULT 'ACTIVE',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "recruitment_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "acceptedResumeFileTypes" TEXT[] DEFAULT ARRAY['application/pdf', '.pdf', 'application/msword', '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx']::TEXT[],
    "autoApproveCandidateProfiles" BOOLEAN NOT NULL DEFAULT false,
    "showEmployerContactDetails" BOOLEAN NOT NULL DEFAULT false,
    "showCandidateResumes" BOOLEAN NOT NULL DEFAULT true,
    "showCandidateFullName" BOOLEAN NOT NULL DEFAULT true,
    "showCandidateEmail" BOOLEAN NOT NULL DEFAULT false,
    "showCandidatePhone" BOOLEAN NOT NULL DEFAULT false,
    "autoApproveJobs" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_config_audit_logs" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_config_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "industries_parentId_idx" ON "industries"("parentId");

-- CreateIndex
CREATE INDEX "industries_status_idx" ON "industries"("status");

-- CreateIndex
CREATE INDEX "industries_name_idx" ON "industries"("name");

-- CreateIndex
CREATE UNIQUE INDEX "industries_name_parentId_key" ON "industries"("name", "parentId");

-- CreateIndex
CREATE INDEX "document_definitions_targetType_status_idx" ON "document_definitions"("targetType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_definitions_targetType_name_key" ON "document_definitions"("targetType", "name");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_stages_name_key" ON "recruitment_stages"("name");

-- CreateIndex
CREATE INDEX "recruitment_stages_order_idx" ON "recruitment_stages"("order");

-- CreateIndex
CREATE INDEX "recruitment_stages_status_idx" ON "recruitment_stages"("status");

-- CreateIndex
CREATE INDEX "platform_config_audit_logs_entityType_entityId_idx" ON "platform_config_audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "platform_config_audit_logs_adminId_createdAt_idx" ON "platform_config_audit_logs"("adminId", "createdAt");

-- AddForeignKey
ALTER TABLE "industries" ADD CONSTRAINT "industries_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "industries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_config_audit_logs" ADD CONSTRAINT "platform_config_audit_logs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
