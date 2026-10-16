import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import {
  validateResumeFile,
  enforceCandidateVisibility,
  checkResumeDownloadAuthorization,
  enforceEmployerContactVisibility,
} from '../src/modules/configuration/candidateVisibilityPolicy.js';
import { evaluateJobApprovalStatus } from '../src/modules/configuration/jobApprovalPolicy.js';
import { redactSensitiveConfigAuditData } from '../src/modules/configuration/configAudit.service.js';

const TEST_SUPER_ADMIN_EMAIL = 'config_superadmin@recruitrain.test';
const TEST_REGULAR_ADMIN_EMAIL = 'config_regular_admin@recruitrain.test';
const TEST_PASSWORD = 'ConfigSecurePassword123!@#';

describe('RecruiTrain Phase 1: Platform Configuration Integration Suite', () => {
  let app;
  let superAdminId;
  let regularAdminId;
  let superAdminCookie;
  let regularAdminCookie;
  let superTotpSecret;
  let regularTotpSecret;

  // Track created fixtures for scoped teardown
  const createdIndustryIds = [];
  const createdDocDefIds = [];
  const createdStageIds = [];

  beforeAll(async () => {
    // 1. Verify safe test database isolation
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Clean prior test admins
    const existingAdmins = await prisma.admin.findMany({
      where: {
        email: { in: [TEST_SUPER_ADMIN_EMAIL, TEST_REGULAR_ADMIN_EMAIL] },
      },
      select: { id: true },
    });

    const adminIds = existingAdmins.map((a) => a.id);
    if (adminIds.length > 0) {
      await prisma.platformConfigAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    }

    // Reset global platform settings to baseline defaults
    await prisma.platformSetting.upsert({
      where: { id: 'global' },
      update: {
        acceptedResumeFileTypes: ['application/pdf', '.pdf', 'application/msword', '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
        autoApproveCandidateProfiles: false,
        showEmployerContactDetails: false,
        showCandidateResumes: true,
        showCandidateFullName: true,
        showCandidateEmail: false,
        showCandidatePhone: false,
        autoApproveJobs: false,
      },
      create: {
        id: 'global',
        acceptedResumeFileTypes: ['application/pdf', '.pdf', 'application/msword', '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
        autoApproveCandidateProfiles: false,
        showEmployerContactDetails: false,
        showCandidateResumes: true,
        showCandidateFullName: true,
        showCandidateEmail: false,
        showCandidatePhone: false,
        autoApproveJobs: false,
      },
    });

    const passwordHash = await hashPassword(TEST_PASSWORD);

    // Create Super Admin
    const superTotpGen = generateTotpSecret(TEST_SUPER_ADMIN_EMAIL);
    superTotpSecret = superTotpGen.secret;
    const superAdmin = await prisma.admin.create({
      data: {
        email: TEST_SUPER_ADMIN_EMAIL,
        name: 'Super Admin Tester',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptTotpSecret(superTotpSecret),
      },
    });
    superAdminId = superAdmin.id;

    // Create Regular Admin
    const regularTotpGen = generateTotpSecret(TEST_REGULAR_ADMIN_EMAIL);
    regularTotpSecret = regularTotpGen.secret;
    const regularAdmin = await prisma.admin.create({
      data: {
        email: TEST_REGULAR_ADMIN_EMAIL,
        name: 'Regular Admin Tester',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptTotpSecret(regularTotpSecret),
      },
    });
    regularAdminId = regularAdmin.id;

    // Login & 2FA verify Super Admin
    const superLogin = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: TEST_SUPER_ADMIN_EMAIL, password: TEST_PASSWORD });
    const superCode = authenticator.generate(superTotpSecret);
    const superVerify = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', superLogin.headers['set-cookie'])
      .send({ adminId: superAdminId, code: superCode });
    superAdminCookie = superVerify.headers['set-cookie'];

    // Login & 2FA verify Regular Admin
    const regLogin = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: TEST_REGULAR_ADMIN_EMAIL, password: TEST_PASSWORD });
    const regCode = authenticator.generate(regularTotpSecret);
    const regVerify = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', regLogin.headers['set-cookie'])
      .send({ adminId: regularAdminId, code: regCode });
    regularAdminCookie = regVerify.headers['set-cookie'];
  });

  afterAll(async () => {
    // Scoped clean up of test records
    if (createdIndustryIds.length > 0) {
      await prisma.industry.deleteMany({ where: { id: { in: createdIndustryIds } } });
    }
    if (createdDocDefIds.length > 0) {
      await prisma.documentDefinition.deleteMany({ where: { id: { in: createdDocDefIds } } });
    }
    if (createdStageIds.length > 0) {
      await prisma.recruitmentStage.deleteMany({ where: { id: { in: createdStageIds } } });
    }

    const testAdminIds = [superAdminId, regularAdminId].filter(Boolean);
    if (testAdminIds.length > 0) {
      await prisma.platformConfigAuditLog.deleteMany({ where: { adminId: { in: testAdminIds } } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: { in: testAdminIds } } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: testAdminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: testAdminIds } } });
    }

    // Restore default platform settings in test DB
    await prisma.platformSetting.upsert({
      where: { id: 'global' },
      update: {
        acceptedResumeFileTypes: ['application/pdf', '.pdf', 'application/msword', '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
        autoApproveCandidateProfiles: false,
        showEmployerContactDetails: false,
        showCandidateResumes: true,
        showCandidateFullName: true,
        showCandidateEmail: false,
        showCandidatePhone: false,
        autoApproveJobs: false,
      },
      create: {
        id: 'global',
        acceptedResumeFileTypes: ['application/pdf', '.pdf', 'application/msword', '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
        autoApproveCandidateProfiles: false,
        showEmployerContactDetails: false,
        showCandidateResumes: true,
        showCandidateFullName: true,
        showCandidateEmail: false,
        showCandidatePhone: false,
        autoApproveJobs: false,
      },
    });
  });

  // ==========================================
  // 1. Industry & Sector Management
  // ==========================================
  describe('1. Industry & Sector Management', () => {
    let parentIndustryId;
    let childIndustryId;

    it('successfully creates a root industry', async () => {
      const res = await request(app)
        .post('/api/configuration/industries')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          name: 'Information Technology',
          code: 'IT',
          description: 'Software, hardware and internet services',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Information Technology');
      expect(res.body.data.parentId).toBeNull();

      parentIndustryId = res.body.data.id;
      createdIndustryIds.push(parentIndustryId);
    });

    it('rejects duplicate industry names at the root level (case-insensitive)', async () => {
      const res = await request(app)
        .post('/api/configuration/industries')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          name: 'information technology', // lowercase duplicate
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('already exists at the root industry level');
    });

    it('successfully creates a sub-industry under parent', async () => {
      const res = await request(app)
        .post('/api/configuration/industries')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          name: 'Cybersecurity',
          code: 'CYBER',
          parentId: parentIndustryId,
          description: 'Information security and defense',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.parentId).toBe(parentIndustryId);

      childIndustryId = res.body.data.id;
      createdIndustryIds.push(childIndustryId);
    });

    it('rejects duplicate sub-industry names under the same parent', async () => {
      const res = await request(app)
        .post('/api/configuration/industries')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          name: 'cybersecurity',
          parentId: parentIndustryId,
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('already exists under this parent industry');
    });

    it('fetches hierarchical industry view with nested children', async () => {
      const res = await request(app)
        .get('/api/configuration/industries?hierarchy=true')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', regularAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const rootItem = res.body.data.find((ind) => ind.id === parentIndustryId);
      expect(rootItem).toBeDefined();
      expect(rootItem.children.some((c) => c.id === childIndustryId)).toBe(true);
    });

    it('prevents setting parent to self (circular hierarchy)', async () => {
      const res = await request(app)
        .patch(`/api/configuration/industries/${parentIndustryId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          parentId: parentIndustryId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cannot be its own parent');
    });

    it('prevents setting parent to a descendant (circular hierarchy)', async () => {
      const res = await request(app)
        .patch(`/api/configuration/industries/${parentIndustryId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          parentId: childIndustryId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Circular hierarchy detected');
    });

    it('prevents deactivating a parent industry while it has active sub-industries', async () => {
      const res = await request(app)
        .patch(`/api/configuration/industries/${parentIndustryId}/status`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({ status: 'INACTIVE' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('active sub-industries/departments');
    });

    it('deactivates child first, then allows deactivating parent industry', async () => {
      // Deactivate child
      const childRes = await request(app)
        .patch(`/api/configuration/industries/${childIndustryId}/status`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({ status: 'INACTIVE' });
      expect(childRes.status).toBe(200);

      // Now deactivating parent succeeds
      const parentRes = await request(app)
        .patch(`/api/configuration/industries/${parentIndustryId}/status`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({ status: 'INACTIVE' });
      expect(parentRes.status).toBe(200);
      expect(parentRes.body.data.status).toBe('INACTIVE');
    });

    it('moves sub-industry to trash (soft delete)', async () => {
      const res = await request(app)
        .delete(`/api/configuration/industries/${childIndustryId}?mode=MOVE_TO_TRASH`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const dbRecord = await prisma.industry.findUnique({ where: { id: childIndustryId } });
      expect(dbRecord.deletedAt).not.toBeNull();
      expect(dbRecord.status).toBe('INACTIVE');
    });
  });

  // ==========================================
  // 2. Company & Candidate Document Definitions
  // ==========================================
  describe('2. Document Definitions Management', () => {
    let companyDocId;
    let candidateDocId;

    it('successfully creates a company document definition', async () => {
      const res = await request(app)
        .post('/api/configuration/document-definitions')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          targetType: 'COMPANY',
          name: 'Commercial Register Extract',
          description: 'Official Handelsregisterauszug under 3 months old',
          isRequired: true,
          acceptedFileTypes: ['.pdf', 'application/pdf'],
          maxFileSizeMb: 15,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Commercial Register Extract');
      expect(res.body.data.targetType).toBe('COMPANY');
      expect(res.body.data.isRequired).toBe(true);

      companyDocId = res.body.data.id;
      createdDocDefIds.push(companyDocId);
    });

    it('rejects duplicate document definition name for the same targetType', async () => {
      const res = await request(app)
        .post('/api/configuration/document-definitions')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          targetType: 'COMPANY',
          name: 'commercial register extract',
          acceptedFileTypes: ['.pdf'],
          maxFileSizeMb: 10,
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });

    it('successfully creates a candidate document definition with identical name as company doc', async () => {
      // Scoped uniqueness: candidate docs are separate from company docs
      const res = await request(app)
        .post('/api/configuration/document-definitions')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          targetType: 'CANDIDATE',
          name: 'Commercial Register Extract',
          description: 'Candidate sole-proprietor commercial extract if applicable',
          isRequired: false,
          acceptedFileTypes: ['.pdf', '.jpg', '.png'],
          maxFileSizeMb: 10,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.targetType).toBe('CANDIDATE');

      candidateDocId = res.body.data.id;
      createdDocDefIds.push(candidateDocId);
    });

    it('rejects dangerous executable extensions in acceptedFileTypes', async () => {
      const res = await request(app)
        .post('/api/configuration/document-definitions')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          targetType: 'COMPANY',
          name: 'Tax ID Certificate',
          acceptedFileTypes: ['.pdf', '.exe'],
          maxFileSizeMb: 10,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body.issues)).toContain('executable');
    });

    it('filters document definitions by targetType', async () => {
      const res = await request(app)
        .get('/api/configuration/document-definitions?targetType=COMPANY')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', regularAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.data.every((d) => d.targetType === 'COMPANY')).toBe(true);
    });

    it('updates document definition required flag and file limits', async () => {
      const res = await request(app)
        .patch(`/api/configuration/document-definitions/${companyDocId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          isRequired: false,
          maxFileSizeMb: 25,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isRequired).toBe(false);
      expect(res.body.data.maxFileSizeMb).toBe(25);
    });
  });

  // ==========================================
  // 3. Dynamic Recruitment Stages
  // ==========================================
  describe('3. Dynamic Recruitment Stages', () => {
    let stage1Id;
    let stage2Id;

    it('creates recruitment stages with incremental order auto-assigned', async () => {
      const res1 = await request(app)
        .post('/api/configuration/recruitment-stages')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          name: 'Initial HR Screening',
          category: 'SCREENING',
          description: 'Resume review and 15-min intro call',
        });
      expect(res1.status).toBe(201);
      stage1Id = res1.body.data.id;
      createdStageIds.push(stage1Id);

      const res2 = await request(app)
        .post('/api/configuration/recruitment-stages')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          name: 'Technical Assessment',
          category: 'INTERVIEW',
          description: 'Hands-on coding challenge and architecture discussion',
        });
      expect(res2.status).toBe(201);
      stage2Id = res2.body.data.id;
      createdStageIds.push(stage2Id);

      expect(res2.body.data.order).toBeGreaterThan(res1.body.data.order);
    });

    it('rejects duplicate stage names', async () => {
      const res = await request(app)
        .post('/api/configuration/recruitment-stages')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          name: 'initial hr screening',
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });

    it('atomically reorders recruitment stages and persists order in database', async () => {
      const res = await request(app)
        .put('/api/configuration/recruitment-stages/reorder')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          stages: [
            { id: stage1Id, order: 10 },
            { id: stage2Id, order: 5 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify persistent database order
      const s1 = await prisma.recruitmentStage.findUnique({ where: { id: stage1Id } });
      const s2 = await prisma.recruitmentStage.findUnique({ where: { id: stage2Id } });

      expect(s1.order).toBe(10);
      expect(s2.order).toBe(5);
    });

    it('toggles recruitment stage status', async () => {
      const res = await request(app)
        .patch(`/api/configuration/recruitment-stages/${stage1Id}/status`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({ status: 'INACTIVE' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('INACTIVE');
    });
  });

  // ==========================================
  // 4. Platform Settings & RBAC Enforcement
  // ==========================================
  describe('4. Platform Settings Persistence & Authorization', () => {
    it('initializes and returns platform settings with safe defaults', async () => {
      const res = await request(app)
        .get('/api/configuration/settings')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', regularAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('global');
      expect(Array.isArray(res.body.data.acceptedResumeFileTypes)).toBe(true);
      expect(res.body.data.autoApproveCandidateProfiles).toBe(false);
      expect(res.body.data.autoApproveJobs).toBe(false);
    });

    it('denies regular ADMIN from updating Candidate Settings (RBAC enforcement)', async () => {
      const res = await request(app)
        .patch('/api/configuration/settings/candidate')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', regularAdminCookie)
        .send({
          acceptedResumeFileTypes: ['.pdf', '.docx'],
          autoApproveCandidateProfiles: true,
          showEmployerContactDetails: true,
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Forbidden');
    });

    it('allows SUPER_ADMIN to update Candidate Settings and persists to PostgreSQL', async () => {
      const res = await request(app)
        .patch('/api/configuration/settings/candidate')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          acceptedResumeFileTypes: ['.pdf', '.docx', 'application/pdf'],
          autoApproveCandidateProfiles: true,
          showEmployerContactDetails: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.autoApproveCandidateProfiles).toBe(true);
      expect(res.body.data.showEmployerContactDetails).toBe(true);
      expect(res.body.data.acceptedResumeFileTypes).toContain('.pdf');

      // Verify fresh read from PostgreSQL
      const fromDb = await prisma.platformSetting.findUnique({ where: { id: 'global' } });
      expect(fromDb.autoApproveCandidateProfiles).toBe(true);
      expect(fromDb.showEmployerContactDetails).toBe(true);
    });

    it('denies regular ADMIN from updating Employer Visibility Settings', async () => {
      const res = await request(app)
        .patch('/api/configuration/settings/employer-visibility')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', regularAdminCookie)
        .send({
          showCandidateResumes: false,
          showCandidateFullName: false,
          showCandidateEmail: false,
          showCandidatePhone: false,
        });

      expect(res.status).toBe(403);
    });

    it('allows SUPER_ADMIN to update Employer Visibility Settings and persists', async () => {
      const res = await request(app)
        .patch('/api/configuration/settings/employer-visibility')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          showCandidateResumes: false,
          showCandidateFullName: false,
          showCandidateEmail: true,
          showCandidatePhone: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.showCandidateResumes).toBe(false);
      expect(res.body.data.showCandidateFullName).toBe(false);
      expect(res.body.data.showCandidateEmail).toBe(true);

      const fromDb = await prisma.platformSetting.findUnique({ where: { id: 'global' } });
      expect(fromDb.showCandidateResumes).toBe(false);
      expect(fromDb.showCandidateFullName).toBe(false);
    });

    it('allows SUPER_ADMIN to update Job Settings and persists', async () => {
      const res = await request(app)
        .patch('/api/configuration/settings/job')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          autoApproveJobs: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.autoApproveJobs).toBe(true);

      const fromDb = await prisma.platformSetting.findUnique({ where: { id: 'global' } });
      expect(fromDb.autoApproveJobs).toBe(true);
    });
  });

  // ==========================================
  // 5. Candidate Visibility Policy & File Validation Foundation
  // ==========================================
  describe('5. Candidate Visibility Policy & File Validation', () => {
    it('validates allowed resume files and rejects dangerous extensions', () => {
      const validPdf = validateResumeFile('candidate_cv.pdf', 'application/pdf', ['.pdf', '.docx']);
      expect(validPdf.valid).toBe(true);
      expect(validPdf.normalizedExtension).toBe('.pdf');

      const dangerousBat = validateResumeFile('script.bat', null, ['.bat', '.pdf']);
      expect(dangerousBat.valid).toBe(false);
      expect(dangerousBat.error).toContain('strictly prohibited');

      const nonAllowedTxt = validateResumeFile('notes.txt', 'text/plain', ['.pdf', '.docx']);
      expect(nonAllowedTxt.valid).toBe(false);
      expect(nonAllowedTxt.error).toContain('not in the list of accepted resume formats');
    });

    it('rejects MIME type mismatches (header/extension spoofing)', () => {
      const mismatched = validateResumeFile('exploit.pdf', 'text/html', ['.pdf']);
      expect(mismatched.valid).toBe(false);
      expect(mismatched.error).toContain('MIME type mismatch');
    });

    it('masks candidate full name, phone, and removes resumes for employers when settings are disabled', () => {
      const candidateRecord = {
        id: 'cand-uuid-12345',
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '+49 170 1234567',
        resumeUrl: 'https://cdn.recruitrain.com/resumes/cand-12345.pdf',
      };

      const settings = {
        showCandidateFullName: false,
        showCandidateEmail: false,
        showCandidatePhone: false,
        showCandidateResumes: false,
      };

      const employerSanitized = enforceCandidateVisibility(candidateRecord, settings, { isEmployer: true });
      expect(employerSanitized.name).toContain('Candidate #CAND-UUI');
      expect(employerSanitized.email).toBe('[RESTRICTED_BY_PLATFORM_POLICY]');
      expect(employerSanitized.phone).toBe('[RESTRICTED_BY_PLATFORM_POLICY]');
      expect(employerSanitized.resumeUrl).toBeUndefined();
      expect(employerSanitized.resumeAvailable).toBe(false);
    });

    it('bypasses candidate visibility restrictions for platform administrators', () => {
      const candidateRecord = {
        id: 'cand-uuid-12345',
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '+49 170 1234567',
        resumeUrl: 'https://cdn.recruitrain.com/resumes/cand-12345.pdf',
      };

      const settings = {
        showCandidateFullName: false,
        showCandidateEmail: false,
        showCandidatePhone: false,
        showCandidateResumes: false,
      };

      const adminView = enforceCandidateVisibility(candidateRecord, settings, { role: 'SUPER_ADMIN' });
      expect(adminView.name).toBe('Jane Doe');
      expect(adminView.email).toBe('jane@example.com');
      expect(adminView.phone).toBe('+49 170 1234567');
      expect(adminView.resumeUrl).toBe('https://cdn.recruitrain.com/resumes/cand-12345.pdf');
    });

    it('enforces resume download authorization based on platform settings', () => {
      const disabledSettings = { showCandidateResumes: false };
      const employerCheck = checkResumeDownloadAuthorization(disabledSettings, { isEmployer: true });
      expect(employerCheck.allowed).toBe(false);
      expect(employerCheck.reason).toContain('disabled by platform');

      const adminCheck = checkResumeDownloadAuthorization(disabledSettings, { role: 'ADMIN' });
      expect(adminCheck.allowed).toBe(true);
    });

    it('enforces employer contact visibility for candidate view', () => {
      const employer = {
        id: 'comp-1',
        name: 'Acme Corp',
        contactEmail: 'contact@acme.com',
        contactPhone: '+49 89 123456',
        billingEmail: 'invoices@acme.com',
      };

      const hiddenSettings = { showEmployerContactDetails: false };
      const candidateView = enforceEmployerContactVisibility(employer, hiddenSettings);

      expect(candidateView.name).toBe('Acme Corp');
      expect(candidateView.contactEmail).toBeUndefined();
      expect(candidateView.billingEmail).toBeUndefined();
      expect(candidateView.contactDetailsHidden).toBe(true);
    });
  });

  // ==========================================
  // 6. Job Approval Policy Foundation
  // ==========================================
  describe('6. Job Approval Policy Foundation', () => {
    it('evaluates status to APPROVED when autoApproveJobs is true', () => {
      const result = evaluateJobApprovalStatus({
        jobData: { title: 'Senior Backend Engineer' },
        settings: { autoApproveJobs: true },
        creatorContext: { role: 'EMPLOYER' },
      });
      expect(result.status).toBe('APPROVED');
      expect(result.requiresReview).toBe(false);
    });

    it('evaluates status to PENDING_APPROVAL when autoApproveJobs is false', () => {
      const result = evaluateJobApprovalStatus({
        jobData: { title: 'Junior Frontend Developer' },
        settings: { autoApproveJobs: false },
        creatorContext: { role: 'EMPLOYER' },
      });
      expect(result.status).toBe('PENDING_APPROVAL');
      expect(result.requiresReview).toBe(true);
    });

    it('auto-approves jobs submitted directly by platform administrators', () => {
      const result = evaluateJobApprovalStatus({
        jobData: { title: 'Platform Internal Role' },
        settings: { autoApproveJobs: false },
        creatorContext: { role: 'ADMIN' },
      });
      expect(result.status).toBe('APPROVED');
      expect(result.requiresReview).toBe(false);
    });
  });

  // ==========================================
  // 7. Audit Trail & Sensitive Data Redaction
  // ==========================================
  describe('7. Platform Configuration Audit Logging', () => {
    it('records and retrieves configuration audit trail entries with sensitive redactions', async () => {
      const samplePayload = {
        settingName: 'PlatformSecurity',
        secret: 'super_secret_token_123',
        password: 'mypassword',
        acceptedTypes: ['.pdf'],
      };

      const redacted = redactSensitiveConfigAuditData(samplePayload);
      expect(redacted.secret).toBe('[REDACTED]');
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.acceptedTypes).toEqual(['.pdf']);

      const res = await request(app)
        .get('/api/configuration/settings/audit-logs')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });
});
