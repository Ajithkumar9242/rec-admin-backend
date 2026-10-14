import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

async function main() {
  const dbUrl = process.env.DATABASE_URL || '';
  const dbName = dbUrl.split('/').pop()?.split('?')[0];

  console.log(`Checking Primary Database: "${dbName}"`);

  const admins = await prisma.admin.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      totpEnabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const backupCodesCount = await prisma.adminBackupCode.count();
  const unusedBackupCodesCount = await prisma.adminBackupCode.count({ where: { usedAt: null } });
  const auditLogsCount = await prisma.authAuditLog.count();
  const resetTokensCount = await prisma.passwordResetToken.count();

  console.log('--- Database Integrity Report ---');
  console.log(`Admins (${admins.length}):`, admins);
  console.log(`Total Backup Codes: ${backupCodesCount} (${unusedBackupCodesCount} unused)`);
  console.log(`Total Audit Logs: ${auditLogsCount}`);
  console.log(`Password Reset Tokens: ${resetTokensCount}`);
  console.log('---------------------------------');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error checking database:', err);
  process.exit(1);
});
