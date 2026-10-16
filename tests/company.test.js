import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret, hashToken } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import {
  isCloudinaryConfigured,
  getCloudinaryStatus,
  generateUploadSignature,
} from '../src/lib/cloudinary.js';
import {
  getMailStatus,
  escapeHtml,
  sendCompanyAdminInvitationEmail,
  sendCompanySubmissionAckEmail,
  sendCompanyApprovalEmail,
  sendCompanyRejectionEmail,
  sendCompanySuspensionEmail,
} from '../src/lib/mailer.js';
import {
  isValidVideoUrl,
  inspectFileSignature,
  validateUploadedFile,
} from '../src/lib/fileValidation.js';
import { redactSensitiveCompanyAuditData } from '../src/modules/companies/companyAudit.service.js';

const TEST_ADMIN_EMAIL = 'company_test_admin@recruitrain.test';
const TEST_PASSWORD = 'CompanySecurePassword123!@#';

describe('RecruiTrain Phase 2: Employer/Company Management Integration Suite', () => {
  let app;
  let adminId;
  let adminCookie;
  let adminTotpSecret;

  const createdCompanyIds = [];
  const createdIndustryIds = [];
  const createdDocDefIds = [];

  beforeAll(async () => {
    // 1. Verify safe test database isolation
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Clean prior test admins and test companies
    const existingAdmins = await prisma.admin.findMany({
      where: {
        email: { in: [TEST_ADMIN_EMAIL] },
      },
      select: { id: true },
    });

    const adminIds = existingAdmins.map((a) => a.id);
    if (adminIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    }

    const leftoverCompanies = await prisma.company.findMany({
      where: {
        OR: [
          { companyCode: { in: ['TEST-CODE-DUP', 'COMP-ACME'] } },
          { email: { in: ['codeA@recruitrain.test', 'codeB@recruitrain.test', 'contact@acmerobotics.test'] } },
        ],
      },
      select: { id: true },
    });
    if (leftoverCompanies.length > 0) {
      const leftoverIds = leftoverCompanies.map((c) => c.id);
      await prisma.candidateAccessLog.deleteMany({ where: { companyId: { in: leftoverIds } } });
      await prisma.payment.deleteMany({ where: { invoice: { companyId: { in: leftoverIds } } } });
      await prisma.invoice.deleteMany({ where: { companyId: { in: leftoverIds } } });
      await prisma.subscription.deleteMany({ where: { companyId: { in: leftoverIds } } });
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: leftoverIds } } });
      await prisma.companyInvitation.deleteMany({ where: { companyId: { in: leftoverIds } } });
      await prisma.companyUser.deleteMany({ where: { companyId: { in: leftoverIds } } });
      await prisma.companyDocument.deleteMany({ where: { companyId: { in: leftoverIds } } });
      await prisma.company.deleteMany({ where: { id: { in: leftoverIds } } });
    }

    const passwordHash = await hashPassword(TEST_PASSWORD);

    // Create Admin
    const totpGen = generateTotpSecret(TEST_ADMIN_EMAIL);
    adminTotpSecret = totpGen.secret;
    const admin = await prisma.admin.create({
      data: {
        email: TEST_ADMIN_EMAIL,
        name: 'Company Suite Admin Tester',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptTotpSecret(adminTotpSecret),
      },
    });
    adminId = admin.id;

    // Login & 2FA verify Admin
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

    // Seed a test industry for onboarding tests
    const industry = await prisma.industry.create({
      data: {
        name: 'Test Technology Sector',
        code: 'TECH-TEST',
        description: 'Technology industry for automated testing',
        status: 'ACTIVE',
      },
    });
    createdIndustryIds.push(industry.id);

    // Seed a test document definition
    const docDef = await prisma.documentDefinition.create({
      data: {
        targetType: 'COMPANY',
        name: 'Test Business Registration',
        code: 'BIZ-REG-TEST',
        isRequired: true,
        acceptedFileTypes: ['.pdf', 'application/pdf'],
        maxFileSizeMb: 10,
        status: 'ACTIVE',
      },
    });
    createdDocDefIds.push(docDef.id);
  });

  afterAll(async () => {
    // Scoped cleanup
    if (createdCompanyIds.length > 0) {
      await prisma.candidateAccessLog.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.payment.deleteMany({ where: { invoice: { companyId: { in: createdCompanyIds } } } });
      await prisma.invoice.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.subscription.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyInvitation.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyUser.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyDocument.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
    }

    if (createdDocDefIds.length > 0) {
      await prisma.documentDefinition.deleteMany({ where: { id: { in: createdDocDefIds } } });
    }

    if (createdIndustryIds.length > 0) {
      await prisma.industry.deleteMany({ where: { id: { in: createdIndustryIds } } });
    }

    if (adminId) {
      await prisma.authAuditLog.deleteMany({ where: { adminId } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId } });
      await prisma.admin.deleteMany({ where: { id: adminId } });
    }
  });

  // ====================================================
  // 1. Cloudinary Integration Foundation
  // ====================================================
  describe('1. Cloudinary Integration Foundation', () => {
    it('reports honest configuration status without leaking credentials', () => {
      const status = getCloudinaryStatus();
      expect(status).toHaveProperty('configured');
      expect(status).toHaveProperty('folder');
      expect(typeof status.configured).toBe('boolean');
      expect(status).not.toHaveProperty('apiKey');
      expect(status).not.toHaveProperty('apiSecret');
    });

    it('generates upload signature if configured or throws safe error if unconfigured', () => {
      if (!isCloudinaryConfigured()) {
        expect(() => generateUploadSignature()).toThrowError(/Cloudinary is not configured/);
      } else {
        const sig = generateUploadSignature({ folder: 'recruitrain/test' });
        expect(sig).toHaveProperty('signature');
        expect(sig).toHaveProperty('timestamp');
        expect(sig).toHaveProperty('apiKey');
      }
    });

    it('handles direct upload-signature endpoint through controller', async () => {
      const res = await request(app)
        .post('/api/companies/upload-signature')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({ folder: 'recruitrain/test', resourceType: 'image' });

      if (!isCloudinaryConfigured()) {
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
      } else {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveProperty('signature');
      }
    });
  });

  // ====================================================
  // 2. SMTP Integration Foundation & Security
  // ====================================================
  describe('2. SMTP Integration Foundation & Template Security', () => {
    it('reports honest SMTP configuration status', () => {
      const status = getMailStatus();
      expect(status).toHaveProperty('configured');
      expect(typeof status.configured).toBe('boolean');
      expect(status).toHaveProperty('fromName');
      expect(status).toHaveProperty('fromAddress');
    });

    it('escapes HTML special characters to prevent template injection', () => {
      const malicious = '<script>alert("xss")</script> & "quotes" \'apostrophe\'';
      const escaped = escapeHtml(malicious);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
      expect(escaped).toContain('&amp;');
      expect(escaped).toContain('&quot;');
      expect(escaped).toContain('&#039;');
    });

    it('handles invitation email dispatch gracefully even when unconfigured', async () => {
      const result = await sendCompanyAdminInvitationEmail({
        to: 'invitee@recruitrain.test',
        recipientName: 'Invitee Tester',
        companyName: 'Acme Test Corp',
        invitationUrl: 'http://localhost:5174/activate?token=testtoken123',
      });
      expect(result).toHaveProperty('success');
      expect(typeof result.delivered).toBe('boolean');
    });

    it('handles onboarding submission acknowledgement email gracefully', async () => {
      const result = await sendCompanySubmissionAckEmail({
        to: 'ack@recruitrain.test',
        recipientName: 'Ack Tester',
        companyName: 'Acme Test Corp',
      });
      expect(result).toHaveProperty('success');
    });

    it('handles approval, rejection, and suspension emails gracefully', async () => {
      const appRes = await sendCompanyApprovalEmail({
        to: 'app@recruitrain.test',
        recipientName: 'Approved Tester',
        companyName: 'Acme Test Corp',
      });
      expect(appRes).toHaveProperty('success');

      const rejRes = await sendCompanyRejectionEmail({
        to: 'rej@recruitrain.test',
        recipientName: 'Rej Tester',
        companyName: 'Acme Test Corp',
        reason: 'Missing tax document',
      });
      expect(rejRes).toHaveProperty('success');

      const suspRes = await sendCompanySuspensionEmail({
        to: 'susp@recruitrain.test',
        recipientName: 'Susp Tester',
        companyName: 'Acme Test Corp',
        reason: 'Payment delinquency',
      });
      expect(suspRes).toHaveProperty('success');
    });

    it('redacts sensitive audit log fields in company audit service', () => {
      const payload = {
        companyId: '123',
        password: 'SuperSecretPassword',
        tokenHash: 'hashedtokenvalue',
        nested: {
          secret: 'shh',
          safeField: 'visible',
        },
      };
      const sanitized = redactSensitiveCompanyAuditData(payload);
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.tokenHash).toBe('[REDACTED]');
      expect(sanitized.nested.secret).toBe('[REDACTED]');
      expect(sanitized.nested.safeField).toBe('visible');
    });
  });

  // ====================================================
  // 3. Company Onboarding Wizard (Creation)
  // ====================================================
  describe('3. Company Onboarding Wizard', () => {
    it('creates a company with complete 5-step onboarding data', async () => {
      const res = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Acme Robotics Test GmbH',
          legalName: 'Acme Robotics Germany GmbH',
          taxId: 'DE999888777',
          registrationNumber: 'HRB 12345 B',
          industryId: createdIndustryIds[0],
          companySize: '51-200',
          foundedYear: 2021,
          description: 'Autonomous robotics systems provider for logistics',
          hiringDomestic: true,
          hiringInternational: true,
          hiringEu: true,
          email: 'contact@acmerobotics.test',
          hrEmail: 'hr@acmerobotics.test',
          supportEmail: 'support@acmerobotics.test',
          phone: '+49 30 12345678',
          website: 'https://acmerobotics.test',
          addressLine1: 'Technologiepark 1',
          city: 'Berlin',
          state: 'Berlin',
          postalCode: '10115',
          country: 'DE',
          billingEmail: 'invoices@acmerobotics.test',
          logoUrl: 'https://res.cloudinary.com/test/image/upload/v1/logo.png',
          bannerUrl: 'https://res.cloudinary.com/test/image/upload/v1/banner.png',
          initialAdminEmail: 'admin@acmerobotics.test',
          initialAdminFirstName: 'Max',
          initialAdminLastName: 'Mustermann',
          documents: [
            {
              documentDefinitionId: createdDocDefIds[0],
              name: 'Gewerbeanmeldung Acme Robotics',
              fileUrl: 'https://res.cloudinary.com/test/raw/upload/v1/gewerbe.pdf',
              fileSizeBytes: 102400,
              mimeType: 'application/pdf',
              isPrivate: true,
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.name).toBe('Acme Robotics Test GmbH');
      expect(res.body.data.status).toBe('IN_REVIEW');
      expect(res.body.data.companyCode).toMatch(/^COMP-/);

      createdCompanyIds.push(res.body.data.id);

      // Verify documents created
      const docs = await prisma.companyDocument.findMany({
        where: { companyId: res.body.data.id },
      });
      expect(docs).toHaveLength(1);
      expect(docs[0].name).toBe('Gewerbeanmeldung Acme Robotics');
      expect(docs[0].reviewStatus).toBe('PENDING');

      // Verify initial admin user created
      const user = await prisma.companyUser.findFirst({
        where: { companyId: res.body.data.id },
      });
      expect(user).toBeTruthy();
      expect(user.email).toBe('admin@acmerobotics.test');
      expect(user.status).toBe('INVITED');
      expect(user.role).toBe('ADMIN');

      // Verify invitation created with tokenHash (never raw token stored)
      const invitation = await prisma.companyInvitation.findFirst({
        where: { companyId: res.body.data.id },
      });
      expect(invitation).toBeTruthy();
      expect(invitation.tokenHash).toHaveLength(64); // SHA-256 hex length

      // Verify audit log created
      const audit = await prisma.companyAuditLog.findFirst({
        where: { companyId: res.body.data.id, action: 'COMPANY_CREATED' },
      });
      expect(audit).toBeTruthy();
      expect(audit.actor).toBe(TEST_ADMIN_EMAIL);
    });

    it('rejects duplicate custom company code', async () => {
      const res1 = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Unique Code Corp A',
          companyCode: 'TEST-CODE-DUP',
          email: 'codeA@recruitrain.test',
        });

      expect(res1.status).toBe(201);
      createdCompanyIds.push(res1.body.data.id);

      const res2 = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Unique Code Corp B',
          companyCode: 'TEST-CODE-DUP',
          email: 'codeB@recruitrain.test',
        });

      expect(res2.status).toBe(400);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error).toContain('already in use');
    });

    it('validates required fields on company creation', async () => {
      const res = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'A', // min 2 characters
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ====================================================
  // 4. Company List, Pagination, Search & Sorting
  // ====================================================
  describe('4. Company List & Summary', () => {
    it('returns server-backed paginated list with honest totals', async () => {
      const res = await request(app)
        .get('/api/companies?page=1&limit=5&sortBy=createdAt&sortOrder=desc')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toHaveProperty('total');
      expect(res.body.pagination).toHaveProperty('page', 1);
      expect(res.body.pagination).toHaveProperty('limit', 5);
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('searches companies by name or code', async () => {
      const res = await request(app)
        .get('/api/companies?search=Acme+Robotics')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].name).toContain('Acme Robotics');
    });

    it('filters companies by status', async () => {
      const res = await request(app)
        .get('/api/companies?status=IN_REVIEW')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      res.body.data.forEach((comp) => {
        expect(comp.status).toBe('IN_REVIEW');
      });
    });

    it('returns accurate status breakdown counts via /status-summary', async () => {
      const res = await request(app)
        .get('/api/companies/status-summary')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('ALL');
      expect(res.body.data).toHaveProperty('IN_REVIEW');
      expect(res.body.data).toHaveProperty('ACTIVE');
      expect(res.body.data).toHaveProperty('SUSPENDED');
      expect(res.body.data.IN_REVIEW).toBeGreaterThanOrEqual(2);
    });

    it('returns single company profile by ID with full relations', async () => {
      const testCompanyId = createdCompanyIds[0];
      const res = await request(app)
        .get(`/api/companies/${testCompanyId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('id', testCompanyId);
      expect(res.body.data).toHaveProperty('documents');
      expect(res.body.data).toHaveProperty('users');
      expect(res.body.data).toHaveProperty('invitations');
      expect(res.body.data).toHaveProperty('auditLogs');
      expect(res.body.data).toHaveProperty('subscriptions');
    });
  });

  // ====================================================
  // 5. Company Status & Review Workflow
  // ====================================================
  describe('5. Company Status Lifecycle & Review Decisions', () => {
    it('approves an onboarding application through formal review', async () => {
      const testCompanyId = createdCompanyIds[0];

      const res = await request(app)
        .post(`/api/companies/${testCompanyId}/review`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          decision: 'APPROVE',
          notes: 'All registration documents verified successfully by compliance',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.reviewedBy).toBe(TEST_ADMIN_EMAIL);
      expect(res.body.data.reviewedAt).toBeTruthy();

      // Verify audit log
      const audit = await prisma.companyAuditLog.findFirst({
        where: { companyId: testCompanyId, action: 'COMPANY_REVIEWED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeTruthy();
      expect(audit.details.decision).toBe('APPROVE');
    });

    it('requires a reason when suspending a company', async () => {
      const testCompanyId = createdCompanyIds[0];

      const failRes = await request(app)
        .patch(`/api/companies/${testCompanyId}/status`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          status: 'SUSPENDED',
        });

      expect(failRes.status).toBe(400);
      expect(failRes.body.error).toContain('reason is mandatory');

      const successRes = await request(app)
        .patch(`/api/companies/${testCompanyId}/status`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          status: 'SUSPENDED',
          reason: 'Terms of service compliance review pending',
        });

      expect(successRes.status).toBe(200);
      expect(successRes.body.data.status).toBe('SUSPENDED');
      expect(successRes.body.data.suspensionReason).toBe('Terms of service compliance review pending');
    });

    it('reactivates a suspended company', async () => {
      const testCompanyId = createdCompanyIds[0];

      const res = await request(app)
        .patch(`/api/companies/${testCompanyId}/status`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          status: 'ACTIVE',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.suspensionReason).toBeNull();
    });

    it('rejects an onboarding application requiring a rejection reason', async () => {
      const testCompanyId = createdCompanyIds[1]; // Unique Code Corp A

      const failRes = await request(app)
        .post(`/api/companies/${testCompanyId}/review`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          decision: 'REJECT',
        });

      expect(failRes.status).toBe(400);
      expect(failRes.body.error).toContain('rejection reason is required');

      const successRes = await request(app)
        .post(`/api/companies/${testCompanyId}/review`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          decision: 'REJECT',
          rejectionReason: 'Invalid registration document provided',
        });

      expect(successRes.status).toBe(200);
      expect(successRes.body.data.status).toBe('INACTIVE');
      expect(successRes.body.data.rejectionReason).toBe('Invalid registration document provided');
    });
  });

  // ====================================================
  // 6. Company Document Operations & Privacy
  // ====================================================
  describe('6. Company Document Verification & Privacy', () => {
    let testDocId;

    it('adds a new verification document to an existing company', async () => {
      const testCompanyId = createdCompanyIds[0];

      const res = await request(app)
        .post(`/api/companies/${testCompanyId}/documents`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Tax ID Confirmation',
          fileUrl: 'https://res.cloudinary.com/test/raw/upload/v1/tax_id.pdf',
          fileSizeBytes: 51200,
          mimeType: 'application/pdf',
          isPrivate: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.reviewStatus).toBe('PENDING');
      expect(res.body.data.isPrivate).toBe(true);

      testDocId = res.body.data.id;
    });

    it('reviews a company document (approve)', async () => {
      const testCompanyId = createdCompanyIds[0];

      const res = await request(app)
        .patch(`/api/companies/${testCompanyId}/documents/${testDocId}/review`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          decision: 'APPROVE',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.reviewStatus).toBe('APPROVED');
      expect(res.body.data.reviewedBy).toBe(TEST_ADMIN_EMAIL);
    });

    it('gets private document download link', async () => {
      const testCompanyId = createdCompanyIds[0];

      const res = await request(app)
        .get(`/api/companies/${testCompanyId}/documents/${testDocId}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('url');
    });

    it('deletes a company document', async () => {
      const testCompanyId = createdCompanyIds[0];

      const res = await request(app)
        .delete(`/api/companies/${testCompanyId}/documents/${testDocId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const found = await prisma.companyDocument.findUnique({ where: { id: testDocId } });
      expect(found).toBeNull();
    });
  });

  // ====================================================
  // 7. Team & Administrator Invitations
  // ====================================================
  describe('7. Team & Administrator Invitations', () => {
    it('dispatches a new invitation to a company team member', async () => {
      const testCompanyId = createdCompanyIds[0];

      const res = await request(app)
        .post(`/api/companies/${testCompanyId}/invitations`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          email: 'recruiter_team@acmerobotics.test',
          role: 'RECRUITER',
          firstName: 'Clara',
          lastName: 'Recruiter',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.email).toBe('recruiter_team@acmerobotics.test');
      expect(res.body.data.role).toBe('RECRUITER');
      expect(res.body.data).not.toHaveProperty('tokenHash'); // Must never expose hash to client

      // Verify user created
      const user = await prisma.companyUser.findUnique({
        where: {
          companyId_email: {
            companyId: testCompanyId,
            email: 'recruiter_team@acmerobotics.test',
          },
        },
      });
      expect(user).toBeTruthy();
      expect(user.role).toBe('RECRUITER');
      expect(user.status).toBe('INVITED');
    });
  });

  // ====================================================
  // 8. Authentication & RBAC Security Enforcement
  // ====================================================
  describe('8. Authentication & RBAC Security Enforcement', () => {
    it('rejects unauthenticated requests to company endpoints (401)', async () => {
      const res = await request(app).get('/api/companies');
      expect(res.status).toBe(401);
    });

    it('rejects authenticated session without verified 2FA (401 PASSWORD_ACCEPTED_MFA_PENDING)', async () => {
      // Login without 2FA
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });

      const res = await request(app)
        .get('/api/companies')
        .set('Cookie', loginRes.headers['set-cookie']);

      expect(res.status).toBe(401);
      expect(res.body.state).toBe('PASSWORD_ACCEPTED_MFA_PENDING');
    });
  });

  // ====================================================
  // 9. File Signature, PDF Validation, & Video Security
  // ====================================================
  describe('9. File Signature, PDF Validation, & Video Security', () => {
    it('detects legitimate PDF magic numbers (%PDF-)', () => {
      const pdfBuffer = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj');
      const sig = inspectFileSignature(pdfBuffer);
      expect(sig.detectedType).toBe('application/pdf');
      expect(sig.isExecutable).toBe(false);
    });

    it('detects and flags dangerous Windows PE executables (MZ)', () => {
      const exeBuffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00]);
      const sig = inspectFileSignature(exeBuffer);
      expect(sig.detectedType).toBe('application/x-dosexec');
      expect(sig.isExecutable).toBe(true);
    });

    it('rejects executable file masquerading as a PDF', () => {
      const disguisedExe = {
        originalname: 'innocent_report.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00]),
        size: 6,
      };

      expect(() => validateUploadedFile(disguisedExe)).toThrow(
        /executable payload/i
      );
    });

    it('rejects dangerous script extensions (.exe, .sh, .bat)', () => {
      const scriptFile = {
        originalname: 'script.sh',
        mimetype: 'application/x-sh',
        buffer: Buffer.from('#!/bin/bash\necho "exploit"'),
        size: 25,
      };

      expect(() => validateUploadedFile(scriptFile)).toThrow(
        /dangerous or executable file format/i
      );
    });

    it('enforces DocumentDefinition maximum size limits', () => {
      const largePdf = {
        originalname: 'large.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4...'),
        size: 15 * 1024 * 1024, // 15MB
      };

      const definition = {
        name: 'Registration Document',
        maxFileSizeMb: 5,
        acceptedFileTypes: ['pdf'],
      };

      expect(() => validateUploadedFile(largePdf, { definition })).toThrow(
        /exceeds the maximum allowed limit of 5 MB/i
      );
    });

    it('strictly validates video URLs for YouTube, Vimeo, and Cloudinary only', () => {
      // Valid URLs
      expect(isValidVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
      expect(isValidVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
      expect(isValidVideoUrl('https://vimeo.com/123456789')).toBe(true);
      expect(isValidVideoUrl('https://res.cloudinary.com/test-cloud/video/upload/v1234/promo.mp4')).toBe(true);

      // Invalid / Dangerous URLs
      expect(isValidVideoUrl('<iframe src="https://evil.com"></iframe>')).toBe(false);
      expect(isValidVideoUrl('javascript:alert(1)')).toBe(false);
      expect(isValidVideoUrl('https://unsupported-video-host.com/video.mp4')).toBe(false);
    });
  });

  // ====================================================
  // 10. File Upload Route & Cloudinary Safety Behavior
  // ====================================================
  describe('10. File Upload Route & Cloudinary Safety Behavior', () => {
    it('rejects upload when Cloudinary credentials are not configured (returns 503, no simulated success)', async () => {
      // If Cloudinary is not configured in this test environment, uploading must return 503
      if (!isCloudinaryConfigured()) {
        const pdfContent = Buffer.from('%PDF-1.4\n%valid_pdf_content');
        const res = await request(app)
          .post('/api/companies/upload')
          .set('x-test-bypass-csrf', 'true')
          .set('Cookie', adminCookie)
          .field('type', 'document')
          .attach('file', pdfContent, 'compliance_doc.pdf');

        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Cloudinary storage service is not configured/i);
      }
    });

    it('rejects company creation with invalid promoVideoUrl', async () => {
      const res = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Invalid Video Test Company',
          promoVideoUrl: '<script>alert("xss")</script>',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ====================================================
  // 11. Company Directory Actions: Edit & Soft/Hard Delete Lifecycle
  // ====================================================
  describe('11. Company Directory Actions: Edit & Soft/Hard Delete Lifecycle', () => {
    let testCompany;

    beforeAll(async () => {
      testCompany = await prisma.company.create({
        data: {
          name: 'Directory Action Corp',
          legalName: 'Directory Action AG',
          companyCode: 'COMP-ACTION-1',
          email: 'actions@directorycorp.test',
          country: 'DE',
          status: 'ACTIVE',
          industryId: createdIndustryIds[0],
        },
      });
      createdCompanyIds.push(testCompany.id);
    });

    it('successfully updates company identity and preferences via PUT and PATCH', async () => {
      // Test PATCH /api/companies/:id
      const patchRes = await request(app)
        .patch(`/api/companies/${testCompany.id}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Directory Action Updated GmbH',
          legalName: 'Directory Action Germany AG',
          phone: '+49 89 98765432',
          hiringDomestic: true,
          hiringEu: true,
          hiringInternational: false,
          city: 'Munich',
          postalCode: '80331',
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.success).toBe(true);
      expect(patchRes.body.data.name).toBe('Directory Action Updated GmbH');
      expect(patchRes.body.data.city).toBe('Munich');
      expect(patchRes.body.data.hiringDomestic).toBe(true);

      // Verify persistence in PostgreSQL
      const persisted = await prisma.company.findUnique({
        where: { id: testCompany.id },
      });
      expect(persisted.name).toBe('Directory Action Updated GmbH');
      expect(persisted.phone).toBe('+49 89 98765432');
      expect(persisted.city).toBe('Munich');

      // Test PUT /api/companies/:id alias
      const putRes = await request(app)
        .put(`/api/companies/${testCompany.id}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Directory Action Corp Refined',
          description: 'Updated via PUT request',
        });

      expect(putRes.status).toBe(200);
      expect(putRes.body.data.name).toBe('Directory Action Corp Refined');
      expect(putRes.body.data.description).toBe('Updated via PUT request');

      // Verify audit log
      const audit = await prisma.companyAuditLog.findFirst({
        where: { companyId: testCompany.id, action: 'COMPANY_UPDATED' },
      });
      expect(audit).toBeTruthy();
    });

    it('rejects update with conflicting duplicate companyCode', async () => {
      // Create another company with unique code
      const secondComp = await prisma.company.create({
        data: {
          name: 'Code Collide GmbH',
          companyCode: 'COMP-COLLIDE-99',
          email: 'collide@recruitrain.test',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(secondComp.id);

      // Try to update testCompany to use secondComp's code
      const res = await request(app)
        .patch(`/api/companies/${testCompany.id}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          companyCode: 'COMP-COLLIDE-99',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/already in use/i);
    });

    it('rejects update with invalid website URL schema', async () => {
      const res = await request(app)
        .patch(`/api/companies/${testCompany.id}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          website: 'not-a-valid-url',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Validation failed/i);
    });

    it('rejects update or delete without authentication (401)', async () => {
      const patchRes = await request(app)
        .patch(`/api/companies/${testCompany.id}`)
        .send({ name: 'Hacked Corp' });
      expect(patchRes.status).toBe(401);

      const deleteRes = await request(app)
        .delete(`/api/companies/${testCompany.id}?mode=MOVE_TO_TRASH`);
      expect(deleteRes.status).toBe(401);
    });

    it('moves company to trash with 30-day retention and excludes from active list (MOVE_TO_TRASH)', async () => {
      const trashCompany = await prisma.company.create({
        data: {
          name: 'Trash Candidate GmbH',
          companyCode: 'COMP-TRASH-1',
          email: 'trash@candidate.test',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(trashCompany.id);

      // Execute soft-delete
      const res = await request(app)
        .delete(`/api/companies/${trashCompany.id}`)
        .query({ mode: 'MOVE_TO_TRASH' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mode).toBe('MOVE_TO_TRASH');
      expect(res.body.data.retentionDays).toBe(30);

      // Verify in DB that deletedAt is populated and status is INACTIVE
      const dbRecord = await prisma.company.findUnique({
        where: { id: trashCompany.id },
      });
      expect(dbRecord.deletedAt).not.toBeNull();
      expect(dbRecord.status).toBe('INACTIVE');

      // Verify excluded from active listCompanies endpoint
      const listRes = await request(app)
        .get('/api/companies')
        .query({ search: 'Trash Candidate GmbH' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(listRes.status).toBe(200);
      expect(listRes.body.data.find((c) => c.id === trashCompany.id)).toBeUndefined();

      // Verify GET /api/companies?trashed=true returns the soft-deleted company
      const trashListRes = await request(app)
        .get('/api/companies')
        .query({ trashed: 'true', search: 'Trash Candidate GmbH' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(trashListRes.status).toBe(200);
      expect(trashListRes.body.data.find((c) => c.id === trashCompany.id)).toBeDefined();

      // Verify status-summary includes TRASH count
      const summaryRes = await request(app)
        .get('/api/companies/status-summary')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(summaryRes.status).toBe(200);
      expect(summaryRes.body.data.TRASH).toBeGreaterThanOrEqual(1);

      // Verify update on soft-deleted company returns 404
      const updateTrashed = await request(app)
        .patch(`/api/companies/${trashCompany.id}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({ name: 'Cannot Update Deleted' });

      expect(updateTrashed.status).toBe(404);
    });

    it('supports GET /api/companies with sortBy=deletedAt&sortOrder=desc&trashed=true and orders recently trashed first', async () => {
      const olderDate = new Date(Date.now() - 5 * 24 * 3600 * 1000); // 5 days ago
      const newerDate = new Date(Date.now() - 1 * 3600 * 1000); // 1 hour ago

      const olderTrashedComp = await prisma.company.create({
        data: {
          name: 'AAA Older Trashed Corp',
          companyCode: 'COMP-TRASH-OLD',
          email: 'old_trash@test.com',
          country: 'DE',
          status: 'INACTIVE',
          deletedAt: olderDate,
        },
      });
      createdCompanyIds.push(olderTrashedComp.id);

      const newerTrashedComp = await prisma.company.create({
        data: {
          name: 'ZZZ Newer Trashed Corp',
          companyCode: 'COMP-TRASH-NEW',
          email: 'new_trash@test.com',
          country: 'DE',
          status: 'INACTIVE',
          deletedAt: newerDate,
        },
      });
      createdCompanyIds.push(newerTrashedComp.id);

      // Query with sortBy=deletedAt&sortOrder=desc&trashed=true
      const res = await request(app)
        .get('/api/companies')
        .query({
          page: 1,
          limit: 10,
          sortBy: 'deletedAt',
          sortOrder: 'desc',
          trashed: 'true',
        })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);

      // Verify newer trashed company appears before older trashed company
      const newIndex = res.body.data.findIndex((c) => c.id === newerTrashedComp.id);
      const oldIndex = res.body.data.findIndex((c) => c.id === olderTrashedComp.id);

      expect(newIndex).toBeGreaterThanOrEqual(0);
      expect(oldIndex).toBeGreaterThanOrEqual(0);
      expect(newIndex).toBeLessThan(oldIndex);

      // Normal listing (without trashed=true) must NOT contain either trashed company
      const activeRes = await request(app)
        .get('/api/companies')
        .query({ page: 1, limit: 100 })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(activeRes.status).toBe(200);
      expect(activeRes.body.data.some((c) => c.id === olderTrashedComp.id)).toBe(false);
      expect(activeRes.body.data.some((c) => c.id === newerTrashedComp.id)).toBe(false);
    });

    it('rejects invalid sortBy fields with HTTP 400', async () => {
      const res = await request(app)
        .get('/api/companies')
        .query({
          sortBy: 'unsupportedField',
          trashed: 'true',
        })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.issues?.some((i) => i.field === 'sortBy')).toBe(true);
    });

    it('restores soft-deleted company back to active directory and removes from trash list', async () => {
      const trashedComp = await prisma.company.create({
        data: {
          name: 'Restore Roundtrip Corp',
          companyCode: 'COMP-RESTORE-RT',
          email: 'restore_rt@candidate.test',
          country: 'DE',
          status: 'INACTIVE',
          deletedAt: new Date(),
        },
      });
      createdCompanyIds.push(trashedComp.id);

      // Verify listed in trash view
      const inTrashRes = await request(app)
        .get('/api/companies')
        .query({ trashed: 'true', search: 'Restore Roundtrip Corp' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);
      expect(inTrashRes.status).toBe(200);
      expect(inTrashRes.body.data.some((c) => c.id === trashedComp.id)).toBe(true);

      // Restore
      const restoreRes = await request(app)
        .post(`/api/companies/${trashedComp.id}/restore`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.success).toBe(true);

      // Verify no longer in trash view
      const afterTrashRes = await request(app)
        .get('/api/companies')
        .query({ trashed: 'true', search: 'Restore Roundtrip Corp' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);
      expect(afterTrashRes.status).toBe(200);
      expect(afterTrashRes.body.data.some((c) => c.id === trashedComp.id)).toBe(false);

      // Verify now present in active directory
      const activeListRes = await request(app)
        .get('/api/companies')
        .query({ search: 'Restore Roundtrip Corp' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);
      expect(activeListRes.status).toBe(200);
      expect(activeListRes.body.data.some((c) => c.id === trashedComp.id)).toBe(true);
    });

    it('prevents permanent deletion (DELETE_PERMANENTLY) when company has dependent compliance documents', async () => {
      const depCompany = await prisma.company.create({
        data: {
          name: 'Dependent Guard Corp',
          companyCode: 'COMP-DEP-1',
          email: 'deps@guard.test',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(depCompany.id);

      // Add a compliance document
      await prisma.companyDocument.create({
        data: {
          companyId: depCompany.id,
          name: 'Legal Registration Form',
          fileUrl: 'https://res.cloudinary.com/test/raw/upload/v1/reg.pdf',
          fileSizeBytes: 2048,
          mimeType: 'application/pdf',
          isPrivate: true,
        },
      });

      // Attempt hard-delete
      const res = await request(app)
        .delete(`/api/companies/${depCompany.id}`)
        .query({ mode: 'DELETE_PERMANENTLY' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/1 compliance document\(s\)/i);
      expect(res.body.error).toMatch(/Move to Trash/i);

      // Verify company still exists in DB
      const stillExists = await prisma.company.findUnique({
        where: { id: depCompany.id },
      });
      expect(stillExists).toBeTruthy();
    });

    it('prevents permanent deletion (DELETE_PERMANENTLY) when company has company users or subscriptions', async () => {
      const userComp = await prisma.company.create({
        data: {
          name: 'User Dependent Corp',
          companyCode: 'COMP-DEP-2',
          email: 'users@dep.test',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(userComp.id);

      // Add a company user
      await prisma.companyUser.create({
        data: {
          companyId: userComp.id,
          email: 'emp_member@dep.test',
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });

      // Attempt hard-delete
      const res = await request(app)
        .delete(`/api/companies/${userComp.id}`)
        .query({ mode: 'DELETE_PERMANENTLY' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/1 user account\(s\)/i);
    });

    it('allows permanent deletion (DELETE_PERMANENTLY) when company has zero dependencies', async () => {
      const cleanCompany = await prisma.company.create({
        data: {
          name: 'Clean Purge Corp',
          companyCode: 'COMP-PURGE-1',
          email: 'purge@clean.test',
          country: 'DE',
          status: 'IN_REVIEW',
        },
      });

      const res = await request(app)
        .delete(`/api/companies/${cleanCompany.id}`)
        .query({ mode: 'DELETE_PERMANENTLY' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mode).toBe('DELETE_PERMANENTLY');

      // Verify truly gone from PostgreSQL
      const record = await prisma.company.findUnique({
        where: { id: cleanCompany.id },
      });
      expect(record).toBeNull();
    });
  });
});
