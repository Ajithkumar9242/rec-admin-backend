import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';

const TEST_ADMIN_EMAIL = 'jobs_suite_admin@recruitrain.test';
const TEST_PASSWORD = 'JobsSecurePassword123!@#';

describe('Phase 4: Company-to-Hiring Integration & Candidate Discovery Suite', () => {
  let app;
  let adminId;
  let adminCookie;
  let adminTotpSecret;

  const createdCompanyIds = [];
  const createdJobIds = [];
  const createdCandidateIds = [];
  const createdPlanIds = [];
  const createdSubIds = [];
  const createdStageIds = [];

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
        name: 'Jobs Integration Admin',
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

    // Ensure platform setting exists
    await prisma.platformSetting.upsert({
      where: { id: 'global' },
      update: {
        showEmployerContactDetails: false,
        autoApproveJobs: true,
      },
      create: {
        id: 'global',
        showEmployerContactDetails: false,
        autoApproveJobs: true,
      },
    });

    // Ensure initial recruitment stage exists
    const stage = await prisma.recruitmentStage.upsert({
      where: { name: 'Sourcing & Screening' },
      update: { status: 'ACTIVE', category: 'SCREENING', order: 1 },
      create: {
        name: 'Sourcing & Screening',
        category: 'SCREENING',
        order: 1,
        status: 'ACTIVE',
      },
    });
    createdStageIds.push(stage.id);
  });

  afterAll(async () => {
    // Cleanup in foreign key dependency order
    if (createdJobIds.length > 0) {
      await prisma.jobApplication.deleteMany({ where: { jobId: { in: createdJobIds } } });
      await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } });
    }
    if (createdCandidateIds.length > 0) {
      await prisma.jobApplication.deleteMany({ where: { candidateId: { in: createdCandidateIds } } });
      await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
    }
    if (createdSubIds.length > 0) {
      await prisma.subscription.deleteMany({ where: { id: { in: createdSubIds } } });
    }
    if (createdPlanIds.length > 0) {
      await prisma.plan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    if (createdCompanyIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
    }
    if (adminId) {
      await prisma.adminBackupCode.deleteMany({ where: { adminId } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId } });
      await prisma.authAuditLog.deleteMany({ where: { adminId } });
      await prisma.admin.deleteMany({ where: { id: adminId } });
    }
  });

  describe('1. Hiring Preferences vs Job Hiring Scope Policy Enforcement', () => {
    let companyDomesticOnly;

    beforeAll(async () => {
      companyDomesticOnly = await prisma.company.create({
        data: {
          name: 'Domestic Only GmbH',
          companyCode: 'DOM-ONLY',
          status: 'ACTIVE',
          hiringDomestic: true,
          hiringEu: false,
          hiringInternational: false,
        },
      });
      createdCompanyIds.push(companyDomesticOnly.id);
    });

    it('rejects creating an INTERNATIONAL job when company has hiringInternational=false', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          companyId: companyDomesticOnly.id,
          title: 'Senior Cloud Architect',
          description: 'Global cloud infrastructure lead role across continents.',
          hiringScope: 'INTERNATIONAL',
          status: 'DRAFT',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not configured for international hiring/i);
    });

    it('rejects creating an EU job when company has hiringEu=false', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          companyId: companyDomesticOnly.id,
          title: 'Full Stack Engineer',
          description: 'European cross-border engineering vacancy.',
          hiringScope: 'EU',
          status: 'DRAFT',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not configured for EU hiring/i);
    });

    it('succeeds in creating DOMESTIC job matching company domestic capability', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          companyId: companyDomesticOnly.id,
          title: 'Junior Backend Developer',
          description: 'Domestic development vacancy in Munich headquarters.',
          hiringScope: 'DOMESTIC',
          status: 'DRAFT',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.hiringScope).toBe('DOMESTIC');
      createdJobIds.push(res.body.data.id);
    });
  });

  describe('2. Trashed and Inactive Company Safety Guards', () => {
    it('strictly forbids creating a job for a company currently in trash', async () => {
      const trashedCompany = await prisma.company.create({
        data: {
          name: 'Trashed Employer AG',
          companyCode: 'TRASHED-CO',
          status: 'ACTIVE',
          deletedAt: new Date(),
          hiringDomestic: true,
        },
      });
      createdCompanyIds.push(trashedCompany.id);

      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          companyId: trashedCompany.id,
          title: 'Account Executive',
          description: 'Sales position for enterprise business customers.',
          hiringScope: 'DOMESTIC',
          status: 'DRAFT',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Cannot post jobs for a company currently in trash/i);
    });

    it('forbids publishing a job when company status is SUSPENDED', async () => {
      const suspendedCompany = await prisma.company.create({
        data: {
          name: 'Suspended Employer KG',
          companyCode: 'SUSPENDED-CO',
          status: 'SUSPENDED',
          hiringDomestic: true,
        },
      });
      createdCompanyIds.push(suspendedCompany.id);

      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          companyId: suspendedCompany.id,
          title: 'Operations Manager',
          description: 'Manage warehouse and dispatch team.',
          hiringScope: 'DOMESTIC',
          status: 'PUBLISHED',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/must be ACTIVE to publish/i);
    });
  });

  describe('3. Subscription Entitlement & Quota Enforcement', () => {
    let quotaCompany;
    let quotaPlan;

    beforeAll(async () => {
      quotaCompany = await prisma.company.create({
        data: {
          name: 'Quota Limited GmbH',
          companyCode: 'QUOTA-CO',
          status: 'ACTIVE',
          hiringDomestic: true,
        },
      });
      createdCompanyIds.push(quotaCompany.id);

      // Provision plan with jobPostingLimit: 1
      quotaPlan = await prisma.plan.create({
        data: {
          name: 'Single Job Plan',
          price: 99.0,
          billingInterval: 'MONTHLY',
          jobPostingLimit: 1,
          candidateAccessLimit: 10,
          teamMemberLimit: 2,
        },
      });
      createdPlanIds.push(quotaPlan.id);

      const sub = await prisma.subscription.create({
        data: {
          companyId: quotaCompany.id,
          planId: quotaPlan.id,
          status: 'ACTIVE',
          startDate: new Date(Date.now() - 24 * 3600 * 1000),
          endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          billingInterval: 'MONTHLY',
          price: 99.0,
          jobPostingLimit: 1,
        },
      });
      createdSubIds.push(sub.id);
    });

    it('allows publishing first job within subscription limit (1/1)', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          companyId: quotaCompany.id,
          title: 'First Allowed Job',
          description: 'Primary published vacancy under current subscription quota.',
          hiringScope: 'DOMESTIC',
          status: 'PUBLISHED',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('PUBLISHED');
      createdJobIds.push(res.body.data.id);
    });

    it('rejects publishing second job when quota is exceeded (429 Quota Exceeded)', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          companyId: quotaCompany.id,
          title: 'Second Excess Job',
          description: 'Exceeding vacancy trying to publish past tier allocation.',
          hiringScope: 'DOMESTIC',
          status: 'PUBLISHED',
        });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('QUOTA_EXCEEDED');
      expect(res.body.error).toMatch(/Entitlement quota exceeded for "jobPosting"/i);
    });
  });

  describe('4. Public Candidate Discovery API (GET /api/jobs/public)', () => {
    let publishedJob;
    let draftJob;
    let activeCompany;

    beforeAll(async () => {
      activeCompany = await prisma.company.create({
        data: {
          name: 'Public Discovery AG',
          companyCode: 'DISCOVERY-AG',
          status: 'ACTIVE',
          country: 'DE',
          city: 'Berlin',
          email: 'secret_admin@discovery.de',
          billingEmail: 'sensitive_billing@discovery.de',
          billingAddress: 'Confidential Finance Dept 12',
          hiringDomestic: true,
        },
      });
      createdCompanyIds.push(activeCompany.id);

      publishedJob = await prisma.job.create({
        data: {
          companyId: activeCompany.id,
          title: 'Senior React Engineer',
          description: 'Join our Berlin frontend platform team building design systems.',
          country: 'DE',
          city: 'Berlin',
          workArrangement: 'HYBRID',
          employmentType: 'FULL_TIME',
          hiringScope: 'DOMESTIC',
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      createdJobIds.push(publishedJob.id);

      draftJob = await prisma.job.create({
        data: {
          companyId: activeCompany.id,
          title: 'Unpublished Internal Draft',
          description: 'Internal draft not yet approved for public candidate viewing.',
          status: 'DRAFT',
        },
      });
      createdJobIds.push(draftJob.id);
    });

    it('returns only published non-expired jobs and omits internal drafts', async () => {
      const res = await request(app)
        .get('/api/jobs/public')
        .query({ city: 'Berlin' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const titles = res.body.items.map((j) => j.title);
      expect(titles).toContain('Senior React Engineer');
      expect(titles).not.toContain('Unpublished Internal Draft');
    });

    it('rigorously sanitizes employer private billing contact details in candidate response', async () => {
      const res = await request(app)
        .get(`/api/jobs/public/${publishedJob.id}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Senior React Engineer');

      // Privacy policy checks: billing contacts must NOT be present
      const company = res.body.data.company;
      expect(company.name).toBe('Public Discovery AG');
      expect(company.billingEmail).toBeUndefined();
      expect(company.billingAddress).toBeUndefined();
      expect(company.contactEmail).toBeUndefined();
    });
  });

  describe('5. Candidate Job Application & Duplicate Prevention', () => {
    let applyJob;

    beforeAll(async () => {
      const applyCompany = await prisma.company.create({
        data: {
          name: 'Hiring Fast Inc',
          companyCode: 'APPLY-INC',
          status: 'ACTIVE',
          hiringDomestic: true,
        },
      });
      createdCompanyIds.push(applyCompany.id);

      applyJob = await prisma.job.create({
        data: {
          companyId: applyCompany.id,
          title: 'Site Reliability Engineer',
          description: 'Kubernetes and infrastructure reliability engineering.',
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      createdJobIds.push(applyJob.id);
    });

    it('rejects upload with dangerous executable extension (.exe)', async () => {
      const res = await request(app)
        .post(`/api/jobs/public/${applyJob.id}/apply`)
        .send({
          firstName: 'Hacker',
          lastName: 'Test',
          email: 'hacker@exploit.test',
          resumeFileName: 'payload.exe',
          resumeMimeType: 'application/octet-stream',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/prohibited for security/i);
    });

    it('successfully processes genuine candidate application and assigns initial recruitment stage', async () => {
      const res = await request(app)
        .post(`/api/jobs/public/${applyJob.id}/apply`)
        .send({
          firstName: 'Jane',
          lastName: 'Candidate',
          email: 'jane.candidate@recruitrain.test',
          phone: '+49 170 1234567',
          coverLetter: 'I am excited to apply for the SRE role.',
          resumeFileName: 'jane_resume.pdf',
          resumeMimeType: 'application/pdf',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.applicationId).toBeDefined();
      expect(res.body.status).toBe('SUBMITTED');
      expect(res.body.currentStage).toBe('Sourcing & Screening');

      // Check candidate created
      const candidate = await prisma.candidate.findUnique({
        where: { email: 'jane.candidate@recruitrain.test' },
      });
      expect(candidate).not.toBeNull();
      createdCandidateIds.push(candidate.id);
    });

    it('strictly enforces duplicate application prevention (409 Conflict)', async () => {
      const res = await request(app)
        .post(`/api/jobs/public/${applyJob.id}/apply`)
        .send({
          firstName: 'Jane',
          lastName: 'Candidate',
          email: 'jane.candidate@recruitrain.test',
          coverLetter: 'Submitting a second duplicate application.',
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/already submitted an application/i);
    });

    it('detects and rejects executable payload disguised with .pdf extension via multipart upload', async () => {
      // Fake PDF buffer with MZ Windows PE binary executable header (0x4D, 0x5A)
      const fakePdfBuffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

      const res = await request(app)
        .post(`/api/jobs/public/${applyJob.id}/apply`)
        .field('firstName', 'Malicious')
        .field('lastName', 'User')
        .field('email', 'malicious.user@exploit.test')
        .attach('resume', fakePdfBuffer, 'trojan_resume.pdf');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/executable payload/i);
    });

    it('serializes concurrent job creation requests and rejects exceeding quota atomically', async () => {
      const concurrentCompany = await prisma.company.create({
        data: {
          name: 'Concurrent Quota Corp',
          companyCode: 'CONCUR-CO',
          status: 'ACTIVE',
          hiringDomestic: true,
        },
      });
      createdCompanyIds.push(concurrentCompany.id);

      const plan = await prisma.plan.create({
        data: {
          name: 'Concurrent Plan',
          price: 50.0,
          billingInterval: 'MONTHLY',
          jobPostingLimit: 1,
        },
      });
      createdPlanIds.push(plan.id);

      const sub = await prisma.subscription.create({
        data: {
          companyId: concurrentCompany.id,
          planId: plan.id,
          status: 'ACTIVE',
          startDate: new Date(Date.now() - 24 * 3600 * 1000),
          endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          billingInterval: 'MONTHLY',
          price: 50.0,
          jobPostingLimit: 1,
        },
      });
      createdSubIds.push(sub.id);

      // Launch 2 parallel requests trying to publish jobs concurrently
      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/jobs')
          .set('Cookie', adminCookie)
          .set('x-test-bypass-csrf', 'true')
          .send({
            companyId: concurrentCompany.id,
            title: 'Parallel Job A',
            description: 'Testing race conditions under concurrency.',
            status: 'PUBLISHED',
          }),
        request(app)
          .post('/api/jobs')
          .set('Cookie', adminCookie)
          .set('x-test-bypass-csrf', 'true')
          .send({
            companyId: concurrentCompany.id,
            title: 'Parallel Job B',
            description: 'Testing race conditions under concurrency.',
            status: 'PUBLISHED',
          }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 429]);
      if (res1.status === 201) createdJobIds.push(res1.body.data.id);
      if (res2.status === 201) createdJobIds.push(res2.body.data.id);
    });
  });

  describe('Phase B: Admin Jobs Directory, Moderation & Applicant Limits Suite', () => {
    let testCompany;

    beforeAll(async () => {
      testCompany = await prisma.company.create({
        data: {
          name: 'Phase B Enterprise GmbH',
          companyCode: 'COMP-PHASE-B',
          email: 'phaseb@enterprise.test',
          country: 'DE',
          status: 'ACTIVE',
          hiringDomestic: true,
          hiringEu: true,
          hiringInternational: false,
        },
      });
      createdCompanyIds.push(testCompany.id);
    });

    it('lists admin jobs with search, status filters, hiring scope filters, and status counts', async () => {
      const job1 = await prisma.job.create({
        data: {
          companyId: testCompany.id,
          title: 'Full Stack Engineer (Elixir/React)',
          jobCode: 'JOB-ELIXIR-01',
          department: 'Engineering',
          description: 'Build high-performance real-time applications.',
          hiringScope: 'DOMESTIC',
          status: 'DRAFT',
          openings: 2,
        },
      });
      createdJobIds.push(job1.id);

      const job2 = await prisma.job.create({
        data: {
          companyId: testCompany.id,
          title: 'Product Design Lead',
          jobCode: 'JOB-DESIGN-01',
          department: 'Design',
          description: 'Lead enterprise product experience design.',
          hiringScope: 'EU',
          status: 'CLOSED',
          openings: 1,
        },
      });
      createdJobIds.push(job2.id);

      // 1. Query all admin jobs
      const resAll = await request(app)
        .get('/api/jobs')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(resAll.status).toBe(200);
      expect(resAll.body.success).toBe(true);
      expect(resAll.body.items.length).toBeGreaterThanOrEqual(2);
      expect(resAll.body.counts).toHaveProperty('ALL');
      expect(resAll.body.counts).toHaveProperty('DRAFT');

      // 2. Search by title
      const resSearch = await request(app)
        .get('/api/jobs')
        .query({ search: 'Elixir' })
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(resSearch.status).toBe(200);
      expect(resSearch.body.items.some((j) => j.id === job1.id)).toBe(true);
      expect(resSearch.body.items.some((j) => j.id === job2.id)).toBe(false);

      // 3. Filter by status
      const resStatus = await request(app)
        .get('/api/jobs')
        .query({ status: 'CLOSED' })
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(resStatus.status).toBe(200);
      expect(resStatus.body.items.some((j) => j.id === job2.id)).toBe(true);
      expect(resStatus.body.items.some((j) => j.id === job1.id)).toBe(false);
    });

    it('parses plain-text (.txt) file upload and rejects other file formats or binaries', async () => {
      // 1. Valid .txt upload
      const validText = 'We are seeking an outstanding software engineer with 5+ years of experience.';
      const resTxt = await request(app)
        .post('/api/jobs/parse-description-file')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .attach('file', Buffer.from(validText, 'utf-8'), 'job-description.txt');

      expect(resTxt.status).toBe(200);
      expect(resTxt.body.success).toBe(true);
      expect(resTxt.body.text).toBe(validText);

      // 2. Reject .pdf file extension
      const resPdf = await request(app)
        .post('/api/jobs/parse-description-file')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .attach('file', Buffer.from('%PDF-1.4 binary content', 'utf-8'), 'resume.pdf');

      expect(resPdf.status).toBe(400);
      expect(resPdf.body.error).toMatch(/Only plain-text \(\.txt\) files are accepted/i);

      // 3. Reject binary content pretending to be txt
      const binaryFakeTxt = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
      const resBin = await request(app)
        .post('/api/jobs/parse-description-file')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .attach('file', binaryFakeTxt, 'malicious.txt');

      expect(resBin.status).toBe(400);
      expect(resBin.body.error).toMatch(/Binary content detected/i);
    });

    it('moderates job status transitions (CLOSED, DRAFT, ARCHIVED)', async () => {
      const job = await prisma.job.create({
        data: {
          companyId: testCompany.id,
          title: 'Moderation Test Job',
          description: 'Testing administrative status transitions.',
          status: 'DRAFT',
        },
      });
      createdJobIds.push(job.id);

      // Suspend / Close job
      const resClose = await request(app)
        .patch(`/api/jobs/${job.id}/status`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({ status: 'CLOSED', reason: 'Temporarily suspended by compliance' });

      expect(resClose.status).toBe(200);
      expect(resClose.body.data.status).toBe('CLOSED');
      expect(resClose.body.data.rejectionReason).toBe('Temporarily suspended by compliance');

      // Reactivate to DRAFT
      const resDraft = await request(app)
        .patch(`/api/jobs/${job.id}/status`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({ status: 'DRAFT' });

      expect(resDraft.status).toBe(200);
      expect(resDraft.body.data.status).toBe('DRAFT');
    });

    it('enforces applicant limit and auto-close when maximum applicants reached', async () => {
      const limitedJob = await prisma.job.create({
        data: {
          companyId: testCompany.id,
          title: 'Limited Intake Internship',
          description: 'Position strictly limited to 1 applicant.',
          status: 'PUBLISHED',
          maxApplicantsLimit: 1,
          autoCloseOnLimit: true,
          publishedAt: new Date(),
        },
      });
      createdJobIds.push(limitedJob.id);

      // First applicant succeeds
      const appRes1 = await request(app)
        .post(`/api/jobs/public/${limitedJob.id}/apply`)
        .send({
          firstName: 'First',
          lastName: 'Applicant',
          email: 'first.applicant@test.com',
        });

      expect(appRes1.status).toBe(201);
      expect(appRes1.body.success).toBe(true);

      // Verify second applicant is blocked due to limit
      const appRes2 = await request(app)
        .post(`/api/jobs/public/${limitedJob.id}/apply`)
        .send({
          firstName: 'Second',
          lastName: 'Applicant',
          email: 'second.applicant@test.com',
        });

      expect(appRes2.status).toBe(400);
      expect(appRes2.body.error).toMatch(/maximum application limit/i);

      // Verify job was automatically closed
      const updatedJob = await prisma.job.findUnique({ where: { id: limitedJob.id } });
      expect(updatedJob.status).toBe('CLOSED');

      // Admin gets applicants for the job
      const applicantsRes = await request(app)
        .get(`/api/jobs/${limitedJob.id}/applicants`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(applicantsRes.status).toBe(200);
      expect(applicantsRes.body.items.length).toBe(1);
      expect(applicantsRes.body.items[0].candidate.email).toBe('first.applicant@test.com');
    });
  });
});
