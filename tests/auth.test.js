import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';

describe('RecruiTrain Admin Authentication Suite', () => {
  let app;
  const testAdminPassword = 'TestPassword123!@#';
  let activeAdmin;
  let inactiveAdmin;
  let twoFactorAdmin;
  let twoFactorSecret;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = createApp();

    const passwordHash = await hashPassword(testAdminPassword);

    // Clean any prior test records
    await prisma.authAuditLog.deleteMany({});
    await prisma.adminBackupCode.deleteMany({});
    await prisma.passwordResetToken.deleteMany({});
    await prisma.admin.deleteMany({
      where: {
        email: {
          in: [
            'active_test@recruitrain.com',
            'inactive_test@recruitrain.com',
            '2fa_test@recruitrain.com',
          ],
        },
      },
    });

    // 1. Standard active admin
    activeAdmin = await prisma.admin.create({
      data: {
        email: 'active_test@recruitrain.com',
        name: 'Active Test Admin',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });

    // 2. Inactive admin
    inactiveAdmin = await prisma.admin.create({
      data: {
        email: 'inactive_test@recruitrain.com',
        name: 'Inactive Admin',
        passwordHash,
        role: 'ADMIN',
        status: 'INACTIVE',
      },
    });

    // 3. 2FA-enrolled admin
    const totpGen = generateTotpSecret('2fa_test@recruitrain.com');
    twoFactorSecret = totpGen.secret;
    twoFactorAdmin = await prisma.admin.create({
      data: {
        email: '2fa_test@recruitrain.com',
        name: '2FA Test Admin',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: twoFactorSecret,
      },
    });
  });

  afterAll(async () => {
    await prisma.adminBackupCode.deleteMany({});
    await prisma.passwordResetToken.deleteMany({});
    await prisma.admin.deleteMany({
      where: {
        email: {
          in: [
            'active_test@recruitrain.com',
            'inactive_test@recruitrain.com',
            '2fa_test@recruitrain.com',
          ],
        },
      },
    });
    await prisma.$disconnect();
  });

  describe('1. Login & Validation', () => {
    it('rejects missing or malformed input with 400', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: 'not-an-email', password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.issues).toBeDefined();
    });

    it('rejects invalid password with 401', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: activeAdmin.email, password: 'WrongPassword123!' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid email or password');
    });

    it('rejects inactive admin accounts with 403', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: inactiveAdmin.email, password: testAdminPassword });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/inactive/i);
    });

    it('authenticates valid active admin and establishes session cookie', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: activeAdmin.email, password: testAdminPassword });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.requires2FA).toBe(false);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(activeAdmin.email);
      expect(res.headers['set-cookie']).toBeDefined();
    });
  });

  describe('2. Session Restoration & Logout', () => {
    let sessionCookie;

    it('restores authenticated session via /api/auth/me', async () => {
      // Login first
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: activeAdmin.email, password: testAdminPassword });

      sessionCookie = loginRes.headers['set-cookie'];

      // Fetch /api/auth/me with session cookie
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', sessionCookie);

      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.user.email).toBe(activeAdmin.email);
    });

    it('rejects /api/auth/me when unauthenticated with 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('invalidates session on logout', async () => {
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', sessionCookie);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);

      // Subsequent /api/auth/me should be 401
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', sessionCookie);

      expect(meRes.status).toBe(401);
    });
  });

  describe('3. Forgot Password & Password Reset Flow', () => {
    it('maintains response privacy for existing and non-existing emails', async () => {
      const res1 = await request(app)
        .post('/api/auth/forgot-password')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: activeAdmin.email });

      const res2 = await request(app)
        .post('/api/auth/forgot-password')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: 'nonexistent@recruitrain.com' });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.message).toBe(res2.body.message);
    });

    it('resets password successfully with valid token and rejects expired/used token', async () => {
      // Retrieve the generated token from DB
      const resetRecord = await prisma.passwordResetToken.findFirst({
        where: { adminId: activeAdmin.id, usedAt: null },
      });
      expect(resetRecord).toBeDefined();

      // Trigger reset with invalid token
      const invalidRes = await request(app)
        .post('/api/auth/reset-password')
        .set('x-test-bypass-csrf', 'true')
        .send({ token: 'completely-invalid-token-string-here', password: 'NewSecurePassword123!' });

      expect(invalidRes.status).toBe(400);

      // Now create a known token to test valid consumption
      const rawToken = 'abcdef1234567890abcdef1234567890';
      const crypto = await import('../src/lib/crypto.js');
      const tokenHash = crypto.hashToken(rawToken);

      await prisma.passwordResetToken.create({
        data: {
          adminId: activeAdmin.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      const validRes = await request(app)
        .post('/api/auth/reset-password')
        .set('x-test-bypass-csrf', 'true')
        .send({ token: rawToken, password: 'NewSecurePassword123!' });

      expect(validRes.status).toBe(200);
      expect(validRes.body.success).toBe(true);

      // Second attempt with the same token must fail (single-use)
      const reusedRes = await request(app)
        .post('/api/auth/reset-password')
        .set('x-test-bypass-csrf', 'true')
        .send({ token: rawToken, password: 'NewSecurePassword123!' });

      expect(reusedRes.status).toBe(400);
    });
  });

  describe('4. Two-Factor Authentication (TOTP) & Backup Codes', () => {
    it('returns requires2FA: true for 2FA-enrolled account', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: twoFactorAdmin.email, password: testAdminPassword });

      expect(res.status).toBe(200);
      expect(res.body.requires2FA).toBe(true);
      expect(res.body.adminId).toBe(twoFactorAdmin.id);
    });

    it('rejects invalid TOTP code', async () => {
      const res = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .send({ adminId: twoFactorAdmin.id, code: '000000' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid two-factor authentication code');
    });

    it('accepts valid TOTP code and grants session', async () => {
      const validCode = authenticator.generate(twoFactorSecret);

      const res = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .send({ adminId: twoFactorAdmin.id, code: validCode });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user).toBeDefined();
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('accepts valid single-use backup code and prevents reuse', async () => {
      const crypto = await import('../src/lib/crypto.js');
      const plainBackupCode = 'RECR-TEST';
      const codeHash = crypto.hashBackupCode(plainBackupCode);

      await prisma.adminBackupCode.create({
        data: {
          adminId: twoFactorAdmin.id,
          codeHash,
        },
      });

      // 1. First consumption succeeds
      const res1 = await request(app)
        .post('/api/auth/verify-backup-code')
        .set('x-test-bypass-csrf', 'true')
        .send({ adminId: twoFactorAdmin.id, code: plainBackupCode });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);

      // 2. Second consumption fails (atomic single-use)
      const res2 = await request(app)
        .post('/api/auth/verify-backup-code')
        .set('x-test-bypass-csrf', 'true')
        .send({ adminId: twoFactorAdmin.id, code: plainBackupCode });

      expect(res2.status).toBe(400);
      expect(res2.body.error).toContain('Invalid or already used backup code');
    });
  });

  describe('5. Protected Route Authorization & Role Access', () => {
    it('blocks access to protected admin shell endpoint without session', async () => {
      const res = await request(app).get('/api/admin/overview');
      expect(res.status).toBe(401);
    });

    it('allows SUPER_ADMIN to access /api/admin/overview and /api/admin/audit-logs', async () => {
      const validCode = authenticator.generate(twoFactorSecret);

      const loginRes = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .send({ adminId: twoFactorAdmin.id, code: validCode });

      const cookie = loginRes.headers['set-cookie'];

      const overviewRes = await request(app)
        .get('/api/admin/overview')
        .set('Cookie', cookie);

      expect(overviewRes.status).toBe(200);
      expect(overviewRes.body.stats).toBeDefined();

      const auditLogsRes = await request(app)
        .get('/api/admin/audit-logs')
        .set('Cookie', cookie);

      expect(auditLogsRes.status).toBe(200);
      expect(auditLogsRes.body.data).toBeDefined();
    });
  });
});
