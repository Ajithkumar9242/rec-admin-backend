import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import nodemailer from 'nodemailer';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import {
  getTransporter,
  setTransporter,
  resetTransporter,
  verifySmtpTransport,
  sendTestEmail,
  sendCompanyAdminInvitationEmail,
} from '../src/lib/mailer.js';
import { CompanyService } from '../src/modules/companies/company.service.js';

const TEST_ADMIN_EMAIL = 'mailer_test_admin@recruitrain.test';
const TEST_PASSWORD = 'MailerTestSecurePassword123!';

describe('RecruiTrain Mailer & Company Invitation Failure/Retry Regression Suite', () => {
  let app;
  let adminId;
  let adminCookie;
  let adminTotpSecret;

  const testCompanyIds = [];

  beforeAll(async () => {
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Clean prior test admins
    const existingAdmins = await prisma.admin.findMany({
      where: { email: { in: [TEST_ADMIN_EMAIL] } },
      select: { id: true },
    });
    const adminIds = existingAdmins.map((a) => a.id);
    if (adminIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    }

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const totpGen = generateTotpSecret(TEST_ADMIN_EMAIL);
    adminTotpSecret = totpGen.secret;

    const admin = await prisma.admin.create({
      data: {
        email: TEST_ADMIN_EMAIL,
        name: 'Mailer Regression Tester',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptTotpSecret(adminTotpSecret),
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
    resetTransporter();

    if (testCompanyIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: testCompanyIds } } });
      await prisma.companyInvitation.deleteMany({ where: { companyId: { in: testCompanyIds } } });
      await prisma.companyUser.deleteMany({ where: { companyId: { in: testCompanyIds } } });
      await prisma.companyDocument.deleteMany({ where: { companyId: { in: testCompanyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: testCompanyIds } } });
    }

    if (adminId) {
      await prisma.authAuditLog.deleteMany({ where: { adminId } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId } });
      await prisma.admin.deleteMany({ where: { id: adminId } });
    }
  });

  afterEach(() => {
    resetTransporter();
    vi.restoreAllMocks();
  });

  describe('1. Transport Creation & API Conformance', () => {
    it('creates transport using nodemailer.createTransport and returns a valid object', () => {
      resetTransporter();
      const spy = vi.spyOn(nodemailer, 'createTransport');
      const transporter = getTransporter();

      expect(spy).toHaveBeenCalled();
      expect(transporter).not.toBeNull();
      expect(typeof transporter.sendMail).toBe('function');
    });

    it('distinguishes transport verification from actual email delivery', async () => {
      const mockVerify = vi.fn().mockResolvedValue(true);
      const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test-msg-id-123' });

      setTransporter({
        verify: mockVerify,
        sendMail: mockSendMail,
      });

      // Transport verification should not send an email
      const verifyResult = await verifySmtpTransport();
      expect(verifyResult.success).toBe(true);
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockSendMail).not.toHaveBeenCalled();

      // Safe test email delivery should invoke sendMail
      const sendResult = await sendTestEmail({ to: 'verify@recruitrain.test' });
      expect(sendResult.success).toBe(true);
      expect(sendResult.delivered).toBe(true);
      expect(sendResult.messageId).toBe('test-msg-id-123');
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('handles transport verification rejection gracefully without throwing', async () => {
      setTransporter({
        verify: vi.fn().mockRejectedValue(new Error('Invalid login: 535-5.7.8 BadCredentials')),
        sendMail: vi.fn(),
      });

      const verifyResult = await verifySmtpTransport();
      expect(verifyResult.success).toBe(false);
      expect(verifyResult.configured).toBe(true);
      expect(verifyResult.error).toContain('BadCredentials');
    });
  });

  describe('2. Company Creation When Invitation Delivery Fails', () => {
    it('creates company successfully, records invitation as PENDING_RETRY, and returns activationUrl without rollback', async () => {
      // Mock transporter to simulate SMTP failure (e.g. Gmail 535 Bad Credentials or connection error)
      const mockSendMail = vi.fn().mockRejectedValue(new Error('SMTP connection rejected: 535 Bad credentials'));
      setTransporter({
        verify: vi.fn().mockRejectedValue(new Error('535 Bad credentials')),
        sendMail: mockSendMail,
      });

      const payload = {
        name: 'Resilient Robotics GmbH',
        companyCode: 'COMP-RESILIENT',
        email: 'contact@resilient-robotics.test',
        country: 'DE',
        initialAdminEmail: 'ceo@resilient-robotics.test',
        initialAdminFirstName: 'Elena',
        initialAdminLastName: 'Vogel',
      };

      const res = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.name).toBe('Resilient Robotics GmbH');
      testCompanyIds.push(res.body.data.id);

      // Truthful invitation reporting
      expect(res.body.invitationSent).toBe(false);
      expect(res.body.invitationStatus).toBe('PENDING_RETRY');
      expect(res.body.invitationError).toContain('535 Bad credentials');
      expect(res.body.activationUrl).toBeTruthy();
      expect(res.body.activationUrl).toContain('/activate?token=');

      // Verify Company exists in database (NOT rolled back)
      const dbCompany = await prisma.company.findUnique({
        where: { id: res.body.data.id },
      });
      expect(dbCompany).not.toBeNull();
      expect(dbCompany.companyCode).toBe('COMP-RESILIENT');

      // Verify User is created with status INVITED
      const dbUser = await prisma.companyUser.findFirst({
        where: { companyId: res.body.data.id, email: 'ceo@resilient-robotics.test' },
      });
      expect(dbUser).not.toBeNull();
      expect(dbUser.status).toBe('INVITED');

      // Verify Invitation record exists with tokenHash
      const dbInvitation = await prisma.companyInvitation.findFirst({
        where: { companyId: res.body.data.id, email: 'ceo@resilient-robotics.test' },
      });
      expect(dbInvitation).not.toBeNull();
      expect(dbInvitation.tokenHash).toHaveLength(64);
      expect(dbInvitation.acceptedAt).toBeNull();
    });

    it('does not allow duplicate company creation request to succeed with same companyCode', async () => {
      // Re-attempting full creation should be rejected to prevent duplicate entities
      const res = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Resilient Robotics GmbH Duplicate',
          companyCode: 'COMP-RESILIENT',
          email: 'duplicate@resilient-robotics.test',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('already in use');
    });
  });

  describe('3. Invitation Retry Behavior', () => {
    it('successfully retries invitation dispatch when SMTP is restored', async () => {
      const companyId = testCompanyIds[0];
      const existingInvitation = await prisma.companyInvitation.findFirst({
        where: { companyId },
      });
      expect(existingInvitation).not.toBeNull();
      const initialTokenHash = existingInvitation.tokenHash;

      // Now mock a working SMTP transport
      const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'retry-msg-id-456' });
      setTransporter({
        verify: vi.fn().mockResolvedValue(true),
        sendMail: mockSendMail,
      });

      // Call resend endpoint
      const res = await request(app)
        .post(`/api/companies/${companyId}/invitations/${existingInvitation.id}/resend`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.delivered).toBe(true);
      expect(res.body.message).toContain('resent successfully');
      expect(mockSendMail).toHaveBeenCalled();

      // Verify fresh cryptographic token was saved
      const updatedInvitation = await prisma.companyInvitation.findUnique({
        where: { id: existingInvitation.id },
      });
      expect(updatedInvitation.tokenHash).not.toBe(initialTokenHash);
      expect(updatedInvitation.tokenHash).toHaveLength(64);

      // Verify audit log entry
      const auditLog = await prisma.companyAuditLog.findFirst({
        where: {
          companyId,
          action: 'COMPANY_INVITATION_RESENT',
        },
      });
      expect(auditLog).not.toBeNull();
      expect(auditLog.actor).toBe(TEST_ADMIN_EMAIL);
    });

    it('rejects retrying an invitation that has already been accepted', async () => {
      const companyId = testCompanyIds[0];
      const existingInvitation = await prisma.companyInvitation.findFirst({
        where: { companyId },
      });

      // Mark invitation as accepted
      await prisma.companyInvitation.update({
        where: { id: existingInvitation.id },
        data: { acceptedAt: new Date() },
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/invitations/${existingInvitation.id}/resend`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('already been accepted');
    });
  });
});
