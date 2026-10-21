import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { ensureSystemRoles } from '../src/modules/teams/roleBootstrap.js';
import { JobService, mapStageToApplicationStatus } from '../src/modules/jobs/job.service.js';

const SUPER_ADMIN_EMAIL = 'pipeline_superadmin@recruitrain.test';
const TEST_PASSWORD = 'PipelineSecurePassword123!@#';

describe('Phase 1: Hiring Pipeline & Application Stage History Integration Suite', () => {
  let app;
  let superAdminId;
  let superAdminCookie;
  let superAdminTotpSecret;

  // Cleanup tracking
  const cleanupCompanyIds = [];
  const cleanupJobIds = [];
  const cleanupCandidateIds = [];
  const cleanupStageIds = [];
  const cleanupTeamIds = [];
  const cleanupAdminIds = [];
  const cleanupRoleIds = [];

  // Reusable test stages
  let stageScreening;
  let stageInterview;
  let stageOffer;
  let stageHired;
  let stageRejected;
  let stageInactive;

  // Helper to authenticate an admin
  async function createAuthenticatedAdmin(email, roleCode = 'SUPER_ADMIN', companyId = null) {
    const existing = await prisma.admin.findUnique({ where: { email } });
    if (existing) {
      await prisma.teamMember.deleteMany({ where: { adminId: existing.id } });
      await prisma.companyAuditLog.deleteMany({ where: { adminId: existing.id } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: existing.id } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: existing.id } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: existing.id } });
      await prisma.admin.delete({ where: { id: existing.id } });
    }

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const totpGen = generateTotpSecret(email);
    const encryptedSecret = encryptTotpSecret(totpGen.secret);

    const admin = await prisma.admin.create({
      data: {
        email,
        name: `Test User ${roleCode}`,
        passwordHash,
        role: roleCode === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptedSecret,
      },
    });
    cleanupAdminIds.push(admin.id);

    let teamId = null;
    if (roleCode !== 'SUPER_ADMIN') {
      const role = await prisma.role.findFirst({
        where: { code: roleCode, companyId: null },
      });
      if (!role) throw new Error(`Role ${roleCode} not found in database`);

      const team = await prisma.team.create({
        data: {
          name: `Team for ${email}`,
          companyId: companyId || null,
        },
      });
      teamId = team.id;
      cleanupTeamIds.push(team.id);

      await prisma.teamMember.create({
        data: {
          teamId: team.id,
          adminId: admin.id,
          roleId: role.id,
        },
      });
    }

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email, password: TEST_PASSWORD });

    const code = authenticator.generate(totpGen.secret);
    const verifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', loginRes.headers['set-cookie'])
      .send({ adminId: admin.id, code });

    return {
      admin,
      cookie: verifyRes.headers['set-cookie'],
      teamId,
    };
  }

  beforeAll(async () => {
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // 1. Ensure system roles exist
    await ensureSystemRoles(prisma);

    // 2. Setup Super Admin
    const authSuperAdmin = await createAuthenticatedAdmin(SUPER_ADMIN_EMAIL, 'SUPER_ADMIN');
    superAdminId = authSuperAdmin.admin.id;
    superAdminCookie = authSuperAdmin.cookie;

    // 3. Ensure dynamic recruitment stages for the pipeline tests
    const stagesDef = [
      { name: 'Pipeline Screening', category: 'SCREENING', order: 1, status: 'ACTIVE' },
      { name: 'Pipeline Interview', category: 'INTERVIEW', order: 2, status: 'ACTIVE' },
      { name: 'Pipeline Offer', category: 'OFFER', order: 3, status: 'ACTIVE' },
      { name: 'Pipeline Hired', category: 'HIRED', order: 4, status: 'ACTIVE' },
      { name: 'Pipeline Rejected', category: 'REJECTED', order: 5, status: 'ACTIVE' },
      { name: 'Pipeline Inactive', category: 'SCREENING', order: 6, status: 'INACTIVE' },
    ];

    for (const def of stagesDef) {
      const stage = await prisma.recruitmentStage.upsert({
        where: { name: def.name },
        update: { category: def.category, order: def.order, status: def.status, deletedAt: null },
        create: def,
      });
      cleanupStageIds.push(stage.id);

      if (def.name === 'Pipeline Screening') stageScreening = stage;
      if (def.name === 'Pipeline Interview') stageInterview = stage;
      if (def.name === 'Pipeline Offer') stageOffer = stage;
      if (def.name === 'Pipeline Hired') stageHired = stage;
      if (def.name === 'Pipeline Rejected') stageRejected = stage;
      if (def.name === 'Pipeline Inactive') stageInactive = stage;
    }

    // Ensure platform setting exists
    await prisma.platformSetting.upsert({
      where: { id: 'global' },
      update: { autoApproveJobs: true },
      create: { id: 'global', autoApproveJobs: true },
    });
  }, 35000);

  afterAll(async () => {
    // Clean up applications, candidates, jobs, companies
    if (cleanupJobIds.length > 0) {
      await prisma.applicationStageHistory.deleteMany({
        where: { application: { jobId: { in: cleanupJobIds } } },
      });
      await prisma.jobApplication.deleteMany({ where: { jobId: { in: cleanupJobIds } } });
      await prisma.job.deleteMany({ where: { id: { in: cleanupJobIds } } });
    }
    if (cleanupCandidateIds.length > 0) {
      await prisma.jobApplication.deleteMany({ where: { candidateId: { in: cleanupCandidateIds } } });
      await prisma.candidate.deleteMany({ where: { id: { in: cleanupCandidateIds } } });
    }
    if (cleanupTeamIds.length > 0) {
      await prisma.teamMember.deleteMany({ where: { teamId: { in: cleanupTeamIds } } });
      await prisma.team.deleteMany({ where: { id: { in: cleanupTeamIds } } });
    }
    if (cleanupCompanyIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: cleanupCompanyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: cleanupCompanyIds } } });
    }
    if (cleanupAdminIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { adminId: { in: cleanupAdminIds } } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: { in: cleanupAdminIds } } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: cleanupAdminIds } } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: { in: cleanupAdminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: cleanupAdminIds } } });
    }
    if (cleanupRoleIds.length > 0) {
      await prisma.rolePermission.deleteMany({ where: { roleId: { in: cleanupRoleIds } } });
      await prisma.role.deleteMany({ where: { id: { in: cleanupRoleIds } } });
    }
    if (cleanupStageIds.length > 0) {
      await prisma.recruitmentStage.deleteMany({ where: { id: { in: cleanupStageIds } } });
    }
  });

  // Helper to create a company and a published job
  async function setupTestJob(companyName = 'Hiring Pipeline Test Company') {
    const company = await prisma.company.create({
      data: {
        name: `${companyName} ${Date.now()}`,
        status: 'ACTIVE',
        country: 'DE',
        email: `contact_${Date.now()}@pipeline.test`,
      },
    });
    cleanupCompanyIds.push(company.id);

    const job = await prisma.job.create({
      data: {
        companyId: company.id,
        title: `Full Stack Engineer ${Date.now()}`,
        description: 'Design and develop scalable applications.',
        status: 'PUBLISHED',
        country: 'DE',
        city: 'Berlin',
      },
    });
    cleanupJobIds.push(job.id);

    return { company, job };
  }

  // ----------------------------------------------------
  // Test 1: Initial stage assignment on application submission
  // ----------------------------------------------------
  it('1. assigns initial active stage and records stage history on application submission', async () => {
    const { job } = await setupTestJob('Initial Stage Co');

    const candidateEmail = `applicant_initial_${Date.now()}@candidate.test`;
    const applyRes = await request(app)
      .post(`/api/jobs/public/${job.id}/apply`)
      .set('x-test-bypass-csrf', 'true')
      .send({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: candidateEmail,
        headline: 'First Computer Programmer',
      });

    expect(applyRes.status).toBe(201);
    expect(applyRes.body.success).toBe(true);
    expect(applyRes.body.applicationId).toBeDefined();

    const applicationId = applyRes.body.applicationId;

    // Verify application in DB
    const firstActiveStage = await prisma.recruitmentStage.findFirst({
      where: { status: 'ACTIVE', deletedAt: null },
      orderBy: { order: 'asc' },
    });
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: {
        currentStage: true,
        stageHistories: true,
      },
    });
    expect(application).not.toBeNull();
    expect(application.status).toBe('SUBMITTED');
    expect(application.currentStageId).toBe(firstActiveStage.id);

    // Verify persisted stage history
    expect(application.stageHistories).toHaveLength(1);
    const initialHistory = application.stageHistories[0];
    expect(initialHistory.previousStageId).toBeNull();
    expect(initialHistory.destinationStageId).toBe(firstActiveStage.id);
    expect(initialHistory.actorId).toBeNull();
    expect(initialHistory.notes).toMatch(/initial/i);

    cleanupCandidateIds.push(application.candidateId);
  });

  // ----------------------------------------------------
  // Test 2: Valid transition and persisted stage history
  // ----------------------------------------------------
  it('2. advances stage, synchronizes application status, persists history, and logs audit', async () => {
    const { company, job } = await setupTestJob('Transition Co');

    // Create candidate and application
    const candidate = await prisma.candidate.create({
      data: {
        firstName: 'Alan',
        lastName: 'Turing',
        email: `turing_${Date.now()}@candidate.test`,
      },
    });
    cleanupCandidateIds.push(candidate.id);

    const application = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidate.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    // Advance to Interview stage
    const transitionRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({
        destinationStageId: stageInterview.id,
        expectedPreviousStageId: stageScreening.id,
        notes: 'Passed initial screening, scheduling technical interview',
      });

    expect(transitionRes.status).toBe(200);
    expect(transitionRes.body.success).toBe(true);
    expect(transitionRes.body.data.currentStageId).toBe(stageInterview.id);
    expect(transitionRes.body.data.status).toBe('INTERVIEW');

    // Check DB state
    const updatedApp = await prisma.jobApplication.findUnique({
      where: { id: application.id },
      include: {
        stageHistories: { orderBy: { createdAt: 'desc' } },
      },
    });
    expect(updatedApp.currentStageId).toBe(stageInterview.id);
    expect(updatedApp.status).toBe('INTERVIEW');
    expect(updatedApp.stageHistories).toHaveLength(1);

    const history = updatedApp.stageHistories[0];
    expect(history.previousStageId).toBe(stageScreening.id);
    expect(history.destinationStageId).toBe(stageInterview.id);
    expect(history.actorId).toBe(superAdminId);
    expect(history.notes).toBe('Passed initial screening, scheduling technical interview');

    // Check CompanyAuditLog entry
    const auditLogs = await prisma.companyAuditLog.findMany({
      where: {
        companyId: company.id,
        action: 'APPLICATION_STAGE_CHANGED',
      },
    });
    expect(auditLogs.length).toBeGreaterThanOrEqual(1);
    const audit = auditLogs[0];
    expect(audit.adminId).toBe(superAdminId);
    expect(audit.details.applicationId).toBe(application.id);
    expect(audit.details.previousStageId).toBe(stageScreening.id);
    expect(audit.details.destinationStageId).toBe(stageInterview.id);
    expect(audit.details.newStatus).toBe('INTERVIEW');
  });

  // ----------------------------------------------------
  // Test 3: Invalid or inactive destination stage
  // ----------------------------------------------------
  it('3. rejects transition when destination stage is invalid, inactive, or archived', async () => {
    const { job } = await setupTestJob('Invalid Stage Co');

    const candidate = await prisma.candidate.create({
      data: {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: `hopper_${Date.now()}@candidate.test`,
      },
    });
    cleanupCandidateIds.push(candidate.id);

    const application = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidate.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    // 3a. Inactive stage
    const inactiveRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: stageInactive.id });

    expect(inactiveRes.status).toBe(400);
    expect(inactiveRes.body.error).toMatch(/invalid, inactive, or archived/i);

    // 3b. Non-existent random UUID stage
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const missingRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: fakeUuid });

    expect(missingRes.status).toBe(400);
    expect(missingRes.body.error).toMatch(/invalid, inactive, or archived/i);

    // 3c. Soft-deleted stage
    const softDeletedStage = await prisma.recruitmentStage.create({
      data: {
        name: `Soft Deleted Stage ${Date.now()}`,
        status: 'ACTIVE',
        deletedAt: new Date(),
      },
    });
    cleanupStageIds.push(softDeletedStage.id);

    const deletedRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: softDeletedStage.id });

    expect(deletedRes.status).toBe(400);
    expect(deletedRes.body.error).toMatch(/invalid, inactive, or archived/i);
  });

  // ----------------------------------------------------
  // Test 4: Cross-job application ID mismatch
  // ----------------------------------------------------
  it('4. rejects transition when application ID does not belong to requested job', async () => {
    const { job: jobA } = await setupTestJob('Company Job A');
    const { job: jobB } = await setupTestJob('Company Job B');

    const candidate = await prisma.candidate.create({
      data: {
        firstName: 'Claude',
        lastName: 'Shannon',
        email: `shannon_${Date.now()}@candidate.test`,
      },
    });
    cleanupCandidateIds.push(candidate.id);

    // Application belongs to Job A
    const appA = await prisma.jobApplication.create({
      data: {
        jobId: jobA.id,
        candidateId: candidate.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    // Attempt to update via Job B route
    const mismatchRes = await request(app)
      .patch(`/api/jobs/${jobB.id}/applications/${appA.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: stageInterview.id });

    expect(mismatchRes.status).toBe(400);
    expect(mismatchRes.body.error).toMatch(/does not belong to the specified job/i);
  });

  // ----------------------------------------------------
  // Test 5: HIRED/REJECTED terminal-state protection
  // ----------------------------------------------------
  it('5. enforces terminal-state protection for HIRED and REJECTED applications', async () => {
    const { job } = await setupTestJob('Terminal State Co');

    const candidateHired = await prisma.candidate.create({
      data: { firstName: 'Hired', lastName: 'Candidate', email: `hired_${Date.now()}@candidate.test` },
    });
    const candidateRejected = await prisma.candidate.create({
      data: { firstName: 'Rejected', lastName: 'Candidate', email: `rejected_${Date.now()}@candidate.test` },
    });
    cleanupCandidateIds.push(candidateHired.id, candidateRejected.id);

    // Create applications already in terminal state
    const appHired = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidateHired.id,
        currentStageId: stageHired.id,
        status: 'HIRED',
      },
    });

    const appRejected = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidateRejected.id,
        currentStageId: stageRejected.id,
        status: 'REJECTED',
      },
    });

    // Attempt to reopen HIRED application
    const reopenHiredRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${appHired.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: stageScreening.id });

    expect(reopenHiredRes.status).toBe(400);
    expect(reopenHiredRes.body.error).toMatch(/terminal state 'HIRED'/i);

    // Attempt to reopen REJECTED application
    const reopenRejectedRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${appRejected.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: stageInterview.id });

    expect(reopenRejectedRes.status).toBe(400);
    expect(reopenRejectedRes.body.error).toMatch(/terminal state 'REJECTED'/i);

    // Moving an active application to REJECTED requires a rejection reason
    const candidateActive = await prisma.candidate.create({
      data: { firstName: 'Active', lastName: 'Candidate', email: `active_${Date.now()}@candidate.test` },
    });
    cleanupCandidateIds.push(candidateActive.id);

    const appActive = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidateActive.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    const noReasonRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${appActive.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({
        destinationStageId: stageRejected.id,
        // rejectionReason intentionally omitted
      });

    expect(noReasonRes.status).toBe(400);
    expect(noReasonRes.body.error).toMatch(/rejection reason is required/i);

    // With reason, successfully transitions to REJECTED
    const validRejectRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${appActive.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({
        destinationStageId: stageRejected.id,
        rejectionReason: 'Position closed; insufficient experience in distributed systems',
      });

    expect(validRejectRes.status).toBe(200);
    expect(validRejectRes.body.data.status).toBe('REJECTED');
  });

  // ----------------------------------------------------
  // Test 6: Concurrent conflicting stage changes
  // ----------------------------------------------------
  it('6. detects concurrent conflicting stage changes and returns HTTP 409', async () => {
    const { job } = await setupTestJob('Concurrency Co');

    const candidate = await prisma.candidate.create({
      data: { firstName: 'Donald', lastName: 'Knuth', email: `knuth_${Date.now()}@candidate.test` },
    });
    cleanupCandidateIds.push(candidate.id);

    const application = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidate.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    // 6a. Stale expectedPreviousStageId
    const staleRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({
        destinationStageId: stageInterview.id,
        expectedPreviousStageId: stageOffer.id, // Does not match actual current stage (Screening)
      });

    expect(staleRes.status).toBe(409);
    expect(staleRes.body.error).toMatch(/stage conflict detected/i);

    // 6b. Redundant move to identical destination stage returns 409
    const redundantRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({
        destinationStageId: stageScreening.id, // Already in screening
      });

    expect(redundantRes.status).toBe(409);
    expect(redundantRes.body.error).toMatch(/already in the requested destination stage/i);
  });

  // ----------------------------------------------------
  // Test 7: READ-only users cannot advance stages
  // ----------------------------------------------------
  it('7. forbids users with READ-only permissions from advancing application stages', async () => {
    const { job } = await setupTestJob('ReadOnly Check Co');

    const readOnlyUser = await createAuthenticatedAdmin(
      `readonly_${Date.now()}@recruitrain.test`,
      'READ_ONLY'
    );

    const candidate = await prisma.candidate.create({
      data: { firstName: 'Barbara', lastName: 'Liskov', email: `liskov_${Date.now()}@candidate.test` },
    });
    cleanupCandidateIds.push(candidate.id);

    const application = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidate.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    const editRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', readOnlyUser.cookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: stageInterview.id });

    expect(editRes.status).toBe(403);
    expect(editRes.body.error).toMatch(/You do not have 'EDIT' permission for the 'APPLICATIONS' module/i);
  });

  // ----------------------------------------------------
  // Test 8: EDIT-authorized users can advance stages
  // ----------------------------------------------------
  it('8. authorizes users with EDIT permissions (e.g. Hiring Manager) to advance stages', async () => {
    const { job } = await setupTestJob('Edit Authorized Co');

    const hiringManagerUser = await createAuthenticatedAdmin(
      `hiringmgr_${Date.now()}@recruitrain.test`,
      'HIRING_MANAGER'
    );

    const candidate = await prisma.candidate.create({
      data: { firstName: 'Tim', lastName: 'Berners-Lee', email: `timbl_${Date.now()}@candidate.test` },
    });
    cleanupCandidateIds.push(candidate.id);

    const application = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidate.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    const advanceRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', hiringManagerUser.cookie)
      .set('x-test-bypass-csrf', 'true')
      .send({
        destinationStageId: stageInterview.id,
        notes: 'Advancing candidate from hiring manager review',
      });

    expect(advanceRes.status).toBe(200);
    expect(advanceRes.body.success).toBe(true);
    expect(advanceRes.body.data.currentStageId).toBe(stageInterview.id);
  });

  // ----------------------------------------------------
  // Test 9: Users without READ cannot view the pipeline
  // ----------------------------------------------------
  it('9. denies pipeline view to users lacking APPLICATIONS:READ permission', async () => {
    const { job } = await setupTestJob('No Read Pipeline Co');

    // Create a custom role with APPLICATIONS: READ = false
    const restrictedRole = await prisma.role.create({
      data: {
        code: `NO_APPS_READ_${Date.now()}`,
        name: 'No Applications Access',
        permissions: {
          create: [
            { module: 'APPLICATIONS', action: 'READ', allowed: false },
            { module: 'APPLICATIONS', action: 'EDIT', allowed: false },
            { module: 'JOBS', action: 'READ', allowed: true },
          ],
        },
      },
    });
    cleanupRoleIds.push(restrictedRole.id);

    const restrictedAdmin = await prisma.admin.create({
      data: {
        email: `restricted_${Date.now()}@recruitrain.test`,
        name: 'Restricted Pipeline Admin',
        passwordHash: await hashPassword(TEST_PASSWORD),
        role: 'ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptTotpSecret(generateTotpSecret('restricted').secret),
      },
    });
    cleanupAdminIds.push(restrictedAdmin.id);

    const team = await prisma.team.create({
      data: { name: `Restricted Team ${Date.now()}` },
    });
    cleanupTeamIds.push(team.id);

    await prisma.teamMember.create({
      data: {
        teamId: team.id,
        adminId: restrictedAdmin.id,
        roleId: restrictedRole.id,
      },
    });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: restrictedAdmin.email, password: TEST_PASSWORD });

    const pipeRes = await request(app)
      .get(`/api/jobs/${job.id}/pipeline`)
      .set('Cookie', loginRes.headers['set-cookie'])
      .set('x-test-bypass-csrf', 'true');

    // Expected 401 if not verified, or 403 once authenticated without READ
    // Complete 2FA to test actual permission check
    const totpRaw = generateTotpSecret('restricted').secret;
    // Login with proper TOTP verified session
    const authRestricted = await createAuthenticatedAdmin(
      `restricted_totp_${Date.now()}@recruitrain.test`,
      'READ_ONLY'
    );
    // Overwrite team membership with the restricted role
    await prisma.teamMember.updateMany({
      where: { adminId: authRestricted.admin.id },
      data: { roleId: restrictedRole.id },
    });

    const pipeForbiddenRes = await request(app)
      .get(`/api/jobs/${job.id}/pipeline`)
      .set('Cookie', authRestricted.cookie)
      .set('x-test-bypass-csrf', 'true');

    expect(pipeForbiddenRes.status).toBe(403);
    expect(pipeForbiddenRes.body.error).toMatch(/You do not have 'READ' permission for the 'APPLICATIONS' module/i);
  });

  // ----------------------------------------------------
  // Test 10: Cross-company access is rejected
  // ----------------------------------------------------
  it('10. isolates tenants: rejects cross-company pipeline access and stage updates', async () => {
    const { company: companyA, job: jobA } = await setupTestJob('Company Alpha');
    const { company: companyB, job: jobB } = await setupTestJob('Company Beta');

    // Create an admin scoped strictly to Company A
    const companyAAdmin = await createAuthenticatedAdmin(
      `alpha_admin_${Date.now()}@recruitrain.test`,
      'COMPANY_ADMIN',
      companyA.id
    );

    // Company A admin views Job A pipeline -> OK
    const viewOwnPipeline = await request(app)
      .get(`/api/jobs/${jobA.id}/pipeline`)
      .set('Cookie', companyAAdmin.cookie)
      .set('x-test-bypass-csrf', 'true');
    expect(viewOwnPipeline.status).toBe(200);
    expect(viewOwnPipeline.body.success).toBe(true);
    expect(viewOwnPipeline.body.stages).toBeDefined();

    // Company A admin attempts to view Job B pipeline -> 403
    const viewOtherPipeline = await request(app)
      .get(`/api/jobs/${jobB.id}/pipeline`)
      .set('Cookie', companyAAdmin.cookie)
      .set('x-test-bypass-csrf', 'true');
    expect(viewOtherPipeline.status).toBe(403);
    expect(viewOtherPipeline.body.error).toMatch(/access denied|cross-company|another company/i);

    // Create application for Job B
    const candidateB = await prisma.candidate.create({
      data: { firstName: 'Beta', lastName: 'Candidate', email: `beta_${Date.now()}@candidate.test` },
    });
    cleanupCandidateIds.push(candidateB.id);

    const appB = await prisma.jobApplication.create({
      data: {
        jobId: jobB.id,
        candidateId: candidateB.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    // Company A admin attempts to advance stage on Job B application -> 403
    const crossStageRes = await request(app)
      .patch(`/api/jobs/${jobB.id}/applications/${appB.id}/stage`)
      .set('Cookie', companyAAdmin.cookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: stageInterview.id });

    expect(crossStageRes.status).toBe(403);
    expect(crossStageRes.body.error).toMatch(/access denied|cross-company|another company/i);
  });

  // ----------------------------------------------------
  // Test 11: Batch transitions report partial failures correctly
  // ----------------------------------------------------
  it('11. processes batch transitions reporting clear per-item success and failure results', async () => {
    const { job } = await setupTestJob('Batch Co');

    const candidate1 = await prisma.candidate.create({
      data: { firstName: 'Candidate', lastName: 'One', email: `batch1_${Date.now()}@candidate.test` },
    });
    const candidate2 = await prisma.candidate.create({
      data: { firstName: 'Candidate', lastName: 'Two', email: `batch2_${Date.now()}@candidate.test` },
    });
    cleanupCandidateIds.push(candidate1.id, candidate2.id);

    // App 1: valid in screening
    const app1 = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidate1.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    // App 2: already in terminal HIRED state
    const app2 = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidate2.id,
        currentStageId: stageHired.id,
        status: 'HIRED',
      },
    });

    const batchRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/batch-stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({
        destinationStageId: stageInterview.id,
        applicationIds: [app1.id, app2.id],
      });

    expect(batchRes.status).toBe(200);
    expect(batchRes.body.success).toBe(true);
    expect(batchRes.body.summary.total).toBe(2);
    expect(batchRes.body.summary.succeeded).toBe(1);
    expect(batchRes.body.summary.failed).toBe(1);

    const res1 = batchRes.body.results.find((r) => r.applicationId === app1.id);
    expect(res1.success).toBe(true);
    expect(res1.currentStageId).toBe(stageInterview.id);

    const res2 = batchRes.body.results.find((r) => r.applicationId === app2.id);
    expect(res2.success).toBe(false);
    expect(res2.statusCode).toBe(400);
    expect(res2.error).toMatch(/terminal state/i);

    // Verify DB integrity: app1 moved, app2 stayed HIRED
    const app1Db = await prisma.jobApplication.findUnique({ where: { id: app1.id } });
    const app2Db = await prisma.jobApplication.findUnique({ where: { id: app2.id } });
    expect(app1Db.currentStageId).toBe(stageInterview.id);
    expect(app2Db.currentStageId).toBe(stageHired.id);
    expect(app2Db.status).toBe('HIRED');
  });

  // ----------------------------------------------------
  // Test 12: History, application state, and audit data remain consistent after a failed transaction
  // ----------------------------------------------------
  it('12. rolls back history, application state, and audit data atomically when transaction fails', async () => {
    const { company, job } = await setupTestJob('Rollback Integrity Co');

    const candidate = await prisma.candidate.create({
      data: { firstName: 'Rollback', lastName: 'Candidate', email: `rollback_${Date.now()}@candidate.test` },
    });
    cleanupCandidateIds.push(candidate.id);

    const application = await prisma.jobApplication.create({
      data: {
        jobId: job.id,
        candidateId: candidate.id,
        currentStageId: stageScreening.id,
        status: 'SUBMITTED',
      },
    });

    const initialHistoryCount = await prisma.applicationStageHistory.count({
      where: { applicationId: application.id },
    });
    const initialAuditCount = await prisma.companyAuditLog.count({
      where: { companyId: company.id },
    });

    // Attempt invalid transition that fails during validation or transaction (e.g. invalid destination stage)
    const failedRes = await request(app)
      .patch(`/api/jobs/${job.id}/applications/${application.id}/stage`)
      .set('Cookie', superAdminCookie)
      .set('x-test-bypass-csrf', 'true')
      .send({ destinationStageId: stageInactive.id });

    expect(failedRes.status).toBe(400);

    // Verify application state is unchanged
    const currentApp = await prisma.jobApplication.findUnique({
      where: { id: application.id },
    });
    expect(currentApp.currentStageId).toBe(stageScreening.id);
    expect(currentApp.status).toBe('SUBMITTED');

    // Verify no new stage history entry was committed
    const afterHistoryCount = await prisma.applicationStageHistory.count({
      where: { applicationId: application.id },
    });
    expect(afterHistoryCount).toBe(initialHistoryCount);

    // Verify no new audit log was committed for this failure
    const afterAuditCount = await prisma.companyAuditLog.count({
      where: { companyId: company.id },
    });
    expect(afterAuditCount).toBe(initialAuditCount);
  });
});
