import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/crypto.js';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { BusinessEventNotificationService } from '../src/modules/notifications/businessEvent.service.js';
import { NotificationService } from '../src/modules/notifications/notification.service.js';
import { ensureSystemRoles } from '../src/modules/teams/roleBootstrap.js';
import { _setFirebaseApp, _resetFirebaseApp } from '../src/lib/firebase.js';
import { CompanyService } from '../src/modules/companies/company.service.js';
import { JobService } from '../src/modules/jobs/job.service.js';
import { CandidateService } from '../src/modules/candidates/candidate.service.js';

const SUPER_ADMIN_EMAIL = 'be_super_admin@recruitrain.test';
const TENANT_A_ADMIN_EMAIL = 'be_tenant_a_admin@recruitrain.test';
const TENANT_B_ADMIN_EMAIL = 'be_tenant_b_admin@recruitrain.test';
const TEST_PASSWORD = 'BESecurePassword123!@#';

describe('RecruTrain Business Event Notification Service & Integration Suite', () => {
  let superAdminId;
  let tenantAAdminId;
  let tenantBAdminId;
  let companyAId;
  let companyBId;
  let teamAId;
  let teamBId;

  beforeAll(async () => {
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    await ensureSystemRoles(prisma);

    // 1. Clean previous test records
    const testEmails = [SUPER_ADMIN_EMAIL, TENANT_A_ADMIN_EMAIL, TENANT_B_ADMIN_EMAIL];
    const existingAdmins = await prisma.admin.findMany({
      where: { email: { in: testEmails } },
      select: { id: true },
    });
    const adminIds = existingAdmins.map((a) => a.id);
    if (adminIds.length > 0) {
      await prisma.teamMember.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminDeviceToken.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminNotification.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    }

    // Clean companies and dependent records
    await prisma.jobApplication.deleteMany({
      where: { job: { company: { companyCode: { in: ['COMP_BE_A', 'COMP_BE_B'] } } } },
    });
    await prisma.job.deleteMany({
      where: { company: { companyCode: { in: ['COMP_BE_A', 'COMP_BE_B'] } } },
    });
    await prisma.subscription.deleteMany({
      where: { company: { companyCode: { in: ['COMP_BE_A', 'COMP_BE_B'] } } },
    });
    await prisma.teamMember.deleteMany({
      where: { team: { company: { companyCode: { in: ['COMP_BE_A', 'COMP_BE_B'] } } } },
    });
    await prisma.team.deleteMany({
      where: { company: { companyCode: { in: ['COMP_BE_A', 'COMP_BE_B'] } } },
    });
    await prisma.company.deleteMany({
      where: { companyCode: { in: ['COMP_BE_A', 'COMP_BE_B'] } },
    });

    // 2. Create test companies
    const companyA = await prisma.company.create({
      data: {
        name: 'Business Events Test Company A',
        companyCode: 'COMP_BE_A',
        status: 'ACTIVE',
      },
    });
    companyAId = companyA.id;

    const companyB = await prisma.company.create({
      data: {
        name: 'Business Events Test Company B',
        companyCode: 'COMP_BE_B',
        status: 'ACTIVE',
      },
    });
    companyBId = companyB.id;

    // Create teams
    const teamA = await prisma.team.create({
      data: {
        name: 'Team Company A',
        companyId: companyAId,
      },
    });
    teamAId = teamA.id;

    const teamB = await prisma.team.create({
      data: {
        name: 'Team Company B',
        companyId: companyBId,
      },
    });
    teamBId = teamB.id;

    const companyAdminRole = await prisma.role.findFirst({
      where: { code: 'COMPANY_ADMIN' },
    });

    const passwordHash = await hashPassword(TEST_PASSWORD);

    // 3. Create Super Admin (platform-wide access)
    const superAdmin = await prisma.admin.create({
      data: {
        email: SUPER_ADMIN_EMAIL,
        name: 'Business Events Super Admin',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
      },
    });
    superAdminId = superAdmin.id;

    // 4. Create Tenant Admin A (tied to Company A via team membership)
    const tenantAAdmin = await prisma.admin.create({
      data: {
        email: TENANT_A_ADMIN_EMAIL,
        name: 'Tenant A Administrator',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    tenantAAdminId = tenantAAdmin.id;
    await prisma.teamMember.create({
      data: {
        adminId: tenantAAdminId,
        teamId: teamAId,
        roleId: companyAdminRole.id,
      },
    });

    // 5. Create Tenant Admin B (tied to Company B via team membership)
    const tenantBAdmin = await prisma.admin.create({
      data: {
        email: TENANT_B_ADMIN_EMAIL,
        name: 'Tenant B Administrator',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    tenantBAdminId = tenantBAdmin.id;
    await prisma.teamMember.create({
      data: {
        adminId: tenantBAdminId,
        teamId: teamBId,
        roleId: companyAdminRole.id,
      },
    });
  });

  afterAll(async () => {
    _resetFirebaseApp();

    const testEmails = [SUPER_ADMIN_EMAIL, TENANT_A_ADMIN_EMAIL, TENANT_B_ADMIN_EMAIL];
    const existingAdmins = await prisma.admin.findMany({
      where: { email: { in: testEmails } },
      select: { id: true },
    });
    const adminIds = existingAdmins.map((a) => a.id);
    if (adminIds.length > 0) {
      await prisma.teamMember.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminDeviceToken.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminNotification.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    }

    if (teamAId || teamBId) {
      await prisma.team.deleteMany({
        where: { id: { in: [teamAId, teamBId].filter(Boolean) } },
      });
    }

    await prisma.subscription.deleteMany({
      where: { company: { companyCode: { in: ['COMP_BE_A', 'COMP_BE_B'] } } },
    });

    await prisma.company.deleteMany({
      where: { companyCode: { in: ['COMP_BE_A', 'COMP_BE_B'] } },
    });
  });

  beforeEach(() => {
    _resetFirebaseApp();
  });

  // =========================================================================
  // 1. Centralized Dispatcher, Idempotency & Tenant Isolation
  // =========================================================================
  describe('Centralized Dispatcher & Tenant Isolation', () => {
    it('resolves eligible admins correctly respecting tenant isolation', async () => {
      // Company A event should include superAdmin and tenantAAdmin, but NOT tenantBAdmin
      const adminsForA = await BusinessEventNotificationService.resolveEligibleAdmins({
        module: 'COMPANIES',
        action: 'READ',
        companyId: companyAId,
      });

      expect(adminsForA).toContain(superAdminId);
      expect(adminsForA).toContain(tenantAAdminId);
      expect(adminsForA).not.toContain(tenantBAdminId);
    });

    it('enforces idempotency using stable eventId across duplicate dispatches', async () => {
      const stableEventId = `TEST_IDEMPOTENCY_${Date.now()}`;

      // Dispatch 1
      const res1 = await BusinessEventNotificationService.emitEvent({
        eventId: stableEventId,
        eventType: 'TEST_IDEMPOTENT_EVENT',
        category: 'SYSTEM',
        title: 'RecruTrain — Idempotency Test',
        body: 'Testing event deduplication',
        deepLink: '/dashboard',
        explicitAdminIds: [superAdminId],
      });

      expect(res1.deliveredCount).toBe(1);

      // Verify row exists in DB
      const notifs1 = await prisma.adminNotification.findMany({
        where: { adminId: superAdminId, title: 'RecruTrain — Idempotency Test' },
      });
      expect(notifs1.length).toBe(1);

      // Dispatch 2 (with same eventId)
      const res2 = await BusinessEventNotificationService.emitEvent({
        eventId: stableEventId,
        eventType: 'TEST_IDEMPOTENT_EVENT',
        category: 'SYSTEM',
        title: 'RecruTrain — Idempotency Test',
        body: 'Testing event deduplication duplicate call',
        deepLink: '/dashboard',
        explicitAdminIds: [superAdminId],
      });

      expect(res2.deliveredCount).toBe(0);

      // Verify no second notification was created
      const notifs2 = await prisma.adminNotification.findMany({
        where: { adminId: superAdminId, title: 'RecruTrain — Idempotency Test' },
      });
      expect(notifs2.length).toBe(1);
    });

    it('remains resilient when Firebase push throws an error (never crashes business event)', async () => {
      // Mock Firebase messaging to reject
      const mockFailingApp = {
        options: { credential: {} },
      };
      _setFirebaseApp(mockFailingApp);

      // Spy on NotificationService.createNotification to verify graceful degradation
      const notifSpy = vi.spyOn(NotificationService, 'createNotification');

      const outcome = await BusinessEventNotificationService.emitEvent({
        eventId: `FIREBASE_FAIL_TEST_${Date.now()}`,
        eventType: 'TEST_FAIL_RESILIENCE',
        category: 'SYSTEM',
        title: 'RecruTrain — Push Failure Resilience',
        body: 'In-app notification should persist even if push fails',
        deepLink: '/system',
        explicitAdminIds: [superAdminId],
      });

      expect(outcome.deliveredCount).toBe(1);

      const saved = await prisma.adminNotification.findFirst({
        where: { adminId: superAdminId, title: 'RecruTrain — Push Failure Resilience' },
      });
      expect(saved).not.toBeNull();
      expect(saved.category).toBe('SYSTEM');

      notifSpy.mockRestore();
    });
  });

  // =========================================================================
  // 2. Companies & Employer Management Notifications
  // =========================================================================
  describe('Company & Employer Business Events', () => {
    it('notifies on company creation with proper RecruTrain branding and deepLink', async () => {
      await BusinessEventNotificationService.notifyCompanyCreated({
        company: { id: companyAId, name: 'Acme Test Corp' },
        actorAdminId: superAdminId,
      });

      const notif = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — New Company Created',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(notif).not.toBeNull();
      expect(notif.body).toContain('Acme Test Corp');
      expect(notif.deepLinkUrl).toBe(`/companies/${companyAId}`);
      expect(notif.category).toBe('SYSTEM');
    });

    it('notifies on company status change (APPROVED, SUSPENDED, ACTIVATED)', async () => {
      await BusinessEventNotificationService.notifyCompanyStatusChanged({
        company: { id: companyAId, name: 'Acme Test Corp' },
        previousStatus: 'PENDING_APPROVAL',
        newStatus: 'ACTIVE',
        reason: 'Documents verified',
      });

      const notif = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Company Approved',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(notif).not.toBeNull();
      expect(notif.body).toContain('has been approved');
      expect(notif.deepLinkUrl).toBe(`/companies/${companyAId}`);
    });

    it('notifies on company restoration from trash', async () => {
      await BusinessEventNotificationService.notifyCompanyRestored({
        company: { id: companyAId, name: 'Acme Test Corp' },
      });

      const notif = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Company Restored',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(notif).not.toBeNull();
      expect(notif.body).toContain('restored from trash');
    });

    it('notifies on company invitation accepted', async () => {
      await BusinessEventNotificationService.notifyCompanyInvitationAccepted({
        company: { id: companyAId, name: 'Acme Test Corp' },
        user: { name: 'Alice HR', email: 'alice@acme.test' },
      });

      const notif = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Invitation Accepted',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(notif).not.toBeNull();
      expect(notif.body).toContain('Alice HR (alice@acme.test)');
    });
  });

  // =========================================================================
  // 3. Jobs Management Notifications
  // =========================================================================
  describe('Job Business Events', () => {
    it('notifies on job draft creation and publication', async () => {
      const jobId = 'test-job-uuid-1';

      // 1. Job created (draft)
      await BusinessEventNotificationService.notifyJobCreated({
        job: { id: jobId, title: 'Senior Cloud Engineer', companyId: companyAId },
        company: { id: companyAId, name: 'Acme Test Corp' },
      });

      const notifDraft = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Job Draft Created',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifDraft).not.toBeNull();
      expect(notifDraft.body).toContain('Senior Cloud Engineer');

      // 2. Job published
      await BusinessEventNotificationService.notifyJobPublished({
        job: { id: jobId, title: 'Senior Cloud Engineer', companyId: companyAId },
        company: { id: companyAId, name: 'Acme Test Corp' },
      });

      const notifPub = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Job Published',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifPub).not.toBeNull();
      expect(notifPub.deepLinkUrl).toBe(`/jobs/${jobId}`);
    });

    it('notifies on job auto-closure or status change', async () => {
      const jobId = 'test-job-uuid-2';

      await BusinessEventNotificationService.notifyJobStatusChanged({
        job: { id: jobId, title: 'DevOps Architect', companyId: companyAId },
        previousStatus: 'ACTIVE',
        newStatus: 'CLOSED',
        reason: 'Applicant limit reached',
      });

      const notif = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Job Closed',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(notif).not.toBeNull();
      expect(notif.body).toContain('Applicant limit reached');
      expect(notif.deepLinkUrl).toBe(`/jobs/${jobId}`);
    });
  });

  // =========================================================================
  // 4. Candidate & Application Notifications
  // =========================================================================
  describe('Candidate & Application Business Events', () => {
    it('notifies when a candidate self-registers', async () => {
      const candId = 'cand-self-uuid-1';
      await BusinessEventNotificationService.notifyCandidateRegistered({
        candidate: {
          id: candId,
          fullName: 'Jane Doe',
          email: 'jane.doe@example.com',
        },
      });

      const notif = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — New Candidate Registered',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(notif).not.toBeNull();
      expect(notif.category).toBe('CANDIDATE');
      expect(notif.body).toContain('Jane Doe (jane.doe@example.com)');
      expect(notif.deepLinkUrl).toBe(`/candidates/${candId}`);
    });

    it('notifies when an application is submitted for a job', async () => {
      const appId = 'app-uuid-1';
      const jobId = 'job-uuid-app';

      await BusinessEventNotificationService.notifyApplicationReceived({
        application: { id: appId, jobId, companyId: companyAId },
        job: { id: jobId, title: 'Full Stack Engineer', companyId: companyAId },
        candidateName: 'Jane Doe',
      });

      const notif = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — New Application Received',
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(notif).not.toBeNull();
      expect(notif.category).toBe('APPLICATION');
      expect(notif.body).toContain('Jane Doe applied for "Full Stack Engineer"');
      expect(notif.deepLinkUrl).toBe(`/jobs/${jobId}/pipeline`);
    });
  });

  // =========================================================================
  // 5. Hiring Pipeline Notifications (Single & Bulk Summary)
  // =========================================================================
  describe('Hiring Pipeline Business Events', () => {
    it('notifies on individual pipeline stage advancement or rejection', async () => {
      const appId = 'app-stage-uuid';
      const jobId = 'job-stage-uuid';

      // 1. Stage advanced
      await BusinessEventNotificationService.notifyPipelineStageChanged({
        application: { id: appId, jobId, companyId: companyAId },
        job: { id: jobId, title: 'React Developer', companyId: companyAId },
        candidateName: 'John Smith',
        previousStageName: 'Screening',
        newStageName: 'Technical Interview',
        newStageCategory: 'INTERVIEW',
      });

      const notifAdvance = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Candidate Moved to Technical Interview',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifAdvance).not.toBeNull();
      expect(notifAdvance.category).toBe('APPLICATION');

      // 2. Candidate Hired
      await BusinessEventNotificationService.notifyPipelineStageChanged({
        application: { id: appId, jobId, companyId: companyAId },
        job: { id: jobId, title: 'React Developer', companyId: companyAId },
        candidateName: 'John Smith',
        previousStageName: 'Final Interview',
        newStageName: 'Hired',
        newStageCategory: 'HIRED',
      });

      const notifHired = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Candidate Hired: John Smith',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifHired).not.toBeNull();
    });

    it('emits a single summary notification for bulk pipeline moves, never N rows', async () => {
      const jobId = 'job-bulk-uuid';

      // Notify bulk transition of 5 applicants
      await BusinessEventNotificationService.notifyBulkPipelineStagesChanged({
        job: { id: jobId, title: 'Backend Architect', companyId: companyAId },
        count: 5,
        newStageName: 'Screening',
      });

      const notifs = await prisma.adminNotification.findMany({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — 5 Candidates Moved to Screening',
        },
      });

      expect(notifs.length).toBe(1);
      expect(notifs[0].body).toContain('5 candidates were moved to "Screening"');
      expect(notifs[0].deepLinkUrl).toBe(`/jobs/${jobId}/pipeline`);
    });
  });

  // =========================================================================
  // 6. Subscriptions & Billing Notifications
  // =========================================================================
  describe('Billing & Subscription Business Events', () => {
    it('notifies on subscription creation, update, and cancellation', async () => {
      const subId = 'sub-test-uuid';

      // 1. Created
      await BusinessEventNotificationService.notifySubscriptionCreated({
        subscription: { id: subId, companyId: companyAId },
        company: { id: companyAId, name: 'Acme Test Corp' },
        plan: { name: 'Enterprise Plan' },
      });

      const notifCreated = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — New Subscription Activated',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifCreated).not.toBeNull();
      expect(notifCreated.category).toBe('BILLING');
      expect(notifCreated.body).toContain('Enterprise Plan');

      // 2. Updated / Upgraded
      await BusinessEventNotificationService.notifySubscriptionUpdated({
        subscription: { id: subId, companyId: companyAId },
        company: { id: companyAId, name: 'Acme Test Corp' },
        previousPlanName: 'Starter Plan',
        newPlanName: 'Enterprise Plan',
      });

      const notifUpdated = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Subscription Updated',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifUpdated).not.toBeNull();
      expect(notifUpdated.body).toContain('Starter Plan to Enterprise Plan');

      // 3. Cancelled
      await BusinessEventNotificationService.notifySubscriptionCancelled({
        subscription: { id: subId, companyId: companyAId },
        company: { id: companyAId, name: 'Acme Test Corp' },
        reason: 'Customer requested cancellation',
      });

      const notifCancelled = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Subscription Cancelled',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifCancelled).not.toBeNull();
      expect(notifCancelled.body).toContain('Customer requested cancellation');
    });

    it('notifies on payment success, payment failure, and refunds', async () => {
      const paymentId = 'pay-uuid-test';

      // 1. Payment Success
      await BusinessEventNotificationService.notifyPaymentSucceeded({
        payment: { id: paymentId, amount: 299.0, currency: 'EUR' },
        company: { id: companyAId, name: 'Acme Test Corp' },
        invoiceNumber: 'INV-2026-0001',
      });

      const notifSuccess = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Payment Received: INV-2026-0001',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifSuccess).not.toBeNull();
      expect(notifSuccess.body).toContain('299.00 EUR');

      // 2. Payment Failed
      await BusinessEventNotificationService.notifyPaymentFailed({
        company: { id: companyAId, name: 'Acme Test Corp' },
        invoiceId: 'inv-fail-uuid',
        amount: 299.0,
        currency: 'EUR',
        reason: 'Insufficient funds on credit card',
      });

      const notifFailed = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Payment Failed',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifFailed).not.toBeNull();
      expect(notifFailed.body).toContain('Insufficient funds');

      // 3. Refund Completed
      await BusinessEventNotificationService.notifyRefundCompleted({
        payment: { id: paymentId },
        company: { id: companyAId, name: 'Acme Test Corp' },
        amount: 50.0,
        currency: 'EUR',
      });

      const notifRefund = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Refund Processed',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifRefund).not.toBeNull();
      expect(notifRefund.body).toContain('50.00 EUR');
    });
  });

  // =========================================================================
  // 7. Security & Administration Notifications
  // =========================================================================
  describe('Security & Admin Business Events', () => {
    it('notifies on role permission changes and account lockout', async () => {
      // 1. Role updated
      await BusinessEventNotificationService.notifyRoleUpdated({
        role: { id: 'role-1', name: 'Recruiter' },
        actorName: 'Super Administrator',
        changesSummary: '5 permission(s) adjusted',
      });

      const notifRole = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Security: Role "Recruiter" Updated',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifRole).not.toBeNull();
      expect(notifRole.category).toBe('SECURITY');
      expect(notifRole.body).toContain('5 permission(s) adjusted');

      // 2. Account locked
      await BusinessEventNotificationService.notifyAccountLocked({
        admin: { id: tenantAAdminId, email: TENANT_A_ADMIN_EMAIL, name: 'Tenant A Administrator' },
        failedAttempts: 5,
        lockoutMinutes: 15,
      });

      const notifLocked = await prisma.adminNotification.findFirst({
        where: {
          adminId: superAdminId,
          title: 'RecruTrain — Security Alert: Account Locked',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(notifLocked).not.toBeNull();
      expect(notifLocked.category).toBe('SECURITY');
      expect(notifLocked.body).toContain(TENANT_A_ADMIN_EMAIL);
      expect(notifLocked.body).toContain('15 minutes');
    });
  });

  // =========================================================================
  // 8. End-to-End Real Business Service Notification Integration
  // =========================================================================
  describe('8. End-to-End Real Business Service Notification Integration', () => {
    let mockMulticastSpy;
    const cleanE2ECompanyIds = [];
    const cleanE2EJobIds = [];
    const cleanE2ECandidateIds = [];

    async function waitForNotification(where, maxRetries = 30, delayMs = 100) {
      for (let i = 0; i < maxRetries; i++) {
        const notif = await prisma.adminNotification.findFirst({
          where,
          orderBy: { createdAt: 'desc' },
        });
        if (notif) return notif;
        await new Promise((r) => setTimeout(r, delayMs));
      }
      return null;
    }

    beforeAll(async () => {
      // Register a mock device token for superAdminId to verify FCM push delivery invocation
      await prisma.adminDeviceToken.upsert({
        where: { id: `token_super_admin_e2e_${superAdminId}` },
        update: { token: 'mock_super_admin_fcm_token_e2e', adminId: superAdminId },
        create: {
          id: `token_super_admin_e2e_${superAdminId}`,
          token: 'mock_super_admin_fcm_token_e2e',
          adminId: superAdminId,
          userAgent: 'Vitest End-to-End Agent',
        },
      });

      // Ensure platform setting allows auto job approval
      await prisma.platformSetting.upsert({
        where: { id: 'global' },
        update: { autoApproveJobs: true },
        create: { id: 'global', autoApproveJobs: true },
      });
    });

    beforeEach(() => {
      mockMulticastSpy = vi.fn().mockResolvedValue({
        responses: [{ success: true, messageId: 'projects/test/messages/msg-e2e-1' }],
        successCount: 1,
        failureCount: 0,
      });

      const mockApp = {
        options: { credential: {} },
        messaging: () => ({
          sendEachForMulticast: mockMulticastSpy,
        }),
      };
      _setFirebaseApp(mockApp);
    });

    afterAll(async () => {
      _resetFirebaseApp();

      if (cleanE2EJobIds.length > 0) {
        await prisma.jobApplication.deleteMany({ where: { jobId: { in: cleanE2EJobIds } } });
        await prisma.job.deleteMany({ where: { id: { in: cleanE2EJobIds } } });
      }
      if (cleanE2ECandidateIds.length > 0) {
        await prisma.candidate.deleteMany({ where: { id: { in: cleanE2ECandidateIds } } });
      }
      if (cleanE2ECompanyIds.length > 0) {
        await prisma.subscription.deleteMany({ where: { companyId: { in: cleanE2ECompanyIds } } });
        await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: cleanE2ECompanyIds } } });
        await prisma.company.deleteMany({ where: { id: { in: cleanE2ECompanyIds } } });
      }

      await prisma.adminDeviceToken.deleteMany({
        where: { id: `token_super_admin_e2e_${superAdminId}` },
      });
    });

    it('CompanyService.createCompany triggers in-app notification and FCM push', async () => {
      const companyRes = await CompanyService.createCompany(
        {
          name: 'Real E2E Logistics GmbH',
          legalName: 'Real E2E Logistics GmbH',
          companyCode: 'E2E_LOG_01',
          email: 'contact@e2e-logistics.test',
          country: 'Germany',
          city: 'Hamburg',
          hiringDomestic: true,
          hiringEu: true,
        },
        { id: superAdminId, email: SUPER_ADMIN_EMAIL, role: 'SUPER_ADMIN' }
      );

      cleanE2ECompanyIds.push(companyRes.company.id);

      // Verify DB persistence of AdminNotification
      const notif = await waitForNotification({
        adminId: superAdminId,
        metadata: { path: ['companyId'], equals: companyRes.company.id },
      });

      expect(notif).not.toBeNull();
      expect(notif.body).toContain('Real E2E Logistics GmbH');
      expect(notif.deepLinkUrl).toBe(`/companies/${companyRes.company.id}`);

      // Verify FCM push dispatch was called
      expect(mockMulticastSpy).toHaveBeenCalled();
      const pushCall = mockMulticastSpy.mock.calls[0][0];
      expect(pushCall.tokens).toContain('mock_super_admin_fcm_token_e2e');
      expect(pushCall.notification.title).toBe('RecruTrain — New Company Created');
    });

    it('JobService.createJob (DRAFT) and updateJob (PUBLISHED) trigger distinct business notifications and push', async () => {
      // 1. Create a plan and subscription for companyAId to satisfy entitlement check on publish
      let plan = await prisma.plan.findFirst();
      if (!plan) {
        plan = await prisma.plan.create({
          data: {
            name: 'Standard Job Plan',
            price: 100,
            billingInterval: 'MONTHLY',
            jobPostingLimit: 5,
            candidateAccessLimit: 50,
            teamMemberLimit: 5,
          },
        });
      }
      await prisma.subscription.upsert({
        where: { id: `sub_e2e_co_${companyAId}` },
        update: { status: 'ACTIVE', jobPostingLimit: 10 },
        create: {
          id: `sub_e2e_co_${companyAId}`,
          companyId: companyAId,
          planId: plan.id,
          status: 'ACTIVE',
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          billingInterval: 'MONTHLY',
          price: 100.0,
          jobPostingLimit: 10,
        },
      });

      // 2. Create Job in DRAFT status
      const draftJob = await JobService.createJob(
        {
          companyId: companyAId,
          title: 'Senior Cloud Architect E2E',
          description: 'Design and deploy scalable cloud infrastructure.',
          hiringScope: 'DOMESTIC',
          workArrangement: 'REMOTE',
          status: 'DRAFT',
        },
        { id: superAdminId, adminId: superAdminId, role: 'SUPER_ADMIN' }
      );

      cleanE2EJobIds.push(draftJob.id);

      const draftNotif = await waitForNotification({
        adminId: superAdminId,
        metadata: { path: ['jobId'], equals: draftJob.id },
      });
      expect(draftNotif).not.toBeNull();
      expect(draftNotif.body).toContain('Senior Cloud Architect E2E');
      expect(draftNotif.deepLinkUrl).toBe(`/jobs/${draftJob.id}`);

      // 3. Update Job from DRAFT to PUBLISHED (reproducing the exact flow of JobCreateEditPage)
      mockMulticastSpy.mockClear();

      const publishedJob = await JobService.updateJob(
        draftJob.id,
        {
          status: 'PUBLISHED',
          title: 'Senior Cloud Architect E2E (Published)',
        },
        { id: superAdminId, adminId: superAdminId, role: 'SUPER_ADMIN' }
      );

      expect(publishedJob.status).toBe('PUBLISHED');

      const publishNotif = await waitForNotification({
        adminId: superAdminId,
        title: 'RecruTrain — Job Published',
        metadata: { path: ['jobId'], equals: draftJob.id },
      });
      expect(publishNotif).not.toBeNull();
      expect(publishNotif.body).toContain('Senior Cloud Architect E2E (Published)');
      expect(publishNotif.deepLinkUrl).toBe(`/jobs/${draftJob.id}`);

      // Verify FCM push dispatch for job published
      expect(mockMulticastSpy).toHaveBeenCalled();
      const pushCall = mockMulticastSpy.mock.calls[0][0];
      expect(pushCall.notification.title).toBe('RecruTrain — Job Published');
    });

    it('CandidateService creates candidate and updates status with notifications and push', async () => {
      // 1. Create candidate by admin with valid mock PDF resume
      mockMulticastSpy.mockClear();

      const mockPdfBuffer = Buffer.from('%PDF-1.4 mock resume content with valid header\n%%EOF');
      const mockFile = {
        buffer: mockPdfBuffer,
        originalname: 'e2e_resume.pdf',
        mimetype: 'application/pdf',
        size: mockPdfBuffer.length,
      };

      const candidateRes = await CandidateService.createCandidateByAdminOrEmployer(
        {
          email: 'e2e_developer_candidate@recruitrain.test',
          firstName: 'Robert',
          lastName: 'Martin',
          country: 'Germany',
          city: 'Munich',
          sendInvitation: false,
        },
        { id: superAdminId, adminId: superAdminId, role: 'SUPER_ADMIN' },
        mockFile
      );

      cleanE2ECandidateIds.push(candidateRes.candidate.id);

      const createNotif = await waitForNotification({
        adminId: superAdminId,
        metadata: { path: ['candidateId'], equals: candidateRes.candidate.id },
      });
      expect(createNotif).not.toBeNull();
      expect(createNotif.body).toContain('Robert Martin');
      expect(createNotif.deepLinkUrl).toBe(`/candidates/${candidateRes.candidate.id}`);

      expect(mockMulticastSpy).toHaveBeenCalled();

      // 2. Update candidate status
      mockMulticastSpy.mockClear();

      await CandidateService.updateCandidateStatus(
        candidateRes.candidate.id,
        'ACTIVE',
        superAdminId
      );

      const statusNotif = await waitForNotification({
        adminId: superAdminId,
        title: 'RecruTrain — Candidate Status Updated',
        metadata: { path: ['candidateId'], equals: candidateRes.candidate.id },
      });
      expect(statusNotif).not.toBeNull();
      expect(statusNotif.body).toContain('ACTIVE');
      expect(statusNotif.deepLinkUrl).toBe(`/candidates/${candidateRes.candidate.id}`);

      expect(mockMulticastSpy).toHaveBeenCalled();
    });
  });
});
