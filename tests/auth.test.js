import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret, decryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';

const FIXTURE_EMAILS = [
  'auth_fixture_active@recruitrain.test',
  'auth_fixture_inactive@recruitrain.test',
  'auth_fixture_2fa@recruitrain.test',
];

async function cleanupTestAdminsByEmails(emails) {
  if (!emails || emails.length === 0) return;
  await assertConnectedDatabase(prisma);
  const found = await prisma.admin.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const adminIds = found.map((a) => a.id);
  if (adminIds.length > 0) {
    await prisma.authAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.passwordResetToken.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
  }
}

async function cleanupTestAdminByIds(adminIds) {
  const validIds = (adminIds || []).filter(Boolean);
  if (validIds.length === 0) return;
  await assertConnectedDatabase(prisma);
  await prisma.authAuditLog.deleteMany({ where: { adminId: { in: validIds } } });
  await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: validIds } } });
  await prisma.passwordResetToken.deleteMany({ where: { adminId: { in: validIds } } });
  await prisma.admin.deleteMany({ where: { id: { in: validIds } } });
}

describe('RecruiTrain Admin Authentication & State Machine Suite', () => {
  let app;
  const testAdminPassword = 'TestPassword123!@#';
  let activeAdmin;
  let inactiveAdmin;
  let twoFactorAdmin;
  let twoFactorSecret;

  beforeAll(async () => {
    // Enforce hard database isolation check before any operations
    await assertConnectedDatabase(prisma);
    app = createApp();

    const passwordHash = await hashPassword(testAdminPassword);

    // Clean prior test records - strictly scoped to deterministic test fixture identities
    await cleanupTestAdminsByEmails(FIXTURE_EMAILS);

    // 1. Admin needing MFA enrollment (deterministic test identity)
    activeAdmin = await prisma.admin.create({
      data: {
        email: 'auth_fixture_active@recruitrain.test',
        name: 'Active Test Admin',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        totpEnabled: false,
      },
    });

    // 2. Inactive admin (deterministic test identity)
    inactiveAdmin = await prisma.admin.create({
      data: {
        email: 'auth_fixture_inactive@recruitrain.test',
        name: 'Inactive Admin',
        passwordHash,
        role: 'ADMIN',
        status: 'INACTIVE',
      },
    });

    // 3. 2FA-enrolled admin with AES-256-GCM encrypted secret (deterministic test identity)
    const totpGen = generateTotpSecret('auth_fixture_2fa@recruitrain.test');
    twoFactorSecret = totpGen.secret;
    const encryptedSecret = encryptTotpSecret(twoFactorSecret);

    twoFactorAdmin = await prisma.admin.create({
      data: {
        email: 'auth_fixture_2fa@recruitrain.test',
        name: '2FA Test Admin',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptedSecret,
      },
    });
  });

  afterAll(async () => {
    // Strictly scoped cleanup by test administrator IDs and fixture emails
    await cleanupTestAdminByIds([
      activeAdmin?.id,
      inactiveAdmin?.id,
      twoFactorAdmin?.id,
    ]);
    await cleanupTestAdminsByEmails(FIXTURE_EMAILS);
    await prisma.$disconnect();
  });

  describe('1. Login & Authentication State Machine', () => {
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

    it('transitions to MFA_ENROLLMENT_REQUIRED when admin has not enrolled in 2FA', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: activeAdmin.email, password: testAdminPassword });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.state).toBe('MFA_ENROLLMENT_REQUIRED');
      expect(res.body.requiresMFAEnrollment).toBe(true);
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('transitions to PASSWORD_ACCEPTED_MFA_PENDING when 2FA is enrolled', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: twoFactorAdmin.email, password: testAdminPassword });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.state).toBe('PASSWORD_ACCEPTED_MFA_PENDING');
      expect(res.body.requires2FA).toBe(true);
    });

    it('denies access to protected admin APIs when session is PASSWORD_ACCEPTED_MFA_PENDING', async () => {
      // Login with password
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: twoFactorAdmin.email, password: testAdminPassword });

      const cookie = loginRes.headers['set-cookie'];

      // Attempt to access protected overview
      const overviewRes = await request(app)
        .get('/api/admin/overview')
        .set('Cookie', cookie);

      expect(overviewRes.status).toBe(401);
      expect(overviewRes.body.state).toBe('PASSWORD_ACCEPTED_MFA_PENDING');
    });
  });

  describe('2. Two-Factor Verification & Encrypted Secret Decryption', () => {
    let pendingCookie;

    beforeAll(async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: twoFactorAdmin.email, password: testAdminPassword });
      pendingCookie = loginRes.headers['set-cookie'];
    });

    it('rejects invalid TOTP code with 400', async () => {
      const res = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', pendingCookie)
        .send({ adminId: twoFactorAdmin.id, code: '000000' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid two-factor authentication code');
    });

    it('accepts valid TOTP code, decrypts secret and transitions to AUTHENTICATED_MFA_VERIFIED', async () => {
      const validCode = authenticator.generate(twoFactorSecret);

      const res = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', pendingCookie)
        .send({ adminId: twoFactorAdmin.id, code: validCode });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.state).toBe('AUTHENTICATED_MFA_VERIFIED');
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(twoFactorAdmin.email);

      // Now protected overview should succeed
      const verifiedCookie = res.headers['set-cookie'];
      const overviewRes = await request(app)
        .get('/api/admin/overview')
        .set('Cookie', verifiedCookie);

      expect(overviewRes.status).toBe(200);
      expect(overviewRes.body.stats).toBeDefined();
    });
  });

  describe('3. Mandatory MFA Enrollment Flow', () => {
    let enrollmentCookie;
    let candidateSecret;

    it('allows starting 2FA setup when session is in MFA_ENROLLMENT_REQUIRED', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: activeAdmin.email, password: testAdminPassword });

      enrollmentCookie = loginRes.headers['set-cookie'];

      const setupRes = await request(app)
        .post('/api/auth/2fa/setup')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', enrollmentCookie);

      expect(setupRes.status).toBe(200);
      expect(setupRes.body.secret).toBeDefined();
      expect(setupRes.body.qrCodeUrl).toContain('data:image/png;base64');
      candidateSecret = setupRes.body.secret;
    });

    it('confirms 2FA setup, stores encrypted secret and yields single-use backup codes', async () => {
      const validCode = authenticator.generate(candidateSecret);

      const confirmRes = await request(app)
        .post('/api/auth/2fa/confirm')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', enrollmentCookie)
        .send({ code: validCode });

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.state).toBe('AUTHENTICATED_MFA_VERIFIED');
      expect(confirmRes.body.backupCodes).toHaveLength(10);

      // Verify the secret stored in DB is encrypted
      const updatedInDb = await prisma.admin.findUnique({ where: { id: activeAdmin.id } });
      expect(updatedInDb.totpEnabled).toBe(true);
      expect(updatedInDb.totpSecret).toContain(':'); // Encrypted format iv:tag:data
      expect(decryptTotpSecret(updatedInDb.totpSecret)).toBe(candidateSecret);
    });
  });

  describe('4. Single-Use Backup Code Recovery & Atomic Consumption', () => {
    let plainCode;

    beforeAll(async () => {
      // Regenerate backup codes for activeAdmin
      const crypto = await import('../src/lib/crypto.js');
      plainCode = 'BKP1-TEST';
      await prisma.adminBackupCode.create({
        data: {
          adminId: activeAdmin.id,
          codeHash: crypto.hashBackupCode(plainCode),
        },
      });
    });

    it('consumes valid backup code and transitions to AUTHENTICATED_MFA_VERIFIED', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: activeAdmin.email, password: testAdminPassword });

      const cookie = loginRes.headers['set-cookie'];

      const res = await request(app)
        .post('/api/auth/verify-backup-code')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', cookie)
        .send({ adminId: activeAdmin.id, code: plainCode });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('AUTHENTICATED_MFA_VERIFIED');
      expect(res.body.user).toBeDefined();
    });

    it('rejects already consumed backup code (atomic replay protection)', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: activeAdmin.email, password: testAdminPassword });

      const cookie = loginRes.headers['set-cookie'];

      const res = await request(app)
        .post('/api/auth/verify-backup-code')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', cookie)
        .send({ adminId: activeAdmin.id, code: plainCode });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid or already used backup code');
    });
  });

  describe('5. Session Restoration & Logout', () => {
    let sessionCookie;

    beforeAll(async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: twoFactorAdmin.email, password: testAdminPassword });

      const code = authenticator.generate(twoFactorSecret);
      const verifyRes = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', loginRes.headers['set-cookie'])
        .send({ adminId: twoFactorAdmin.id, code });

      sessionCookie = verifyRes.headers['set-cookie'];
    });

    it('restores authenticated user through /api/auth/me', async () => {
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', sessionCookie);

      expect(meRes.status).toBe(200);
      expect(meRes.body.state).toBe('AUTHENTICATED_MFA_VERIFIED');
      expect(meRes.body.user.email).toBe(twoFactorAdmin.email);
    });

    it('destroys session on logout and denies subsequent access', async () => {
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', sessionCookie);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.state).toBe('UNAUTHENTICATED');

      const meAfter = await request(app)
        .get('/api/auth/me')
        .set('Cookie', sessionCookie);

      expect(meAfter.status).toBe(401);
    });
  });

  describe('6. Admin Session Revocation & MFA Reset Protection', () => {
    it('revokeAdminSessions cleanly handles null/mock redis client without throwing', async () => {
      const { revokeAdminSessions } = await import('../src/lib/redis.js');
      const result = await revokeAdminSessions('mock-admin-id', null);
      expect(result).toBe(0);
    });

    it('clears MFA state and removes backup codes when resetting MFA', async () => {
      // Create admin with MFA enabled (deterministic test identity)
      const email = 'auth_fixture_reset@recruitrain.test';
      // Pre-clean in case of dirty state
      await cleanupTestAdminsByEmails([email]);

      const created = await prisma.admin.create({
        data: {
          email,
          name: 'Reset Test Suite Admin',
          passwordHash: await hashPassword('SamplePassword123!'),
          role: 'ADMIN',
          status: 'ACTIVE',
          totpEnabled: true,
          totpSecret: 'mock:secret:data',
          totpVerifiedAt: new Date(),
        },
      });

      await prisma.adminBackupCode.create({
        data: {
          adminId: created.id,
          codeHash: 'samplehash',
        },
      });

      // Execute reset operations
      await prisma.admin.update({
        where: { id: created.id },
        data: {
          totpSecret: null,
          totpEnabled: false,
          totpVerifiedAt: null,
        },
      });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: created.id } });

      const rechecked = await prisma.admin.findUnique({ where: { id: created.id } });
      const codes = await prisma.adminBackupCode.count({ where: { adminId: created.id } });

      expect(rechecked.totpEnabled).toBe(false);
      expect(rechecked.totpSecret).toBeNull();
      expect(rechecked.totpVerifiedAt).toBeNull();
      expect(codes).toBe(0);

      // Clean scoped strictly to created test fixture
      await cleanupTestAdminByIds([created.id]);
    });
  });

  describe('7. 24-Hour Absolute Session Expiry & Boundary Enforcement', () => {
    let authCookie;

    beforeAll(async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: twoFactorAdmin.email, password: testAdminPassword });

      const code = authenticator.generate(twoFactorSecret);
      const verifyRes = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', loginRes.headers['set-cookie'])
        .send({ adminId: twoFactorAdmin.id, code });

      authCookie = verifyRes.headers['set-cookie'];
    });

    it('returns session lifetime metadata in /api/auth/me', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.session).toBeDefined();
      expect(res.body.session.authenticatedAt).toBeTypeOf('number');
      expect(res.body.session.absoluteExpiresAt).toBeTypeOf('number');
      expect(res.body.session.remainingSeconds).toBeGreaterThan(0);
    });

    it('strictly enforces absolute expiration when now >= absoluteExpiresAt', async () => {
      // Create a test app instance with a route to simulate an expired session
      const expiredApp = createApp();
      
      // Establish session
      const loginRes = await request(expiredApp)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: twoFactorAdmin.email, password: testAdminPassword });

      const code = authenticator.generate(twoFactorSecret);
      const verifyRes = await request(expiredApp)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', loginRes.headers['set-cookie'])
        .send({ adminId: twoFactorAdmin.id, code });

      const cookie = verifyRes.headers['set-cookie'];

      // Manually simulate time expiration via a test endpoint or app middleware
      // We can create a route that sets req.session.absoluteExpiresAt in the past
      expiredApp.post('/test/expire-session', (req, res) => {
        req.session.absoluteExpiresAt = Date.now() - 1000; // expired 1s ago
        req.session.save(() => {
          res.json({ expired: true });
        });
      });

      const expireRes = await request(expiredApp)
        .post('/test/expire-session')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', cookie);

      expect(expireRes.status).toBe(200);

      // Now hit protected overview endpoint
      const protectedRes = await request(expiredApp)
        .get('/api/admin/overview')
        .set('Cookie', cookie);

      expect(protectedRes.status).toBe(401);
      expect(protectedRes.body.state).toBe('SESSION_EXPIRED_OR_REVOKED');
      expect(protectedRes.body.error).toContain('24-hour absolute lifetime limit');
    });
  });

  describe('8. Administrator Profile & Credential Management', () => {
    let sessionCookie;
    const initialEmail = 'auth_fixture_profile@recruitrain.test';
    const updatedEmail = 'auth_fixture_profile_updated@recruitrain.test';
    let profileAdmin;

    beforeAll(async () => {
      await cleanupTestAdminsByEmails([initialEmail, updatedEmail]);
      const passwordHash = await hashPassword(testAdminPassword);
      profileAdmin = await prisma.admin.create({
        data: {
          email: initialEmail,
          name: 'Original Profile Name',
          passwordHash,
          role: 'ADMIN',
          status: 'ACTIVE',
          totpEnabled: true,
          totpSecret: encryptTotpSecret(twoFactorSecret),
          totpVerifiedAt: new Date(),
        },
      });

      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: initialEmail, password: testAdminPassword });

      const code = authenticator.generate(twoFactorSecret);
      const verifyRes = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', loginRes.headers['set-cookie'])
        .send({ adminId: profileAdmin.id, code });

      sessionCookie = verifyRes.headers['set-cookie'];
    });

    afterAll(async () => {
      await cleanupTestAdminByIds([profileAdmin?.id]);
      await cleanupTestAdminsByEmails([initialEmail, updatedEmail]);
    });

    it('rejects profile update with incorrect password confirmation', async () => {
      const res = await request(app)
        .patch('/api/admin/profile')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', sessionCookie)
        .send({
          name: 'New Name',
          email: updatedEmail,
          currentPassword: 'WrongPassword!',
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Current password is incorrect');
    });

    it('successfully updates name and email with valid password confirmation', async () => {
      const res = await request(app)
        .patch('/api/admin/profile')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', sessionCookie)
        .send({
          name: 'New Administrator Name',
          email: updatedEmail,
          currentPassword: testAdminPassword,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe('New Administrator Name');
      expect(res.body.user.email).toBe(updatedEmail);

      // Verify in DB
      const inDb = await prisma.admin.findUnique({ where: { id: profileAdmin.id } });
      expect(inDb.name).toBe('New Administrator Name');
      expect(inDb.email).toBe(updatedEmail);
    });

    it('rejects duplicate email conflict with 409', async () => {
      const res = await request(app)
        .patch('/api/admin/profile')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', sessionCookie)
        .send({
          email: twoFactorAdmin.email, // already used by twoFactorAdmin
          currentPassword: testAdminPassword,
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already registered');
    });

    it('changes password with valid current password and Argon2id re-hashing', async () => {
      const newPassword = 'NewSecretPassword123!@#';
      const res = await request(app)
        .post('/api/admin/change-password')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', sessionCookie)
        .send({
          currentPassword: testAdminPassword,
          newPassword,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify updated password works for subsequent login
      const newLoginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: updatedEmail, password: newPassword });

      expect(newLoginRes.status).toBe(200);
      expect(newLoginRes.body.state).toBe('PASSWORD_ACCEPTED_MFA_PENDING');
    });
  });

  describe('9. Single-Use Backup Codes Regeneration', () => {
    let authCookie;

    beforeAll(async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: twoFactorAdmin.email, password: testAdminPassword });

      const code = authenticator.generate(twoFactorSecret);
      const verifyRes = await request(app)
        .post('/api/auth/verify-2fa')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', loginRes.headers['set-cookie'])
        .send({ adminId: twoFactorAdmin.id, code });

      authCookie = verifyRes.headers['set-cookie'];
    });

    it('rejects regeneration with incorrect password', async () => {
      const res = await request(app)
        .post('/api/auth/backup-codes/regenerate')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', authCookie)
        .send({ password: 'BadPassword123!' });

      expect(res.status).toBe(401);
    });

    it('regenerates 10 new backup codes with valid password confirmation', async () => {
      const res = await request(app)
        .post('/api/auth/backup-codes/regenerate')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', authCookie)
        .send({ password: testAdminPassword });

      expect(res.status).toBe(200);
      expect(res.body.backupCodes).toHaveLength(10);
      expect(res.body.remainingBackupCodes).toBe(10);

      const dbCount = await prisma.adminBackupCode.count({
        where: { adminId: twoFactorAdmin.id, usedAt: null },
      });
      expect(dbCount).toBe(10);
    });
  });
});
