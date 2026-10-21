-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('WEB', 'IOS', 'ANDROID');

-- CreateTable
CREATE TABLE "admin_device_tokens" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL DEFAULT 'WEB',
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_notifications" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "deepLinkUrl" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_device_tokens_token_key" ON "admin_device_tokens"("token");

-- CreateIndex
CREATE INDEX "admin_device_tokens_adminId_idx" ON "admin_device_tokens"("adminId");

-- CreateIndex
CREATE INDEX "admin_device_tokens_platform_idx" ON "admin_device_tokens"("platform");

-- CreateIndex
CREATE INDEX "admin_notifications_adminId_idx" ON "admin_notifications"("adminId");

-- CreateIndex
CREATE INDEX "admin_notifications_adminId_isRead_idx" ON "admin_notifications"("adminId", "isRead");

-- CreateIndex
CREATE INDEX "admin_notifications_adminId_createdAt_idx" ON "admin_notifications"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_notifications_isRead_idx" ON "admin_notifications"("isRead");

-- CreateIndex
CREATE INDEX "admin_notifications_createdAt_idx" ON "admin_notifications"("createdAt");

-- AddForeignKey
ALTER TABLE "admin_device_tokens" ADD CONSTRAINT "admin_device_tokens_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_notifications" ADD CONSTRAINT "admin_notifications_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
