import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { TeamService } from '../src/modules/teams/team.service.js';
import { stripeService } from '../src/modules/billing/stripe.service.js';

const TEST_ADMIN_EMAIL = 'billing_corrections_admin@recruitrain.test';
const TEST_ADMIN_PASSWORD = 'CorrectionsPassword123!@#';

describe('RecruiTrain Phase 2 Billing Corrections Integration Suite', () => {
  let app;
  let testAdminId;
  let authCookie;
  let totpSecret;

  const createdCompanyIds = [];
  const createdPlanIds = [];
  const createdSubscriptionIds = [];
  const createdInvoiceIds = [];
  const createdJobIds = [];
  const createdCompanyUserIds = [];

  beforeAll(async () => {
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Clean prior test admin
    const existing = await prisma.admin.findUnique({
      where: { email: TEST_ADMIN_EMAIL },
      select: { id: true },
    });
    if (existing) {
      await prisma.billingAuditLog.deleteMany({ where: { adminId: existing.id } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: existing.id } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: existing.id } });
      await prisma.admin.delete({ where: { id: existing.id } });
    }

    const passwordHash = await hashPassword(TEST_ADMIN_PASSWORD);
    const totpGen = generateTotpSecret(TEST_ADMIN_EMAIL);
    totpSecret = totpGen.secret;
    const encryptedSecret = encryptTotpSecret(totpSecret);

    const admin = await prisma.admin.create({
      data: {
        email: TEST_ADMIN_EMAIL,
        name: 'Billing Corrections Admin',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptedSecret,
      },
    });
    testAdminId = admin.id;

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });

    const code = authenticator.generate(totpSecret);
    const verifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', loginRes.headers['set-cookie'])
      .send({ adminId: testAdminId, code });

    authCookie = verifyRes.headers['set-cookie'];
  });

  afterAll(async () => {
    // Teardown created test entities in reverse dependency order
    if (createdJobIds.length > 0) {
      await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } });
    }
    if (createdCompanyUserIds.length > 0) {
      await prisma.companyInvitation.deleteMany({ where: { userId: { in: createdCompanyUserIds } } });
      await prisma.companyUser.deleteMany({ where: { id: { in: createdCompanyUserIds } } });
    }
    if (createdCompanyIds.length > 0) {
      await prisma.payment.deleteMany({ where: { invoice: { companyId: { in: createdCompanyIds } } } });
      await prisma.invoice.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.candidateAccessLog.deleteMany({ where: { subscription: { companyId: { in: createdCompanyIds } } } });
      await prisma.subscription.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
    }
    if (createdPlanIds.length > 0) {
      await prisma.plan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    if (createdCompanyIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
    }
    if (testAdminId) {
      await prisma.billingAuditLog.deleteMany({ where: { adminId: testAdminId } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: testAdminId } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: testAdminId } });
      await prisma.admin.delete({ where: { id: testAdminId } });
    }
  });

  describe('1. Subscription Quota Entitlement Snapshots & Plan Decoupling', () => {
    it('snapshots quotas on assignment and retains them when plan is updated', async () => {
      // 1. Create a company
      const company = await prisma.company.create({
        data: {
          name: 'Snapshot Test Corp',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(company.id);

      // 2. Create a plan with candidateAccessLimit: 100, jobPostingLimit: 5, teamMemberLimit: 3
      const planRes = await request(app)
        .post('/api/billing/plans')
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          name: `Snapshot Plan ${Date.now()}`,
          description: 'Initial plan quotas',
          price: 99.00,
          currency: 'EUR',
          billingInterval: 'MONTHLY',
          candidateAccessLimit: 100,
          jobPostingLimit: 5,
          teamMemberLimit: 3,
        });
      expect(planRes.status).toBe(201);
      const plan = planRes.body.data;
      createdPlanIds.push(plan.id);

      // 3. Assign plan to company
      const subRes = await request(app)
        .post('/api/billing/subscriptions')
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          companyId: company.id,
          planId: plan.id,
          status: 'ACTIVE',
        });
      expect(subRes.status).toBe(201);
      const subscription = subRes.body.data;
      createdSubscriptionIds.push(subscription.id);

      // Verify initial snapshot matches plan
      expect(subscription.jobPostingLimit).toBe(5);
      expect(subscription.teamMemberLimit).toBe(3);
      expect(subscription.candidateAccessLimit).toBe(100);

      // 4. Update the plan to jobPostingLimit: 4, teamMemberLimit: 2, candidateAccessLimit: 80
      const updatePlanRes = await request(app)
        .patch(`/api/billing/plans/${plan.id}`)
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          jobPostingLimit: 4,
          teamMemberLimit: 2,
          candidateAccessLimit: 80,
        });
      expect(updatePlanRes.status).toBe(200);

      // 5. Verify the subscription still retains its original snapshot
      const getSubRes = await request(app)
        .get(`/api/billing/subscriptions/${subscription.id}`)
        .set('Cookie', authCookie);
      expect(getSubRes.status).toBe(200);
      expect(getSubRes.body.data.jobPostingLimit).toBe(5);
      expect(getSubRes.body.data.teamMemberLimit).toBe(3);
      expect(getSubRes.body.data.candidateAccessLimit).toBe(100);
      expect(getSubRes.body.data.plan.jobPostingLimit).toBe(4);
    });
  });

  describe('2. Apply Plan Quotas Endpoint & Confirmation Guard', () => {
    it('applies plan quotas when usage is within new limits, or requires confirmation if usage exceeds', async () => {
      // Create company, plan, subscription
      const company = await prisma.company.create({
        data: {
          name: 'Quota Guard Corp',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(company.id);

      const plan = await prisma.plan.create({
        data: {
          name: `Guard Plan ${Date.now()}`,
          price: 50.0,
          currency: 'EUR',
          billingInterval: 'MONTHLY',
          candidateAccessLimit: 50,
          jobPostingLimit: 3,
          teamMemberLimit: 5,
        },
      });
      createdPlanIds.push(plan.id);

      const subscription = await prisma.subscription.create({
        data: {
          companyId: company.id,
          planId: plan.id,
          status: 'ACTIVE',
          price: 50.0,
          currency: 'EUR',
          billingInterval: 'MONTHLY',
          candidateAccessLimit: 50,
          jobPostingLimit: 3,
          teamMemberLimit: 5,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      createdSubscriptionIds.push(subscription.id);

      // Create 2 published jobs for this company (within quota of 3)
      for (let i = 1; i <= 2; i++) {
        const job = await prisma.job.create({
          data: {
            companyId: company.id,
            title: `Job ${i} - ${Date.now()}`,
            description: 'Job description for testing quotas',
            status: 'PUBLISHED',
          },
        });
        createdJobIds.push(job.id);
      }

      // Reduce plan limit to 1 (which is below current usage of 2 jobs)
      await prisma.plan.update({
        where: { id: plan.id },
        data: { jobPostingLimit: 1 },
      });

      // Attempt to apply plan quotas without confirmBelowUsage -> expect 409
      const attemptRes = await request(app)
        .post(`/api/billing/subscriptions/${subscription.id}/apply-plan-quotas`)
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({});

      expect(attemptRes.status).toBe(409);
      expect(attemptRes.body.code).toBe('CONFIRMATION_REQUIRED_BELOW_USAGE');
      expect(attemptRes.body.details.jobPosting.exceeds).toBe(true);
      expect(attemptRes.body.details.jobPosting.currentUsage).toBe(2);
      expect(attemptRes.body.details.jobPosting.newLimit).toBe(1);

      // Verify the subscription snapshot was NOT altered
      let subInDb = await prisma.subscription.findUnique({ where: { id: subscription.id } });
      expect(subInDb.jobPostingLimit).toBe(3);

      // Apply with confirmBelowUsage: true -> expect 200
      const confirmRes = await request(app)
        .post(`/api/billing/subscriptions/${subscription.id}/apply-plan-quotas`)
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({ confirmBelowUsage: true });

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.success).toBe(true);
      expect(confirmRes.body.data.jobPostingLimit).toBe(1);

      // Verify existing jobs were PRESERVED and not deleted or unpublished
      const jobsInDb = await prisma.job.findMany({
        where: { id: { in: createdJobIds } },
      });
      expect(jobsInDb.length).toBe(2);
      expect(jobsInDb.every((j) => j.status === 'PUBLISHED')).toBe(true);

      // Verify audit log recorded
      const auditLog = await prisma.billingAuditLog.findFirst({
        where: {
          action: 'SUBSCRIPTION_QUOTAS_APPLIED',
          entityId: subscription.id,
        },
      });
      expect(auditLog).toBeDefined();
    });
  });

  describe('3. Team Member Quota Enforcement', () => {
    it('blocks adding team members when effective subscription quota is reached', async () => {
      const company = await prisma.company.create({
        data: {
          name: 'Team Quota Corp',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(company.id);

      const plan = await prisma.plan.create({
        data: {
          name: `Team Limit Plan ${Date.now()}`,
          price: 40.0,
          currency: 'EUR',
          billingInterval: 'MONTHLY',
          candidateAccessLimit: 10,
          jobPostingLimit: 10,
          teamMemberLimit: 1, // Only 1 member allowed
        },
      });
      createdPlanIds.push(plan.id);

      const subscription = await prisma.subscription.create({
        data: {
          companyId: company.id,
          planId: plan.id,
          status: 'ACTIVE',
          price: 40.0,
          currency: 'EUR',
          billingInterval: 'MONTHLY',
          candidateAccessLimit: 10,
          jobPostingLimit: 10,
          teamMemberLimit: 1,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      createdSubscriptionIds.push(subscription.id);

      // Create 1 active company user (reaching the limit of 1)
      const user1 = await prisma.companyUser.create({
        data: {
          companyId: company.id,
          email: `user1_${Date.now()}@testcorp.test`,
          firstName: 'User',
          lastName: 'One',
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });
      createdCompanyUserIds.push(user1.id);

      // Attempting to invite a 2nd member should fail with quota exceeded
      await expect(
        TeamService.inviteMember(
          {
            companyId: company.id,
            email: `user2_${Date.now()}@testcorp.test`,
            firstName: 'User',
            lastName: 'Two',
            role: 'MEMBER',
          },
          { id: testAdminId, role: 'SUPER_ADMIN' }
        )
      ).rejects.toThrow(/Team member quota/i);
    });
  });

  describe('4. Invoice Stripe Checkout & Manual Payment Rejection', () => {
    it('rejects manual payment recording with paymentMethod: stripe', async () => {
      const company = await prisma.company.create({
        data: {
          name: 'Payment Test Corp',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(company.id);

      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: `INV-${Date.now()}`,
          companyId: company.id,
          status: 'OPEN',
          currency: 'EUR',
          netAmount: 100.0,
          taxRate: 0.19,
          taxAmount: 19.0,
          grossTotal: 119.0,
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
      createdInvoiceIds.push(invoice.id);

      // Attempt to record payment with 'stripe' as manual paymentMethod
      const res = await request(app)
        .post(`/api/billing/invoices/${invoice.id}/payments`)
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          amount: 119.0,
          paymentMethod: 'stripe',
          notes: 'Attempting fake stripe manual payment',
        });

      // Must be rejected with 400 validation error
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      // Legitimate manual payment succeeds
      const manualRes = await request(app)
        .post(`/api/billing/invoices/${invoice.id}/payments`)
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          amount: 119.0,
          paymentMethod: 'manual_bank_transfer',
          notes: 'Legitimate manual bank transfer',
        });

      expect(manualRes.status).toBe(201);
      expect(manualRes.body.success).toBe(true);
      expect(manualRes.body.data.paymentMethod).toBe('manual_bank_transfer');
    });

    it('creates a Stripe invoice checkout session and confirms payment idempotently', async () => {
      const company = await prisma.company.create({
        data: {
          name: 'Stripe Checkout Corp',
          country: 'DE',
          status: 'ACTIVE',
        },
      });
      createdCompanyIds.push(company.id);

      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: `INV-STRIPE-${Date.now()}`,
          companyId: company.id,
          status: 'OPEN',
          currency: 'EUR',
          netAmount: 200.0,
          taxRate: 0.19,
          taxAmount: 38.0,
          grossTotal: 238.0,
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
      createdInvoiceIds.push(invoice.id);

      // 1. Create checkout session via endpoint
      const checkoutRes = await request(app)
        .post(`/api/billing/invoices/${invoice.id}/stripe-checkout`)
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          successUrl: 'http://localhost:5173/admin/billing/invoices?session_id={CHECKOUT_SESSION_ID}',
          cancelUrl: 'http://localhost:5173/admin/billing/invoices?canceled=true',
        });

      expect(checkoutRes.status).toBe(200);
      expect(checkoutRes.body.success).toBe(true);
      expect(checkoutRes.body.data.sessionId).toBeDefined();
      expect(checkoutRes.body.data.url).toBeDefined();

      const sessionId = checkoutRes.body.data.sessionId;

      // 2. Uncompleted session check: before customer pays in Stripe, session is unpaid
      const unpaidConfirmRes = await request(app)
        .post(`/api/billing/invoices/${invoice.id}/confirm-stripe-checkout`)
        .set('Cookie', authCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({ sessionId });

      expect(unpaidConfirmRes.status).toBe(200);
      // Status remains OPEN until payment is completed
      expect(unpaidConfirmRes.body.data.status).toBe('OPEN');

      // 3. Complete payment via the verified Stripe session handler
      const mockPaidSession = {
        id: sessionId,
        client_reference_id: invoice.id,
        payment_status: 'paid',
        payment_intent: `pi_test_${Date.now()}`,
        amount_total: 23800,
        currency: 'eur',
        customer: `cus_test_${Date.now()}`,
        metadata: {
          invoiceId: invoice.id,
          companyId: company.id,
          paymentType: 'INVOICE_PAYMENT',
        },
      };

      await stripeService._handleInvoiceCheckoutCompleted(mockPaidSession);

      // Check DB invoice status
      const updatedInvoice = await prisma.invoice.findUnique({
        where: { id: invoice.id },
        include: { payments: true },
      });
      expect(updatedInvoice.status).toBe('PAID');
      expect(updatedInvoice.payments.length).toBe(1);
      expect(updatedInvoice.payments[0].paymentMethod).toBe('stripe_checkout');
      expect(Number(updatedInvoice.payments[0].amount)).toBe(238.0);
      expect(updatedInvoice.payments[0].status).toBe('SUCCEEDED');

      // 4. Idempotency: Repeating payment handling does not duplicate payments
      await stripeService._handleInvoiceCheckoutCompleted(mockPaidSession);

      const recheckedInvoice = await prisma.invoice.findUnique({
        where: { id: invoice.id },
        include: { payments: true },
      });
      expect(recheckedInvoice.payments.length).toBe(1);
    });
  });
});
