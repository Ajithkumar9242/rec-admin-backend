import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { hashPassword } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

async function bootstrapSuperAdmin() {
  console.log('--- RecruiTrain Super Admin Bootstrap ---');

  const email = (process.env.SUPER_ADMIN_EMAIL || env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || env.SUPER_ADMIN_PASSWORD;
  const name = process.env.SUPER_ADMIN_NAME || env.SUPER_ADMIN_NAME || 'Super Administrator';

  if (!email || !password) {
    console.error('ERROR: SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be provided via environment variables.');
    console.error('Example: SUPER_ADMIN_EMAIL=admin@recruitrain.com SUPER_ADMIN_PASSWORD=YourSecurePassword node src/scripts/bootstrap-superadmin.js');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('ERROR: SUPER_ADMIN_PASSWORD must be at least 8 characters long.');
    process.exit(1);
  }

  const existing = await prisma.admin.findUnique({
    where: { email },
  });

  const passwordHash = await hashPassword(password);

  if (existing) {
    console.log(`Administrator account for ${email} already exists (Role: ${existing.role}, Status: ${existing.status}).`);
    
    // Update role to SUPER_ADMIN, ensure ACTIVE status and update password if requested
    const shouldUpdate = process.argv.includes('--update-password') || process.argv.includes('--force');
    if (shouldUpdate) {
      await prisma.admin.update({
        where: { id: existing.id },
        data: {
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      console.log(`Super Admin password and active status successfully refreshed for ${email}.`);
    } else {
      console.log('Use --update-password or --force flag if you wish to reset the password for this account.');
    }
  } else {
    const created = await prisma.admin.create({
      data: {
        email,
        name,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
      },
    });

    await prisma.authAuditLog.create({
      data: {
        adminId: created.id,
        eventType: 'LOGIN_SUCCESS',
        details: { action: 'super_admin_bootstrapped', email },
      },
    });

    console.log(`Super Admin account successfully created for ${email}.`);
  }

  await prisma.$disconnect();
  console.log('Bootstrap completed successfully.');
}

bootstrapSuperAdmin().catch((err) => {
  console.error('Bootstrap failed:', err);
  prisma.$disconnect();
  process.exit(1);
});
