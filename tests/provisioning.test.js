import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';

const CLIENT_TEST_EMAIL = 'client_provisioned_admin@recruitrain.test';
const CLIENT_TEST_PASSWORD = 'ClientSecretPassword2026!@#';

describe('Client Provisioning & First-Run Setup Suite', () => {
  let app;
  let createdAdminId = null;

  beforeAll(async () => {
    // Assert safe database isolation
    await assertConnectedDatabase(prisma);
    app = createApp();

    // Clean any prior fixture record
    const existing = await prisma.admin.findUnique({
      where: { email: CLIENT_TEST_EMAIL },
      select: { id: true },
    });
    if (existing) {
      await prisma.authAuditLog.deleteMany({ where: { adminId: existing.id } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: existing.id } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: existing.id } });
      await prisma.admin.delete({ where: { id: existing.id } });
    }
  });

  afterAll(async () => {
    if (createdAdminId) {
      await prisma.authAuditLog.deleteMany({ where: { adminId: createdAdminId } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: createdAdminId } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: createdAdminId } });
      await prisma.admin.deleteMany({ where: { id: createdAdminId } });
    }
    await prisma.$disconnect();
  });

  it('provisions a new client-selected administrator identity without superadmin@recruitrain.com', async () => {
    // Simulate provisioning client-selected admin identity
    const passwordHash = await hashPassword(CLIENT_TEST_PASSWORD);
    const newAdmin = await prisma.admin.create({
      data: {
        email: CLIENT_TEST_EMAIL,
        name: 'Acme Corp Client Administrator',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        totpEnabled: false,
      },
    });

    createdAdminId = newAdmin.id;
    expect(newAdmin.id).toBeDefined();
    expect(newAdmin.email).toBe(CLIENT_TEST_EMAIL);
    expect(newAdmin.name).toBe('Acme Corp Client Administrator');
    expect(newAdmin.role).toBe('ADMIN');
    expect(newAdmin.totpEnabled).toBe(false);

    // Verify password was securely hashed with Argon2id
    const isPasswordValid = await verifyPassword(newAdmin.passwordHash, CLIENT_TEST_PASSWORD);
    expect(isPasswordValid).toBe(true);
    expect(newAdmin.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('mandates initial MFA enrollment when client-provisioned admin signs in', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({
        email: CLIENT_TEST_EMAIL,
        password: CLIENT_TEST_PASSWORD,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.state).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(res.body.requiresMFAEnrollment).toBe(true);
    expect(res.body.adminId).toBe(createdAdminId);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects authentication with incorrect password for client-provisioned admin', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({
        email: CLIENT_TEST_EMAIL,
        password: 'IncorrectPassword999!',
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Invalid email or password');
  });
});
