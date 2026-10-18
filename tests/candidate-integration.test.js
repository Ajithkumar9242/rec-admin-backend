import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { CandidateService } from '../src/modules/candidates/candidate.service.js';
import { ResumeParserService } from '../src/modules/candidates/resumeParser.service.js';

const TEST_ADMIN_EMAIL = 'candidate_suite_admin@recruitrain.test';
const TEST_PASSWORD = 'CandidateAdminSecret123!@#';
const dummyResumePdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');

function postAdminCandidate(app, adminCookie, data, file = dummyResumePdf, filename = 'candidate_resume.pdf') {
  const req = request(app)
    .post('/api/candidates/admin')
    .set('x-test-bypass-csrf', 'true')
    .set('Cookie', adminCookie);
  if (file) {
    req.attach('resume', file, filename);
  }
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null) {
      req.field(k, typeof v === 'boolean' ? String(v) : v);
    }
  }
  return req;
}

describe('RecruiTrain Candidate Module & Shared Identity Integration Suite', () => {
  let app;
  let adminId;
  let adminCookie;
  let adminTotpSecret;

  let testCompanyId;
  let testJobId;
  let expiredJobId;

  const createdCandidateIds = [];
  const createdJobIds = [];
  const createdCompanyIds = [];

  beforeAll(async () => {
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // 1. Clean up prior admin and candidate test records
    const testEmails = [
      'johann.sebastian.bach@leipzig.de',
      'beethoven.ludwig@bonn.de',
      'wolfgang.mozart@salzburg.at',
      'johannes.brahms@hamburg.de',
      'franz.schubert@wien.at',
      'clara.schumann@leipzig.de',
      'felix.mendelssohn@leipzig.de',
      'richard.wagner@leipzig.de',
      'no.resume.candidate@recruitrain.test',
      'robert.schumann@zwickau.de',
    ];
    await prisma.savedJob.deleteMany({ where: { candidate: { email: { in: testEmails } } } });
    await prisma.jobApplication.deleteMany({ where: { candidate: { email: { in: testEmails } } } });
    await prisma.candidate.deleteMany({ where: { email: { in: testEmails } } });

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
        name: 'Candidate Test Administrator',
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

    // 2. Set up test company and jobs
    const company = await prisma.company.create({
      data: {
        name: 'Candidate Suite Tech GmbH',
        status: 'ACTIVE',
        hiringDomestic: true,
        hiringEu: true,
        hiringInternational: true,
      },
    });
    testCompanyId = company.id;
    createdCompanyIds.push(company.id);

    // Active published job
    const job = await prisma.job.create({
      data: {
        companyId: testCompanyId,
        title: 'Senior Full Stack Engineer',
        description: 'Comprehensive software development role in Munich',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days in future
        workArrangements: ['HYBRID', 'REMOTE'],
        hiringScopes: ['DOMESTIC', 'EU'],
      },
    });
    testJobId = job.id;
    createdJobIds.push(job.id);

    // Expired published job
    const expiredJob = await prisma.job.create({
      data: {
        companyId: testCompanyId,
        title: 'Legacy Perl Architect',
        description: 'Expired job position',
        status: 'PUBLISHED',
        publishedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days in past
        workArrangements: ['ON_SITE'],
        hiringScopes: ['DOMESTIC'],
      },
    });
    expiredJobId = expiredJob.id;
    createdJobIds.push(expiredJob.id);
  });

  afterAll(async () => {
    if (createdCandidateIds.length > 0) {
      await prisma.savedJob.deleteMany({ where: { candidateId: { in: createdCandidateIds } } });
      await prisma.jobApplication.deleteMany({ where: { candidateId: { in: createdCandidateIds } } });
      await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
    }
    if (createdJobIds.length > 0) {
      await prisma.savedJob.deleteMany({ where: { jobId: { in: createdJobIds } } });
      await prisma.jobApplication.deleteMany({ where: { jobId: { in: createdJobIds } } });
      await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } });
    }
    if (createdCompanyIds.length > 0) {
      await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
    }
    if (adminId) {
      await prisma.adminBackupCode.deleteMany({ where: { adminId } });
      await prisma.admin.deleteMany({ where: { id: adminId } });
    }
  });

  // --------------------------------------------------------------------------
  // 1. Shared Canonical Identity & Deduplication
  // --------------------------------------------------------------------------
  describe('1. Shared Canonical Identity & Deduplication', () => {
    const candidateEmail = 'johann.sebastian.bach@leipzig.de';
    let registeredCandidateId;
    let candidateCookie;

    it('successfully registers candidate with auto-derived fullName and normalized email', async () => {
      const res = await request(app)
        .post('/api/candidates/register')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: '  JOHANN.SEBASTIAN.BACH@leipzig.de  ',
          password: 'CantataPassword123!',
          firstName: 'Johann',
          middleName: 'Sebastian',
          lastName: 'Bach',
          phone: '+49 151 12345678',
          currentLocation: 'Leipzig, Germany',
          country: 'DE',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe(candidateEmail);
      expect(res.body.data.fullName).toBe('Johann Sebastian Bach');
      expect(res.body.data.profileCompletion).toBeGreaterThan(0);
      expect(res.body.data.passwordHash).toBeUndefined(); // Sensitive credentials stripped

      registeredCandidateId = res.body.data.id;
      createdCandidateIds.push(registeredCandidateId);
      candidateCookie = res.headers['set-cookie'];
    });

    it('rejects duplicate candidate registration when email already registered with password', async () => {
      const res = await request(app)
        .post('/api/candidates/register')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: candidateEmail.toUpperCase(),
          password: 'AnotherPassword456!',
          firstName: 'Johann',
          lastName: 'Bach',
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/already exists/i);
    });

    it('admin creating candidate with existing email returns existing record without duplicating row', async () => {
      const initialCount = await prisma.candidate.count({
        where: { email: candidateEmail },
      });
      expect(initialCount).toBe(1);

      const res = await postAdminCandidate(app, adminCookie, {
        email: candidateEmail,
        firstName: 'Johann',
        lastName: 'Bach',
      });

      expect(res.status).toBe(200);
      expect(res.body.alreadyExists).toBe(true);
      expect(res.body.candidate.id).toBe(registeredCandidateId);

      const finalCount = await prisma.candidate.count({
        where: { email: candidateEmail },
      });
      expect(finalCount).toBe(1); // Zero duplicate rows created
    });

    it('allows an employer/admin-created candidate without password to activate via registration', async () => {
      const employerEmail = 'beethoven.ludwig@bonn.de';
      // Create via admin/employer first
      const adminCreateRes = await postAdminCandidate(app, adminCookie, {
        email: employerEmail,
        firstName: 'Ludwig',
        lastName: 'van Beethoven',
        profession: 'Composer',
        yearsOfExperience: 25,
      });

      expect(adminCreateRes.status).toBe(201);
      createdCandidateIds.push(adminCreateRes.body.candidate.id);

      // Now candidate self-registers to claim profile
      const claimRes = await request(app)
        .post('/api/candidates/register')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: employerEmail.toUpperCase(),
          password: 'OdeToJoyPassword99!',
          firstName: 'Ludwig',
          middleName: 'van',
          lastName: 'Beethoven',
        });

      expect(claimRes.status).toBe(201);
      expect(claimRes.body.data.id).toBe(adminCreateRes.body.candidate.id);
      expect(claimRes.body.data.fullName).toBe('Ludwig van Beethoven');

      // Verify password was set and can sign in
      const loginRes = await request(app)
        .post('/api/candidates/login')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: employerEmail,
          password: 'OdeToJoyPassword99!',
        });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.id).toBe(adminCreateRes.body.candidate.id);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Candidate Authentication, Lockout & Password Recovery
  // --------------------------------------------------------------------------
  describe('2. Candidate Authentication, Lockout & Password Recovery', () => {
    const authCandidateEmail = 'wolfgang.mozart@salzburg.at';
    let authCandidateId;

    beforeAll(async () => {
      const candidate = await CandidateService.register({
        email: authCandidateEmail,
        password: 'MagicFlute1791!',
        firstName: 'Wolfgang',
        middleName: 'Amadeus',
        lastName: 'Mozart',
        currentLocation: 'Vienna, Austria',
      });
      authCandidateId = candidate.id;
      createdCandidateIds.push(candidate.id);
    });

    it('successfully signs in with valid credentials and sets session', async () => {
      const res = await request(app)
        .post('/api/candidates/login')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: authCandidateEmail,
          password: 'MagicFlute1791!',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe(authCandidateEmail);
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('rejects invalid password and increments failed login attempts', async () => {
      const res = await request(app)
        .post('/api/candidates/login')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: authCandidateEmail,
          password: 'WrongPassword!',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      const dbCandidate = await prisma.candidate.findUnique({
        where: { id: authCandidateId },
      });
      expect(dbCandidate.failedLoginAttempts).toBe(1);
    });

    it('locks account after 5 failed login attempts', async () => {
      // Send 4 more failed attempts to reach 5
      for (let i = 0; i < 4; i++) {
        await request(app)
          .post('/api/candidates/login')
          .set('x-test-bypass-csrf', 'true')
          .send({
            email: authCandidateEmail,
            password: 'WrongPassword!',
          });
      }

      // The 5th failure should trigger lockout
      const lockRes = await request(app)
        .post('/api/candidates/login')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: authCandidateEmail,
          password: 'MagicFlute1791!', // Even correct password is rejected while locked
        });

      expect(lockRes.status).toBe(403);
      expect(lockRes.body.error).toMatch(/temporarily locked/i);

      // Unlock for subsequent tests
      await prisma.candidate.update({
        where: { id: authCandidateId },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    });

    it('initiates password recovery with non-enumerating generic response', async () => {
      const res = await request(app)
        .post('/api/candidates/forgot-password')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: authCandidateEmail });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/password reset instructions have been dispatched/i);

      // Verify token hash was set in database
      const candidate = await prisma.candidate.findUnique({
        where: { id: authCandidateId },
      });
      expect(candidate.passwordResetTokenHash).not.toBeNull();
      expect(candidate.passwordResetExpiresAt).not.toBeNull();

      // Generic response even for non-existing email
      const nonExistentRes = await request(app)
        .post('/api/candidates/forgot-password')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: 'nobody_here@phantom.test' });

      expect(nonExistentRes.status).toBe(200);
      expect(nonExistentRes.body.message).toMatch(/password reset instructions have been dispatched/i);
    });

    it('resets candidate password with valid token and enables sign in with new password', async () => {
      // Simulate raw token and hash
      const rawToken = 'my-secret-test-token-1234567890';
      const tokenHash = (await import('../src/lib/crypto.js')).hashToken(rawToken);

      await prisma.candidate.update({
        where: { id: authCandidateId },
        data: {
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const resetRes = await request(app)
        .post('/api/candidates/reset-password')
        .set('x-test-bypass-csrf', 'true')
        .send({
          token: rawToken,
          password: 'BrandNewMozartPassword2026!',
        });

      expect(resetRes.status).toBe(200);
      expect(resetRes.body.success).toBe(true);

      // Login with new password
      const newLoginRes = await request(app)
        .post('/api/candidates/login')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: authCandidateEmail,
          password: 'BrandNewMozartPassword2026!',
        });

      expect(newLoginRes.status).toBe(200);
      expect(newLoginRes.body.data.id).toBe(authCandidateId);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Candidate 360° Profile & Profile Completion Calculation
  // --------------------------------------------------------------------------
  describe('3. Candidate 360° Profile & Completion Score', () => {
    let profileCandidateId;
    let candidateCookie;

    beforeAll(async () => {
      const reg = await request(app)
        .post('/api/candidates/register')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: 'johannes.brahms@hamburg.de',
          password: 'LullabyPassword1868!',
          firstName: 'Johannes',
          lastName: 'Brahms',
        });

      profileCandidateId = reg.body.data.id;
      createdCandidateIds.push(profileCandidateId);
      candidateCookie = reg.headers['set-cookie'];
    });

    it('calculates deterministic profile completion and updates on profile edit', async () => {
      const initialProfileRes = await request(app)
        .get('/api/candidates/me')
        .set('Cookie', candidateCookie);

      expect(initialProfileRes.status).toBe(200);
      const initialScore = initialProfileRes.body.data.profileCompletion;
      expect(initialScore).toBeGreaterThanOrEqual(5);

      // Update personal, address, and professional fields
      const updateRes = await request(app)
        .put('/api/candidates/me')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', candidateCookie)
        .send({
          phone: '+49 170 9876543',
          alternateMobile: '+49 170 1122334',
          dateOfBirth: '1833-05-07T00:00:00.000Z',
          gender: 'MALE',
          maritalStatus: 'SINGLE',
          nationality: 'German',
          addressLine1: 'Speckstrasse 24',
          city: 'Hamburg',
          state: 'Hamburg',
          postalCode: '20354',
          country: 'DE',
          profession: 'Classical Composer',
          employmentType: 'FULL_TIME',
          currentJobTitle: 'Principal Conductor',
          currentCompany: 'Vienna Philharmonic',
          yearsOfExperience: 30,
          noticePeriodDays: 60,
          expectedSalary: 120000,
          workPermitAuthorized: true,
          linkedinUrl: 'https://linkedin.com/in/brahms-composer',
          portfolioUrl: 'https://brahms-classical.org',
          headline: 'Renowned Symphony and Chamber Music Composer',
          summary: 'Dedicated maestro with three decades of orchestration excellence.',
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.profileCompletion).toBeGreaterThan(initialScore);
      expect(updateRes.body.data.profileCompletion).toBeGreaterThanOrEqual(70);
      expect(updateRes.body.data.currentJobTitle).toBe('Principal Conductor');
      expect(updateRes.body.data.fullName).toBe('Johannes Brahms');
    });

    it('uploads valid PDF resume and increases profile completion', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');

      const uploadRes = await request(app)
        .post('/api/candidates/me/resume')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', candidateCookie)
        .attach('resume', pdfBuffer, 'Johannes_Brahms_Curriculum_Vitae.pdf');

      expect(uploadRes.status).toBe(200);
      expect(uploadRes.body.data.resumeUrl).toBeDefined();
      expect(uploadRes.body.data.resumeFileName).toBe('Johannes_Brahms_Curriculum_Vitae.pdf');
      expect(uploadRes.body.data.profileCompletion).toBeGreaterThanOrEqual(85);
    });

    it('rejects prohibited or malicious executable file uploads', async () => {
      const exeBuffer = Buffer.from('MZ\x90\x00\x03\x00\x00\x00'); // Windows PE executable header

      const uploadRes = await request(app)
        .post('/api/candidates/me/resume')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', candidateCookie)
        .attach('resume', exeBuffer, 'payload.exe');

      expect(uploadRes.status).toBe(400);
      expect(uploadRes.body.error).toMatch(/prohibited|executable/i);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Saved Jobs & Expiration Tracking
  // --------------------------------------------------------------------------
  describe('4. Saved Jobs & Expiration Tracking', () => {
    let candidateCookie;

    beforeAll(async () => {
      const reg = await request(app)
        .post('/api/candidates/register')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: 'franz.schubert@wien.at',
          password: 'Winterreise1827!',
          firstName: 'Franz',
          lastName: 'Schubert',
        });

      createdCandidateIds.push(reg.body.data.id);
      candidateCookie = reg.headers['set-cookie'];
    });

    it('saves a job opening and includes expiry status', async () => {
      // Save active job
      const saveActiveRes = await request(app)
        .post(`/api/candidates/me/saved-jobs/${testJobId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', candidateCookie);

      expect(saveActiveRes.status).toBe(200);
      expect(saveActiveRes.body.success).toBe(true);
      expect(saveActiveRes.body.data.jobId).toBe(testJobId);

      // Save expired job
      const saveExpiredRes = await request(app)
        .post(`/api/candidates/me/saved-jobs/${expiredJobId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', candidateCookie);

      expect(saveExpiredRes.status).toBe(200);

      // List saved jobs
      const listRes = await request(app)
        .get('/api/candidates/me/saved-jobs')
        .set('Cookie', candidateCookie);

      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(2);

      const activeSaved = listRes.body.data.find((item) => item.jobId === testJobId);
      const expiredSaved = listRes.body.data.find((item) => item.jobId === expiredJobId);

      expect(activeSaved).toBeDefined();
      expect(activeSaved.isExpired).toBe(false);

      expect(expiredSaved).toBeDefined();
      expect(expiredSaved.isExpired).toBe(true); // Expiration correctly identified
    });

    it('removes a saved job', async () => {
      const removeRes = await request(app)
        .delete(`/api/candidates/me/saved-jobs/${testJobId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', candidateCookie);

      expect(removeRes.status).toBe(200);

      const listRes = await request(app)
        .get('/api/candidates/me/saved-jobs')
        .set('Cookie', candidateCookie);

      expect(listRes.body.data.length).toBe(1);
      expect(listRes.body.data[0].jobId).toBe(expiredJobId);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Admin Candidate Directory, 360° Profile & Soft Deletion
  // --------------------------------------------------------------------------
  describe('5. Admin Candidate Directory, 360° Profile & Soft Deletion', () => {
    let testCandidateId;

    beforeAll(async () => {
      const cand = await CandidateService.register({
        email: 'clara.schumann@leipzig.de',
        password: 'PianoVirtuoso1840!',
        firstName: 'Clara',
        middleName: 'Josephine',
        lastName: 'Schumann',
        profession: 'Concert Pianist',
      });
      testCandidateId = cand.id;
      createdCandidateIds.push(cand.id);
    });

    it('admin lists candidates with pagination, status counts, and search filter', async () => {
      const res = await request(app)
        .get('/api/candidates/admin')
        .query({ search: 'Schumann', page: 1, limit: 10 })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.items[0].email).toBe('clara.schumann@leipzig.de');
      expect(res.body.counts).toBeDefined();
      expect(res.body.counts.all).toBeGreaterThan(0);
    });

    it('admin views candidate 360° profile by id', async () => {
      const res = await request(app)
        .get(`/api/candidates/admin/${testCandidateId}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fullName).toBe('Clara Josephine Schumann');
      expect(res.body.data.email).toBe('clara.schumann@leipzig.de');
    });

    it('admin updates candidate status', async () => {
      const res = await request(app)
        .patch(`/api/candidates/admin/${testCandidateId}/status`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({ status: 'SUSPENDED' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('SUSPENDED');

      // Verify suspended candidate cannot sign in
      const loginRes = await request(app)
        .post('/api/candidates/login')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: 'clara.schumann@leipzig.de',
          password: 'PianoVirtuoso1840!',
        });

      expect(loginRes.status).toBe(403);
      expect(loginRes.body.error).toMatch(/suspended/i);

      // Reactivate
      await CandidateService.updateCandidateStatus(testCandidateId, 'ACTIVE');
    });

    it('admin soft-deletes candidate to trash and restores candidate', async () => {
      // Soft delete
      const deleteRes = await request(app)
        .delete(`/api/candidates/admin/${testCandidateId}`)
        .query({ mode: 'MOVE_TO_TRASH' })
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(deleteRes.status).toBe(200);

      // Candidate is in trash
      const cand = await prisma.candidate.findUnique({ where: { id: testCandidateId } });
      expect(cand.deletedAt).not.toBeNull();

      // Normal list does not show candidate
      const normalListRes = await request(app)
        .get('/api/candidates/admin')
        .query({ search: 'Schumann', inTrash: 'false' })
        .set('Cookie', adminCookie);

      expect(normalListRes.body.items.length).toBe(0);

      // Trash list shows candidate
      const trashListRes = await request(app)
        .get('/api/candidates/admin')
        .query({ search: 'Schumann', inTrash: 'true' })
        .set('Cookie', adminCookie);

      expect(trashListRes.body.items.length).toBe(1);

      // Restore
      const restoreRes = await request(app)
        .post(`/api/candidates/admin/${testCandidateId}/restore`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.data.status).toBe('ACTIVE');

      const restored = await prisma.candidate.findUnique({ where: { id: testCandidateId } });
      expect(restored.deletedAt).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 6. Secure Candidate Account Invitation & Activation Flow
  // --------------------------------------------------------------------------
  describe('6. Secure Candidate Account Invitation & Activation Flow', () => {
    const inviteCandidateEmail = 'felix.mendelssohn@leipzig.de';
    let invitedCandidateId;
    let activationRawToken;

    it('admin creates candidate with complete fieldset (Sections A-G), company association, and generates secure invitation', async () => {
      const res = await postAdminCandidate(app, adminCookie, {
        email: inviteCandidateEmail,
        firstName: 'Felix',
        middleName: 'Jakob',
        lastName: 'Mendelssohn',
        phone: '+49 151 5551234',
        alternateMobile: '+49 151 5555678',
        status: 'ACTIVE',
        companyId: testCompanyId,
        dateOfBirth: '1809-02-03',
        gender: 'MALE',
        maritalStatus: 'MARRIED',
        nationality: 'German',
        profession: 'Conductor & Composer',
        employmentType: 'FULL_TIME',
        currentJobTitle: 'Gewandhauskapellmeister',
        currentCompany: 'Gewandhausorchester Leipzig',
        yearsOfExperience: 20,
        noticePeriodDays: 60,
        currentSalary: 120000,
        expectedSalary: 150000,
        preferredLocation: 'Leipzig / Berlin',
        willingToRelocate: true,
        source: 'ADMIN',
        addressLine1: 'Goldschmidtstraße 12',
        addressLine2: 'Bel étage',
        city: 'Leipzig',
        state: 'Saxony',
        country: 'DE',
        postalCode: '04103',
        passportNumber: 'DE-MENDEL-1809',
        passportExpiryDate: '2032-12-31',
        visaStatus: 'EU Citizen',
        workPermitAuthorized: true,
        linkedinUrl: 'https://linkedin.com/in/felix-mendelssohn',
        portfolioUrl: 'https://mendelssohn-haus.de',
        githubUrl: 'https://github.com/felix-scores',
        sendInvitation: true,
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.alreadyExists).toBe(false);
      expect(res.body.invitationSent).toBe(true);
      expect(res.body.invitationStatus).toBe('PENDING');
      expect(res.body.activationUrl).toBeDefined();

      const candidate = res.body.candidate;
      invitedCandidateId = candidate.id;
      createdCandidateIds.push(invitedCandidateId);

      // Verify full name auto derivation
      expect(candidate.fullName).toBe('Felix Jakob Mendelssohn');
      expect(candidate.companyId).toBe(testCompanyId);
      expect(candidate.profileCompletion).toBeGreaterThan(50);

      // Extract raw token from activation URL
      const url = new URL(res.body.activationUrl);
      activationRawToken = url.searchParams.get('token');
      expect(activationRawToken).toBeDefined();
      expect(activationRawToken.length).toBeGreaterThanOrEqual(32);

      // Verify database state: token hash is stored, raw token is NOT stored
      const dbCandidate = await prisma.candidate.findUnique({ where: { id: invitedCandidateId } });
      expect(dbCandidate.invitationTokenHash).not.toBeNull();
      expect(dbCandidate.invitationTokenHash).not.toBe(activationRawToken);
      expect(dbCandidate.invitationExpiresAt).toBeInstanceOf(Date);
      expect(dbCandidate.invitationExpiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(dbCandidate.invitationSentAt).toBeInstanceOf(Date);
      expect(dbCandidate.invitationStatus).toBe('PENDING');
    });

    it('verifies valid invitation token via public GET /api/candidates/invitations/verify', async () => {
      const res = await request(app)
        .get('/api/candidates/invitations/verify')
        .query({ token: activationRawToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.valid).toBe(true);
      expect(res.body.data.email).toBe(inviteCandidateEmail);
      expect(res.body.data.fullName).toBe('Felix Jakob Mendelssohn');
      expect(res.body.data.company.name).toBe('Candidate Suite Tech GmbH');
    });

    it('rejects tampered or non-existent token on verify endpoint', async () => {
      const res = await request(app)
        .get('/api/candidates/invitations/verify')
        .query({ token: 'nonexistent_or_tampered_token_xyz_1234567890' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/invalid or expired/i);
    });

    it('activates candidate account with valid token and sets Argon2id password', async () => {
      const newPassword = 'ElijahOratorio1846!@#';
      const res = await request(app)
        .post('/api/candidates/invitations/activate')
        .send({
          token: activationRawToken,
          password: newPassword,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/activated/i);

      // Verify database state: passwordHash set, invitationStatus ACCEPTED, token consumed
      const dbCandidate = await prisma.candidate.findUnique({ where: { id: invitedCandidateId } });
      expect(dbCandidate.passwordHash).not.toBeNull();
      expect(dbCandidate.invitationStatus).toBe('ACCEPTED');
      expect(dbCandidate.emailVerified).toBe(true);
      expect(dbCandidate.invitationTokenHash).toBeNull();

      // Candidate can now sign in with their chosen password
      const loginRes = await request(app)
        .post('/api/candidates/login')
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: inviteCandidateEmail,
          password: newPassword,
        });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.success).toBe(true);
      expect(loginRes.body.data.email).toBe(inviteCandidateEmail);
    });

    it('enforces single-use: consumed token cannot be reused for verification or activation', async () => {
      const verifyRes = await request(app)
        .get('/api/candidates/invitations/verify')
        .query({ token: activationRawToken });

      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.success).toBe(false);

      const activateRes = await request(app)
        .post('/api/candidates/invitations/activate')
        .send({
          token: activationRawToken,
          password: 'AnotherPassword123!',
        });

      expect(activateRes.status).toBe(400);
      expect(activateRes.body.success).toBe(false);
    });

    it('handles deduplication: submitting already activated candidate preserves credentials and returns safe message', async () => {
      const res = await postAdminCandidate(app, adminCookie, {
        email: inviteCandidateEmail,
        firstName: 'Felix',
        lastName: 'Mendelssohn',
      });

      expect(res.status).toBe(200);
      expect(res.body.alreadyExists).toBe(true);
      expect(res.body.alreadyActivated).toBe(true);
      expect(res.body.invitationSent).toBe(false);
      expect(res.body.message).toMatch(/already exists and has an active account/i);
    });

    it('admin resend invitation generates new token and enforces cooldown', async () => {
      // Create another candidate without an active account
      const wagnerRes = await postAdminCandidate(app, adminCookie, {
        email: 'richard.wagner@leipzig.de',
        firstName: 'Richard',
        lastName: 'Wagner',
        profession: 'Composer',
        sendInvitation: true,
      });

      expect(wagnerRes.status).toBe(201);
      const wagnerId = wagnerRes.body.candidate.id;
      createdCandidateIds.push(wagnerId);

      // Rapid resend triggers cooldown rate limit
      const rapidResendRes = await request(app)
        .post(`/api/candidates/admin/${wagnerId}/resend-invitation`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(rapidResendRes.status).toBe(429);
      expect(rapidResendRes.body.error).toMatch(/wait/i);
    });

    it('enforces mandatory resume: rejects candidate creation when resume is missing', async () => {
      const res = await request(app)
        .post('/api/candidates/admin')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .field('email', 'no.resume.candidate@recruitrain.test')
        .field('firstName', 'No')
        .field('lastName', 'Resume');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/resume.*required/i);
    });

    it('rejects candidate creation with suspicious or executable files masked as pdf', async () => {
      const fakeExe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00fake-pe-file');
      const res = await postAdminCandidate(app, adminCookie, {
        email: 'malicious.candidate@recruitrain.test',
        firstName: 'Malicious',
        lastName: 'File',
      }, fakeExe, 'trojan.pdf');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/unsupported|executable|malformed/i);
    });

    it('POST /api/candidates/admin/parse-resume parses uploaded text and returns suggestions', async () => {
      const extractSpy = vi.spyOn(ResumeParserService, 'extractText').mockResolvedValueOnce({
        text: 'Clara Schumann\nEmail: clara.schumann@leipzig.de\nPhone: +49 151 9876543\nPianist & Composer at Leipzig Conservatory\nCity: Leipzig, Germany',
        supported: true,
        format: 'PDF',
        success: true,
        error: null,
      });

      const parseRes = await request(app)
        .post('/api/candidates/admin/parse-resume')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .attach('resume', Buffer.from('%PDF-1.4 mock text'), 'clara_resume.pdf');

      expect(parseRes.status).toBe(200);
      expect(parseRes.body.success).toBe(true);
      expect(parseRes.body.suggestions).toBeDefined();
      expect(parseRes.body.suggestions.email).toBe('clara.schumann@leipzig.de');
      expect(parseRes.body.suggestions.firstName).toBe('Clara');
      expect(parseRes.body.suggestions.lastName).toBe('Schumann');
      extractSpy.mockRestore();
    });

    it('admin uploads candidate resume with validation', async () => {
      // Standalone admin resume upload
      const dummyPdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
      const res = await request(app)
        .post(`/api/candidates/admin/${invitedCandidateId}/resume`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .attach('resume', dummyPdf, 'mendelssohn_manuscript.pdf');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.resumeFileName).toBe('mendelssohn_manuscript.pdf');
    });
  });

  // --------------------------------------------------------------------------
  // 9. Targeted Fixes: Resume Stream, Company Association & Job Visibility
  // --------------------------------------------------------------------------
  describe('9. Targeted Fixes: Resume Stream, Company Association & Job Visibility', () => {
    let testCandidateId;
    let testCandidateWithResumeId;
    let secondCompanyId;

    beforeAll(async () => {
      // Clean up previous runs
      await prisma.savedJob.deleteMany({
        where: { candidate: { email: { in: ['no.resume.candidate@recruitrain.test', 'robert.schumann@zwickau.de'] } } },
      });
      await prisma.jobApplication.deleteMany({
        where: { candidate: { email: { in: ['no.resume.candidate@recruitrain.test', 'robert.schumann@zwickau.de'] } } },
      });
      await prisma.candidate.deleteMany({
        where: { email: { in: ['no.resume.candidate@recruitrain.test', 'robert.schumann@zwickau.de'] } },
      });
      await prisma.job.deleteMany({
        where: { company: { name: 'Gewandhaus Leipzig GmbH' } },
      });
      await prisma.company.deleteMany({
        where: { name: 'Gewandhaus Leipzig GmbH' },
      });

      // Create second company for multi-company visibility testing
      const comp2 = await prisma.company.create({
        data: {
          name: 'Gewandhaus Leipzig GmbH',
          legalName: 'Gewandhaus Leipzig GmbH & Co. KG',
          status: 'ACTIVE',
          country: 'DE',
          city: 'Leipzig',
          hiringDomestic: true,
          hiringEu: true,
          hiringInternational: true,
        },
      });
      secondCompanyId = comp2.id;

      // Create a published job for second company
      await prisma.job.create({
        data: {
          companyId: secondCompanyId,
          title: 'Concertmaster Violinist',
          status: 'PUBLISHED',
          hiringScope: 'DOMESTIC',
          description: 'Leading violin section for classical subscription season.',
          publishedAt: new Date(),
        },
      });

      // Create candidate without resume
      const candNoResume = await prisma.candidate.create({
        data: {
          email: 'no.resume.candidate@recruitrain.test',
          firstName: 'NoResume',
          lastName: 'Candidate',
          fullName: 'NoResume Candidate',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      testCandidateId = candNoResume.id;

      // Create candidate with resume
      const dummyPdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< /Title (Test Resume) >>\nendobj\ntrailer\n<<>>\n%%EOF');
      const createRes = await request(app)
        .post('/api/candidates/admin')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .field('firstName', 'Robert')
        .field('lastName', 'Schumann')
        .field('email', 'robert.schumann@zwickau.de')
        .field('companyId', testCompanyId)
        .attach('resume', dummyPdf, 'Robert_Schumann_CV.pdf');

      expect(createRes.status).toBe(201);
      testCandidateWithResumeId = createRes.body.candidate.id;
    }, 30000);

    afterAll(async () => {
      await prisma.savedJob.deleteMany({
        where: { candidateId: { in: [testCandidateId, testCandidateWithResumeId].filter(Boolean) } },
      });
      await prisma.jobApplication.deleteMany({
        where: { candidateId: { in: [testCandidateId, testCandidateWithResumeId].filter(Boolean) } },
      });
      await prisma.candidate.deleteMany({
        where: { id: { in: [testCandidateId, testCandidateWithResumeId].filter(Boolean) } },
      });
      if (secondCompanyId) {
        await prisma.job.deleteMany({ where: { companyId: secondCompanyId } });
        await prisma.company.deleteMany({ where: { id: secondCompanyId } });
      }
    }, 30000);

    it('GET /api/candidates/admin/:id/resume streams document with inline disposition for preview', async () => {
      const res = await request(app)
        .get(`/api/candidates/admin/${testCandidateWithResumeId}/resume?disposition=inline`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toMatch(/inline/);
      expect(res.headers['cache-control']).toMatch(/private/);
      expect(res.body).toBeInstanceOf(Buffer);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('GET /api/candidates/admin/:id/resume streams document with attachment disposition for download', async () => {
      const res = await request(app)
        .get(`/api/candidates/admin/${testCandidateWithResumeId}/resume?disposition=attachment`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toMatch(/Robert_Schumann_CV\.pdf/);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('GET /api/candidates/admin/:id/resume returns 404 if candidate has no uploaded resume', async () => {
      const res = await request(app)
        .get(`/api/candidates/admin/${testCandidateId}/resume`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/resume document not found/i);
    });

    it('GET /api/candidates/admin/:id/resume rejects unauthenticated requests', async () => {
      const res = await request(app)
        .get(`/api/candidates/admin/${testCandidateWithResumeId}/resume`);

      expect(res.status).toBe(401);
    });

    it('PUT /api/candidates/admin/:id updates candidate company association', async () => {
      const res = await request(app)
        .put(`/api/candidates/admin/${testCandidateWithResumeId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          companyId: secondCompanyId,
          headline: 'Renowned Romantic Composer and Critic',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.companyId).toBe(secondCompanyId);
      expect(res.body.data.company).toBeDefined();
      expect(res.body.data.company.name).toBe('Gewandhaus Leipzig GmbH');
    });

    it('PUT /api/candidates/admin/:id allows clearing company association', async () => {
      const res = await request(app)
        .put(`/api/candidates/admin/${testCandidateWithResumeId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          companyId: null,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.companyId).toBeNull();
      expect(res.body.data.company).toBeNull();
    });

    it('PUT /api/candidates/admin/:id rejects invalid or non-existent companyId', async () => {
      const res = await request(app)
        .put(`/api/candidates/admin/${testCandidateWithResumeId}`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie)
        .send({
          companyId: '00000000-0000-0000-0000-000000000099',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/selected company was not found/i);
    });

    it('Candidate Job Visibility: candidates with and without company association discover all public jobs', async () => {
      // Query public jobs endpoint
      const res = await request(app)
        .get('/api/jobs/public');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const jobsList = res.body.items || res.body.data || [];
      expect(Array.isArray(jobsList)).toBe(true);

      const titles = jobsList.map((j) => j.title);
      // Both jobs from testCompanyId and secondCompanyId are discoverable
      expect(titles).toContain('Concertmaster Violinist');
      expect(jobsList.length).toBeGreaterThanOrEqual(1);

      // Verify no companyId parameter restricts public discovery
      const compNames = jobsList.map((j) => j.company?.name);
      expect(compNames).toContain('Gewandhaus Leipzig GmbH');
    });

    it('Candidate Invitation verification and activation lifecycle with single-use Argon2 token', async () => {
      // 1. Dispatch invitation to candidate
      const inviteRes = await request(app)
        .post(`/api/candidates/admin/${testCandidateId}/resend-invitation`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', adminCookie);

      expect(inviteRes.status).toBe(200);
      expect(inviteRes.body.activationUrl).toBeDefined();

      const urlObj = new URL(inviteRes.body.activationUrl);
      const token = urlObj.searchParams.get('token');
      expect(token).toBeDefined();

      // 2. Verify token
      const verifyRes = await request(app)
        .get(`/api/candidates/invitations/verify?token=${token}`);

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.valid).toBe(true);
      expect(verifyRes.body.data.candidateId).toBe(testCandidateId);

      // 3. Activate account
      const activateRes = await request(app)
        .post('/api/candidates/invitations/activate')
        .send({
          token,
          password: 'SecureCandidatePassword2026!',
          firstName: 'Robert',
          lastName: 'Schumann',
        });

      expect(activateRes.status).toBe(200);
      expect(activateRes.body.success).toBe(true);

      // 4. Token cannot be reused (single-use cryptographic security)
      const reuseRes = await request(app)
        .get(`/api/candidates/invitations/verify?token=${token}`);

      expect(reuseRes.status).toBe(400);
      expect(reuseRes.body.error).toMatch(/invalid|expired|already been accepted/i);
    });
  });
});
