import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret, generateSecureToken, hashToken } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { validateEmployerAppUrl, buildEmployerActivationUrl } from '../src/config/env.js';

const TEST_ADMIN_EMAIL = 'invitation_suite_admin@recruitrain.test';
const TEST_PASSWORD = 'InvitationSecure123!@#';

describe('Phase 2 & 3: Invitation Lifecycle, Activation Contract & Company Restoration', () => {
  let app;
  let adminId;
  let adminCookie;
  let adminTotpSecret;

  const createdCompanyIds = [];
  const createdUserIds = [];

  beforeAll(async () => {
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Clean prior admin if exists
    const existingAdmin = await prisma.admin.findUnique({
      where: { email: TEST_ADMIN_EMAIL },
      select: { id: true },
    });
    if (existingAdmin) {
      await prisma.companyAuditLog.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.admin.delete({ where: { id: existingAdmin.id } });
    }

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const totpGen = generateTotpSecret(TEST_ADMIN_EMAIL);
    adminTotpSecret = totpGen.secret;
    const encryptedSecret = encryptTotpSecret(adminTotpSecret);

    const admin = await prisma.admin.create({
      data: {
        email: TEST_ADMIN_EMAIL,
        name: 'Invitation Suite Admin',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptedSecret,
      },
    });
    adminId = admin.id;

    // Login & 2FA
    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });

    const code = authenticator.generate(adminTotpSecret);
    const verifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', loginRes.headers['set-cookie'])
      .send({ adminId, code });

    adminCookie = verifyRes.headers['set-cookie'];
  });

  afterAll(async () => {
    if (createdCompanyIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyInvitation.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyUser.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
    }

    if (adminId) {
      await prisma.companyAuditLog.deleteMany({ where: { adminId } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId } });
      await prisma.authAuditLog.deleteMany({ where: { adminId } });
      await prisma.admin.deleteMany({ where: { id: adminId } });
    }
  });

  describe('1. Environment & URL Security Guards', () => {
    it('strictly rejects localhost and loopbacks when environment is production', () => {
      expect(() => validateEmployerAppUrl('http://localhost:5174', 'production')).toThrow(
        /EMPLOYER_APP_URL cannot point to localhost.*in production/i
      );
      expect(() => validateEmployerAppUrl('http://127.0.0.1:3000', 'production')).toThrow(
        /EMPLOYER_APP_URL cannot point to localhost.*in production/i
      );
      expect(() => validateEmployerAppUrl('http://0.0.0.0:8080', 'production')).toThrow(
        /EMPLOYER_APP_URL cannot point to localhost.*in production/i
      );
    });

    it('allows valid HTTPS public domains in production', () => {
      const valid = validateEmployerAppUrl('https://employer.recruitrain.com', 'production');
      expect(valid).toBe('https://employer.recruitrain.com');
    });

    it('builds valid activation URLs using configured employer base URL', () => {
      const rawToken = 'test-token-12345';
      const url = buildEmployerActivationUrl(rawToken);
      expect(url).toContain(rawToken);
      expect(url).toMatch(/activate\?token=test-token-12345/);
    });
  });

  describe('2. Invitation Verification Public Endpoint (GET /api/companies/invitations/verify)', () => {
    let company;
    let activeTokenRaw;
    let expiredTokenRaw;
    let acceptedTokenRaw;

    beforeAll(async () => {
      company = await prisma.company.create({
        data: {
          name: 'Invitation Test Corp',
          companyCode: 'INV-TEST',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(company.id);

      // Active invitation
      activeTokenRaw = generateSecureToken();
      await prisma.companyInvitation.create({
        data: {
          companyId: company.id,
          email: 'active_invitee@testcorp.com',
          role: 'ADMIN',
          tokenHash: hashToken(activeTokenRaw),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h future
        },
      });

      // Expired invitation
      expiredTokenRaw = generateSecureToken();
      await prisma.companyInvitation.create({
        data: {
          companyId: company.id,
          email: 'expired_invitee@testcorp.com',
          role: 'ADMIN',
          tokenHash: hashToken(expiredTokenRaw),
          expiresAt: new Date(Date.now() - 60 * 60 * 1000), // 1h past
        },
      });

      // Already accepted invitation
      acceptedTokenRaw = generateSecureToken();
      await prisma.companyInvitation.create({
        data: {
          companyId: company.id,
          email: 'accepted_invitee@testcorp.com',
          role: 'ADMIN',
          tokenHash: hashToken(acceptedTokenRaw),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          acceptedAt: new Date(),
        },
      });
    });

    it('returns 200 with valid=true and company context for active invitation', async () => {
      const res = await request(app)
        .get('/api/companies/invitations/verify')
        .query({ token: activeTokenRaw });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.email).toBe('active_invitee@testcorp.com');
      expect(res.body.data.company.name).toBe('Invitation Test Corp');
      expect(res.body.data.role).toBe('ADMIN');
    });

    it('returns 400 with INVITATION_EXPIRED for past expiration date', async () => {
      const res = await request(app)
        .get('/api/companies/invitations/verify')
        .query({ token: expiredTokenRaw });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVITATION_EXPIRED');
    });

    it('returns 400 with INVITATION_ALREADY_ACCEPTED for consumed invitation', async () => {
      const res = await request(app)
        .get('/api/companies/invitations/verify')
        .query({ token: acceptedTokenRaw });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('returns 404 for unknown or forged invitation token', async () => {
      const res = await request(app)
        .get('/api/companies/invitations/verify')
        .query({ token: 'completely-nonexistent-token-hash-1234567890' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Invalid or unrecognised invitation token/i);
    });
  });

  describe('3. Single-Use Activation Endpoint (POST /api/companies/invitations/activate)', () => {
    let company;
    let singleUseTokenRaw;

    beforeAll(async () => {
      company = await prisma.company.create({
        data: {
          name: 'Single Use Corp',
          companyCode: 'SINGLE-USE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(company.id);

      const user = await prisma.companyUser.create({
        data: {
          companyId: company.id,
          email: 'single_use_user@singleuse.test',
          role: 'ADMIN',
          status: 'INVITED',
        },
      });
      createdUserIds.push(user.id);

      singleUseTokenRaw = generateSecureToken();
      await prisma.companyInvitation.create({
        data: {
          companyId: company.id,
          userId: user.id,
          email: 'single_use_user@singleuse.test',
          role: 'ADMIN',
          tokenHash: hashToken(singleUseTokenRaw),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    });

    it('successfully activates account on first use and transitions user to ACTIVE', async () => {
      const res = await request(app)
        .post('/api/companies/invitations/activate')
        .set('x-test-bypass-csrf', 'true')
        .send({
          token: singleUseTokenRaw,
          firstName: 'Alice',
          lastName: 'Founder',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe('single_use_user@singleuse.test');
      expect(res.body.data.activatedAt).toBeDefined();

      // Verify DB record: user status is ACTIVE, invitation acceptedAt is stamped
      const updatedUser = await prisma.companyUser.findUnique({
        where: { id: createdUserIds[0] },
      });
      expect(updatedUser.status).toBe('ACTIVE');
      expect(updatedUser.firstName).toBe('Alice');
      expect(updatedUser.lastName).toBe('Founder');

      const invitation = await prisma.companyInvitation.findFirst({
        where: { tokenHash: hashToken(singleUseTokenRaw) },
      });
      expect(invitation.acceptedAt).not.toBeNull();
    });

    it('strictly blocks replay attacks: second attempt with same token fails (single-use guarantee)', async () => {
      const res = await request(app)
        .post('/api/companies/invitations/activate')
        .set('x-test-bypass-csrf', 'true')
        .send({
          token: singleUseTokenRaw,
          firstName: 'Attacker',
          lastName: 'Replay',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/already been accepted/i);
    });
  });

  describe('4. Company Restoration & Retention Lifecycle (POST /api/companies/:id/restore)', () => {
    it('restores soft-deleted company within retention window to IN_REVIEW status', async () => {
      const trashedCompany = await prisma.company.create({
        data: {
          name: 'Restorable Corp',
          companyCode: 'RESTORE-1',
          status: 'ACTIVE',
          deletedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
        },
      });
      createdCompanyIds.push(trashedCompany.id);

      const res = await request(app)
        .post(`/api/companies/${trashedCompany.id}/restore`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deletedAt).toBeNull();
      expect(res.body.data.status).toBe('IN_REVIEW');

      // Check audit log
      const auditLog = await prisma.companyAuditLog.findFirst({
        where: { companyId: trashedCompany.id, action: 'COMPANY_RESTORED' },
      });
      expect(auditLog).not.toBeNull();
    });

    it('rejects restore request if company is not in trash', async () => {
      const activeCompany = await prisma.company.create({
        data: {
          name: 'Non Trashed Corp',
          companyCode: 'NOT-TRASH',
          status: 'ACTIVE',
          deletedAt: null,
        },
      });
      createdCompanyIds.push(activeCompany.id);

      const res = await request(app)
        .post(`/api/companies/${activeCompany.id}/restore`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/is not in trash/i);
    });

    it('rejects restore request if trash retention window (30 days) has expired for standard ADMIN', async () => {
      // Temporarily set role to standard ADMIN to verify 30-day retention lock
      await prisma.admin.update({
        where: { id: adminId },
        data: { role: 'ADMIN' },
      });

      const expiredTrashCompany = await prisma.company.create({
        data: {
          name: 'Expired Trash Corp',
          companyCode: 'EXP-TRASH',
          status: 'ACTIVE',
          deletedAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000), // 35 days ago
        },
      });
      createdCompanyIds.push(expiredTrashCompany.id);

      const res = await request(app)
        .post(`/api/companies/${expiredTrashCompany.id}/restore`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/retention period has expired/i);

      // Restore SUPER_ADMIN role
      await prisma.admin.update({
        where: { id: adminId },
        data: { role: 'SUPER_ADMIN' },
      });
    });
  });
});
