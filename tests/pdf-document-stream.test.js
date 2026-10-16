import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { setTransporter, resetTransporter } from '../src/lib/mailer.js';

const TEST_ADMIN_EMAIL = 'pdf_stream_admin@recruitrain.test';
const TEST_REGULAR_ADMIN_EMAIL = 'pdf_regular_admin@recruitrain.test';
const TEST_PASSWORD = 'DocSecurePassword123!@#';

describe('PDF Document Integrity, Compliance Uploads & Company Error Handling Suite', () => {
  let app;
  let adminCookie;
  let adminId;
  let regularAdminCookie;
  let regularAdminId;
  const createdCompanyIds = [];

  // Minimal non-sensitive authentic PDF fixture
  const testPdfBuffer = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Title (Confidential Registration Document) /Producer (RecruiTrain Test) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
  );
  const testPdfHash = crypto.createHash('sha256').update(testPdfBuffer).digest('hex');

  beforeAll(async () => {
    // 1. Enforce test database safety guard
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Clean prior test admins
    const existingAdmins = await prisma.admin.findMany({
      where: { email: { in: [TEST_ADMIN_EMAIL, TEST_REGULAR_ADMIN_EMAIL] } },
      select: { id: true },
    });
    const adminIds = existingAdmins.map((a) => a.id);
    if (adminIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    }

    // Create test super admin with active 2FA
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const totpGen = generateTotpSecret(TEST_ADMIN_EMAIL);
    const rawTotpSecret = totpGen.secret;
    const totpSecretEncrypted = encryptTotpSecret(rawTotpSecret);

    const admin = await prisma.admin.create({
      data: {
        email: TEST_ADMIN_EMAIL,
        name: 'PDF Test Administrator',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpSecret: totpSecretEncrypted,
        totpEnabled: true,
      },
    });
    adminId = admin.id;

    // Login step 1: credentials
    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });

    expect(loginRes.status).toBe(200);

    // Login step 2: 2FA verify
    const code = authenticator.generate(rawTotpSecret);
    const verifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', loginRes.headers['set-cookie'])
      .send({ adminId, code });

    expect(verifyRes.status).toBe(200);
    adminCookie = verifyRes.headers['set-cookie'];

    // Create regular ADMIN (not SUPER_ADMIN)
    const regTotpGen = generateTotpSecret(TEST_REGULAR_ADMIN_EMAIL);
    const regAdmin = await prisma.admin.create({
      data: {
        email: TEST_REGULAR_ADMIN_EMAIL,
        name: 'Regular Admin Tester',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        totpSecret: encryptTotpSecret(regTotpGen.secret),
        totpEnabled: true,
      },
    });
    regularAdminId = regAdmin.id;

    const regLoginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: TEST_REGULAR_ADMIN_EMAIL, password: TEST_PASSWORD });
    const regCode = authenticator.generate(regTotpGen.secret);
    const regVerifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', regLoginRes.headers['set-cookie'])
      .send({ adminId: regularAdminId, code: regCode });
    regularAdminCookie = regVerifyRes.headers['set-cookie'];
  });

  afterAll(async () => {
    resetTransporter();
    if (createdCompanyIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyDocument.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyInvitation.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.companyUser.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
    }
    const cleanAdminIds = [adminId, regularAdminId].filter(Boolean);
    if (cleanAdminIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { adminId: { in: cleanAdminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: cleanAdminIds } } });
    }
    await prisma.$disconnect();
  });

  describe('Duplicate Company Code Conflict Handling (Section D)', () => {
    it('returns structured 409 conflict when company code is duplicate', async () => {
      const code = 'DUPCODE' + Math.floor(Math.random() * 899 + 100);

      // 1. Create first company with code
      const firstRes = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Original Code Company',
          companyCode: code,
          country: 'DE',
        });

      expect(firstRes.status).toBe(201);
      createdCompanyIds.push(firstRes.body.data.id);

      // 2. Attempt creating second company with same code
      const dupRes = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Duplicate Code Company',
          companyCode: code,
          country: 'DE',
        });

      expect([400, 409]).toContain(dupRes.status);
      expect(dupRes.body.success).toBe(false);
      expect(dupRes.body.code).toBe('DUPLICATE_COMPANY_CODE');
      expect(dupRes.body.field).toBe('companyCode');
      expect(dupRes.body.error).toContain(`Company code "${code}" is already in use`);
    });
  });

  describe('Company Creation Resilience during SMTP Failure (Section C)', () => {
    it('creates company successfully and marks invitation PENDING_RETRY when SMTP fails', async () => {
      // Mock broken transporter
      setTransporter({
        sendMail: async () => {
          const err = new Error('Invalid login: 535 5.7.8 BadCredentials');
          throw err;
        },
      });

      const res = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Resilient Onboarding Inc',
          country: 'DE',
          initialAdminFirstName: 'Bob',
          initialAdminLastName: 'Builder',
          initialAdminEmail: 'bob.builder@resilient.test',
          sendInvitation: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.invitationSent).toBe(false);
      expect(res.body.invitationStatus).toBe('PENDING_RETRY');
      expect(res.body).toHaveProperty('activationUrl');
      expect(res.body.activationUrl).toContain('/activate?token=');

      createdCompanyIds.push(res.body.data.id);
      resetTransporter();
    });
  });

  describe('PDF Document Upload, Storage & Binary Stream (Section A & B)', () => {
    let companyId;
    let documentId;

    it('attaches a compliance document and verifies binary stream preserving 100% SHA-256 hash', async () => {
      // 1. Create company
      const compRes = await request(app)
        .post('/api/companies')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          name: 'Document Stream Test Company',
          country: 'DE',
        });
      expect(compRes.status).toBe(201);
      companyId = compRes.body.data.id;
      createdCompanyIds.push(companyId);

      // 2. Attach PDF document with mock URL stored
      // Using an HTTP URL fixture to test streaming proxy validation
      const doc = await prisma.companyDocument.create({
        data: {
          companyId,
          name: 'Commercial_Register_Extract.pdf',
          fileUrl: 'https://cdn.example.com/mock-doc.pdf',
          fileSizeBytes: testPdfBuffer.length,
          mimeType: 'application/pdf',
          isPrivate: true,
          reviewStatus: 'PENDING',
        },
      });
      documentId = doc.id;

      // Mock global fetch for remote document proxy test
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (url.includes('mock-doc.pdf') || url.includes('cloudinary')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              'content-type': 'application/pdf',
              'content-length': String(testPdfBuffer.length),
            }),
            arrayBuffer: async () => testPdfBuffer.buffer.slice(testPdfBuffer.byteOffset, testPdfBuffer.byteOffset + testPdfBuffer.byteLength),
          };
        }
        return originalFetch(url);
      };

      try {
        // 3. Request download/stream via backend proxy
        const streamRes = await request(app)
          .get(`/api/companies/${companyId}/documents/${documentId}/file?disposition=attachment`)
          .set('x-test-bypass-csrf', 'true')
          .set('Cookie', adminCookie)
          .buffer()
          .parse((res, callback) => {
            res.data = [];
            res.on('data', (chunk) => res.data.push(chunk));
            res.on('end', () => callback(null, Buffer.concat(res.data)));
          });

        expect(streamRes.status).toBe(200);
        expect(streamRes.headers['content-type']).toContain('application/pdf');
        expect(streamRes.headers['content-disposition']).toContain('attachment');
        expect(streamRes.headers['content-disposition']).toContain('Commercial_Register_Extract.pdf');

        const receivedBuffer = streamRes.body;
        expect(receivedBuffer.length).toBe(testPdfBuffer.length);
        expect(receivedBuffer.subarray(0, 5).toString()).toBe('%PDF-');

        const receivedHash = crypto.createHash('sha256').update(receivedBuffer).digest('hex');
        expect(receivedHash).toBe(testPdfHash);

        // 4. Test preview route
        const previewRes = await request(app)
          .get(`/api/companies/${companyId}/documents/${documentId}/preview`)
          .set('x-test-bypass-csrf', 'true')
          .set('Cookie', adminCookie)
          .buffer()
          .parse((res, callback) => {
            res.data = [];
            res.on('data', (chunk) => res.data.push(chunk));
            res.on('end', () => callback(null, Buffer.concat(res.data)));
          });

        expect(previewRes.status).toBe(200);
        expect(previewRes.headers['content-disposition']).toContain('inline');

        // 5. Test JSON download link generator returns stream proxy URLs
        const linkRes = await request(app)
          .get(`/api/companies/${companyId}/documents/${documentId}/download`)
          .set('x-test-bypass-csrf', 'true')
          .set('Cookie', adminCookie);

        expect(linkRes.status).toBe(200);
        expect(linkRes.body.success).toBe(true);
        expect(linkRes.body.data.downloadUrl).toContain(`/api/companies/${companyId}/documents/${documentId}/file?disposition=attachment`);
        expect(linkRes.body.data.previewUrl).toContain(`/api/companies/${companyId}/documents/${documentId}/file?disposition=inline`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('rejects unauthenticated document file streaming requests', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/documents/${documentId}/file`);

      expect(res.status).toBe(401);
    });

    it('returns structured 502 error when storage returns a corrupted non-PDF payload', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => Buffer.from('{"error":{"message":"Resource not found"}}'),
      });

      try {
        const res = await request(app)
          .get(`/api/companies/${companyId}/documents/${documentId}/file`)
          .set('x-test-bypass-csrf', 'true')
          .set('Cookie', adminCookie);

        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('corrupted or not a valid PDF');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('handles public document download delivering direct public URL without proxying', async () => {
      const publicDoc = await prisma.companyDocument.create({
        data: {
          companyId,
          name: 'Public_Corporate_Brochure.pdf',
          fileUrl: 'https://cdn.example.com/public-brochure.pdf',
          fileSizeBytes: 1024,
          mimeType: 'application/pdf',
          isPrivate: false,
          reviewStatus: 'APPROVED',
        },
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/documents/${publicDoc.id}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isPrivate).toBe(false);
      expect(res.body.data.downloadUrl).toBe('https://cdn.example.com/public-brochure.pdf');
    });

    it('blocks document file streaming when company is moved to trash', async () => {
      const trashedComp = await prisma.company.create({
        data: {
          name: 'Trashed Company For Docs',
          companyCode: 'TRASH' + Math.floor(Math.random() * 899 + 100),
          country: 'DE',
          status: 'INACTIVE',
          deletedAt: new Date(),
          documents: {
            create: {
              name: 'Trashed_Doc.pdf',
              fileUrl: 'https://cdn.example.com/trashed.pdf',
              isPrivate: true,
            },
          },
        },
        include: { documents: true },
      });
      createdCompanyIds.push(trashedComp.id);

      const res = await request(app)
        .get(`/api/companies/${trashedComp.id}/documents/${trashedComp.documents[0].id}/file`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('trash');
    });

    it('blocks document access for inactive company when requested by non-superadmin', async () => {
      const inactiveComp = await prisma.company.create({
        data: {
          name: 'Inactive Company For Docs',
          companyCode: 'INACT' + Math.floor(Math.random() * 899 + 100),
          country: 'DE',
          status: 'INACTIVE',
          documents: {
            create: {
              name: 'Inactive_Doc.pdf',
              fileUrl: 'https://cdn.example.com/inactive.pdf',
              isPrivate: true,
            },
          },
        },
        include: { documents: true },
      });
      createdCompanyIds.push(inactiveComp.id);

      // Access by regular ADMIN -> 403 Forbidden
      const regRes = await request(app)
        .get(`/api/companies/${inactiveComp.id}/documents/${inactiveComp.documents[0].id}/file`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', regularAdminCookie);

      expect(regRes.status).toBe(403);
      expect(regRes.body.error).toContain('inactive');

      // Access by SUPER_ADMIN -> permitted past status check
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: async () => testPdfBuffer.buffer.slice(testPdfBuffer.byteOffset, testPdfBuffer.byteOffset + testPdfBuffer.byteLength),
      });

      try {
        const superRes = await request(app)
          .get(`/api/companies/${inactiveComp.id}/documents/${inactiveComp.documents[0].id}/file`)
          .set('x-test-bypass-csrf', 'true')
          .set('Cookie', adminCookie);

        expect(superRes.status).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns 404 when document or company does not exist', async () => {
      const fakeDocId = crypto.randomUUID();
      const fakeCompId = crypto.randomUUID();

      const docNotFoundRes = await request(app)
        .get(`/api/companies/${companyId}/documents/${fakeDocId}/file`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(docNotFoundRes.status).toBe(404);

      const compNotFoundRes = await request(app)
        .get(`/api/companies/${fakeCompId}/documents/${fakeDocId}/file`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(compNotFoundRes.status).toBe(404);
    });
  });

  describe('Company Lifecycle & 30-Day Retention Protection (Section E)', () => {
    it('blocks DELETE_PERMANENTLY when company contains compliance documents or users', async () => {
      const company = await prisma.company.create({
        data: {
          name: 'Protected Retention Company',
          companyCode: 'PROT' + Math.floor(Math.random() * 899 + 100),
          country: 'DE',
          documents: {
            create: {
              name: 'Tax_Exemption.pdf',
              fileUrl: 'https://cdn.example.com/tax.pdf',
              isPrivate: true,
            },
          },
        },
      });
      createdCompanyIds.push(company.id);

      // Attempt permanent deletion
      const res = await request(app)
        .delete(`/api/companies/${company.id}?mode=DELETE_PERMANENTLY`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot permanently delete company');
      expect(res.body.error).toContain('compliance document');
      expect(res.body.error).toContain('Move to Trash');

      // Soft delete (MOVE_TO_TRASH) succeeds
      const trashRes = await request(app)
        .delete(`/api/companies/${company.id}?mode=MOVE_TO_TRASH`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(trashRes.status).toBe(200);
      expect(trashRes.body.data.mode).toBe('MOVE_TO_TRASH');
      expect(trashRes.body.data.retentionDays).toBe(30);

      const checkInDb = await prisma.company.findUnique({ where: { id: company.id } });
      expect(checkInDb.deletedAt).not.toBeNull();
      expect(checkInDb.status).toBe('INACTIVE');
    });
  });

  describe('Trash & Retention Company Document Access Regression Suite (Section F)', () => {
    it('accurately reports "Company has been moved to trash" (404) for trashed company document download & file streaming', async () => {
      const trashedCompany = await prisma.company.create({
        data: {
          name: 'Trashed Docs Verification GmbH',
          companyCode: 'TRSH' + Math.floor(Math.random() * 899 + 100),
          country: 'DE',
          status: 'INACTIVE',
          deletedAt: new Date(),
          documents: {
            create: {
              name: 'Trashed_Compliance_Proof.pdf',
              fileUrl: 'https://cdn.example.com/trashed_compliance_proof.pdf',
              isPrivate: true,
            },
          },
        },
        include: { documents: true },
      });
      createdCompanyIds.push(trashedCompany.id);

      // Verify /download returns 404 with accurate trashed error
      const downloadRes = await request(app)
        .get(`/api/companies/${trashedCompany.id}/documents/${trashedCompany.documents[0].id}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(downloadRes.status).toBe(404);
      expect(downloadRes.body.error).toBe('Company has been moved to trash');

      // Verify /file streaming returns 404 with accurate trashed error
      const fileRes = await request(app)
        .get(`/api/companies/${trashedCompany.id}/documents/${trashedCompany.documents[0].id}/file`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(fileRes.status).toBe(404);
      expect(fileRes.body.error).toBe('Company has been moved to trash');
    });

    it('restoring the company correctly restores document download and preview/streaming without document re-upload', async () => {
      const companyToRestore = await prisma.company.create({
        data: {
          name: 'Restorable Docs Corporation',
          companyCode: 'RSTR' + Math.floor(Math.random() * 899 + 100),
          country: 'DE',
          status: 'INACTIVE',
          deletedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000), // 2 days in trash
          documents: {
            create: {
              name: 'Registration_Certificate.pdf',
              fileUrl: 'https://cdn.example.com/registration_cert.pdf',
              isPrivate: true,
            },
          },
        },
        include: { documents: true },
      });
      createdCompanyIds.push(companyToRestore.id);
      const docId = companyToRestore.documents[0].id;

      // Prior to restore: access blocked
      const preRestoreRes = await request(app)
        .get(`/api/companies/${companyToRestore.id}/documents/${docId}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);
      expect(preRestoreRes.status).toBe(404);
      expect(preRestoreRes.body.error).toBe('Company has been moved to trash');

      // Execute restoration
      const restoreRes = await request(app)
        .post(`/api/companies/${companyToRestore.id}/restore`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.success).toBe(true);
      expect(restoreRes.body.data.deletedAt).toBeNull();
      expect(restoreRes.body.data.status).toBe('IN_REVIEW');

      // After restore: download URL generation succeeds
      const postRestoreDownload = await request(app)
        .get(`/api/companies/${companyToRestore.id}/documents/${docId}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(postRestoreDownload.status).toBe(200);
      expect(postRestoreDownload.body.success).toBe(true);
      expect(postRestoreDownload.body.data.downloadUrl).toContain(
        `/api/companies/${companyToRestore.id}/documents/${docId}/file?disposition=attachment`
      );
      expect(postRestoreDownload.body.data.previewUrl).toContain(
        `/api/companies/${companyToRestore.id}/documents/${docId}/file?disposition=inline`
      );

      // After restore: streaming succeeds with mock storage fetch without re-upload
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: async () =>
          testPdfBuffer.buffer.slice(testPdfBuffer.byteOffset, testPdfBuffer.byteOffset + testPdfBuffer.byteLength),
      });

      try {
        const postRestoreStream = await request(app)
          .get(`/api/companies/${companyToRestore.id}/documents/${docId}/file`)
          .set('x-test-bypass-csrf', 'true')
          .set('Cookie', adminCookie);

        expect(postRestoreStream.status).toBe(200);
        expect(postRestoreStream.headers['content-type']).toContain('application/pdf');
        expect(postRestoreStream.headers['content-disposition']).toContain('inline');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns "Company not found" (404) for a genuinely missing company ID', async () => {
      const nonExistentCompanyId = crypto.randomUUID();
      const fakeDocId = crypto.randomUUID();

      const downloadRes = await request(app)
        .get(`/api/companies/${nonExistentCompanyId}/documents/${fakeDocId}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(downloadRes.status).toBe(404);
      expect(downloadRes.body.error).toBe('Company not found');

      const fileRes = await request(app)
        .get(`/api/companies/${nonExistentCompanyId}/documents/${fakeDocId}/file`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(fileRes.status).toBe(404);
      expect(fileRes.body.error).toBe('Company not found');
    });

    it('returns "Document not found for this company" (404) when document belongs to a different company', async () => {
      // Company A with Document A
      const companyA = await prisma.company.create({
        data: {
          name: 'Company Alpha',
          companyCode: 'ALPH' + Math.floor(Math.random() * 899 + 100),
          country: 'DE',
          status: 'ACTIVE',
          documents: {
            create: {
              name: 'Alpha_Contract.pdf',
              fileUrl: 'https://cdn.example.com/alpha_contract.pdf',
              isPrivate: true,
            },
          },
        },
        include: { documents: true },
      });
      createdCompanyIds.push(companyA.id);

      // Company B without that document
      const companyB = await prisma.company.create({
        data: {
          name: 'Company Beta',
          companyCode: 'BETA' + Math.floor(Math.random() * 899 + 100),
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(companyB.id);

      const docAId = companyA.documents[0].id;

      // Accessing Company A's document via Company B's route
      const crossCompanyDownload = await request(app)
        .get(`/api/companies/${companyB.id}/documents/${docAId}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(crossCompanyDownload.status).toBe(404);
      expect(crossCompanyDownload.body.error).toBe('Document not found for this company');

      const crossCompanyFile = await request(app)
        .get(`/api/companies/${companyB.id}/documents/${docAId}/file`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(crossCompanyFile.status).toBe(404);
      expect(crossCompanyFile.body.error).toBe('Document not found for this company');
    });

    it('enforces unauthorized access and inactive-company restrictions for document downloads', async () => {
      const inactiveCompany = await prisma.company.create({
        data: {
          name: 'Inactive Restrict Corp',
          companyCode: 'RSTR' + Math.floor(Math.random() * 899 + 100),
          country: 'DE',
          status: 'INACTIVE',
          documents: {
            create: {
              name: 'Inactive_Doc.pdf',
              fileUrl: 'https://cdn.example.com/inactive_restricted.pdf',
              isPrivate: true,
            },
          },
        },
        include: { documents: true },
      });
      createdCompanyIds.push(inactiveCompany.id);
      const docId = inactiveCompany.documents[0].id;

      // 1. Unauthenticated request -> 401
      const unauthDownload = await request(app)
        .get(`/api/companies/${inactiveCompany.id}/documents/${docId}/download`);
      expect(unauthDownload.status).toBe(401);

      // 2. Regular ADMIN on inactive company -> 403 Forbidden
      const regAdminDownload = await request(app)
        .get(`/api/companies/${inactiveCompany.id}/documents/${docId}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', regularAdminCookie);

      expect(regAdminDownload.status).toBe(403);
      expect(regAdminDownload.body.error).toContain('Access denied: Company is inactive and document access is restricted');

      // 3. SUPER_ADMIN on inactive company -> permitted
      const superAdminDownload = await request(app)
        .get(`/api/companies/${inactiveCompany.id}/documents/${docId}/download`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(superAdminDownload.status).toBe(200);
      expect(superAdminDownload.body.success).toBe(true);
    });
  });
});
