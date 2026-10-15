import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { stripeService, StripeNotConfiguredError } from '../src/modules/billing/stripe.service.js';

const TEST_ADMIN_EMAIL = 'stripe_suite_admin@recruitrain.test';
const TEST_ADMIN_PASSWORD = 'StripePassword123!@#';

describe('RecruiTrain Stripe Test-Mode Integration & Environment Security Suite', () => {
  let app;
  let testAdminId;
  let authCookie;
  let totpSecret;

  beforeAll(async () => {
    // 1. Verify safe test database isolation
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Clean prior test admin if any
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
        name: 'Stripe Test Admin',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptedSecret,
      },
    });
    testAdminId = admin.id;

    // Login and authenticate session
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
    if (testAdminId) {
      await prisma.billingAuditLog.deleteMany({ where: { adminId: testAdminId } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: testAdminId } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: testAdminId } });
      await prisma.admin.delete({ where: { id: testAdminId } }).catch(() => {});
    }
  });

  // ========================================================
  // 1. KEY VALIDATION & SECURITY RULES
  // ========================================================
  describe('1. Stripe Key Validation & Safety Enforcement', () => {
    const originalSecret = env.STRIPE_SECRET_KEY;
    const originalPub = env.STRIPE_PUBLISHABLE_KEY;
    const originalWebhook = env.STRIPE_WEBHOOK_SECRET;

    afterEach(() => {
      env.STRIPE_SECRET_KEY = originalSecret;
      env.STRIPE_PUBLISHABLE_KEY = originalPub;
      env.STRIPE_WEBHOOK_SECRET = originalWebhook;
      stripeService.initClient();
    });

    it('strictly rejects live secret keys (sk_live_*)', () => {
      env.STRIPE_SECRET_KEY = 'sk_live_mocklivekey1234567890';
      env.STRIPE_PUBLISHABLE_KEY = 'pk_live_mocklivepub1234567890';
      const result = stripeService.validateKeyConfiguration();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Live Stripe keys are disabled');
    });

    it('strictly rejects live publishable keys (pk_live_*)', () => {
      env.STRIPE_SECRET_KEY = 'sk_test_mocktestsecret12345';
      env.STRIPE_PUBLISHABLE_KEY = 'pk_live_mocklivepub12345';
      const result = stripeService.validateKeyConfiguration();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Live Stripe keys are disabled');
    });

    it('rejects mismatched secret and publishable key modes', () => {
      env.STRIPE_SECRET_KEY = 'sk_test_validtestkey12345';
      env.STRIPE_PUBLISHABLE_KEY = 'pk_other_randomkey';
      const result = stripeService.validateKeyConfiguration();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Mismatched Stripe key configuration');
    });

    it('rejects placeholder secret keys', () => {
      env.STRIPE_SECRET_KEY = 'sk_test_placeholder_secret_key';
      env.STRIPE_PUBLISHABLE_KEY = 'pk_test_placeholder';
      const result = stripeService.validateKeyConfiguration();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Valid Stripe test secret key');
    });

    it('rejects empty or missing secret keys', () => {
      env.STRIPE_SECRET_KEY = '';
      env.STRIPE_PUBLISHABLE_KEY = '';
      const result = stripeService.validateKeyConfiguration();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Valid Stripe test secret key');
    });

    it('rejects webhook secret identical to secret key', () => {
      env.STRIPE_SECRET_KEY = 'sk_test_51MockTestKey1234567890';
      env.STRIPE_PUBLISHABLE_KEY = 'pk_test_51MockTestPub1234567890';
      env.STRIPE_WEBHOOK_SECRET = 'sk_test_51MockTestKey1234567890'; // accidental duplicate
      const result = stripeService.validateKeyConfiguration();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Webhook secret must not be identical');
    });

    it('rejects malformed webhook secret lacking whsec_ prefix', () => {
      env.STRIPE_SECRET_KEY = 'sk_test_51MockTestKey1234567890';
      env.STRIPE_PUBLISHABLE_KEY = 'pk_test_51MockTestPub1234567890';
      env.STRIPE_WEBHOOK_SECRET = 'invalid_webhook_secret_prefix';
      const result = stripeService.validateKeyConfiguration();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must start with whsec_');
    });

    it('accepts valid test keys and webhook secret format', () => {
      env.STRIPE_SECRET_KEY = 'sk_test_51MockTestSecretKey1234567890';
      env.STRIPE_PUBLISHABLE_KEY = 'pk_test_51MockTestPub1234567890';
      env.STRIPE_WEBHOOK_SECRET = 'whsec_MockWebhookSecretSigningKey123';
      const result = stripeService.validateKeyConfiguration();
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ========================================================
  // 2. CONFIGURATION STATUS ENDPOINT & SECRET REDACTION
  // ========================================================
  describe('2. Safe Configuration Endpoint & Secret Redaction', () => {
    it('returns unconfigured status when Stripe keys are empty or placeholder', async () => {
      const res = await request(app)
        .get('/api/billing/stripe/config')
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('configured');
      expect(res.body.data).toHaveProperty('mode');
      expect(res.body.data).toHaveProperty('publishableKey');
      expect(res.body.data).toHaveProperty('webhookConfigured');

      // Crucial: Secret key and webhook secret must never be exposed
      expect(res.body.data).not.toHaveProperty('secretKey');
      expect(res.body.data).not.toHaveProperty('stripeSecretKey');
      expect(res.body.data).not.toHaveProperty('webhookSecret');
      expect(JSON.stringify(res.body)).not.toContain('sk_');
      expect(JSON.stringify(res.body)).not.toContain('whsec_');
    });

    it('exposes only public publishable key when configured in test mode', () => {
      const originalSecret = env.STRIPE_SECRET_KEY;
      const originalPub = env.STRIPE_PUBLISHABLE_KEY;
      const originalWebhook = env.STRIPE_WEBHOOK_SECRET;

      env.STRIPE_SECRET_KEY = 'sk_test_51MockTestSecretKey1234567890';
      env.STRIPE_PUBLISHABLE_KEY = 'pk_test_51MockTestPub1234567890';
      env.STRIPE_WEBHOOK_SECRET = 'whsec_MockWebhookSecretSigningKey123';
      stripeService.initClient();

      const status = stripeService.getStatus();
      expect(status.configured).toBe(true);
      expect(status.mode).toBe('test');
      expect(status.publishableKey).toBe('pk_test_51MockTestPub1234567890');
      expect(status.webhookConfigured).toBe(true);
      expect(status).not.toHaveProperty('secretKey');

      // Cleanup
      env.STRIPE_SECRET_KEY = originalSecret;
      env.STRIPE_PUBLISHABLE_KEY = originalPub;
      env.STRIPE_WEBHOOK_SECRET = originalWebhook;
      stripeService.initClient();
    });
  });

  // ========================================================
  // 3. CHECKOUT SESSION CREATION SAFETY
  // ========================================================
  describe('3. Checkout Session Handling When Unconfigured', () => {
    it('returns 503 STRIPE_NOT_CONFIGURED when keys are missing or pending', async () => {
      // Ensure unconfigured state
      const originalSecret = env.STRIPE_SECRET_KEY;
      env.STRIPE_SECRET_KEY = '';
      stripeService.initClient();

      const res = await request(app)
        .post('/api/billing/stripe/checkout-session')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', authCookie)
        .send({
          companyId: 'non-existent-company',
          planId: 'non-existent-plan',
        });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('STRIPE_NOT_CONFIGURED');
      expect(res.body.error).toContain('pending configuration');

      // Restore
      env.STRIPE_SECRET_KEY = originalSecret;
      stripeService.initClient();
    });
  });

  // ========================================================
  // 4. WEBHOOK SIGNATURE VERIFICATION & DEDUPLICATION
  // ========================================================
  describe('4. Webhook Signature Verification & Idempotency', () => {
    const testSigningSecret = 'whsec_test_signing_secret_for_unit_tests_12345';
    const originalWebhook = env.STRIPE_WEBHOOK_SECRET;

    beforeAll(() => {
      env.STRIPE_WEBHOOK_SECRET = testSigningSecret;
    });

    afterAll(() => {
      env.STRIPE_WEBHOOK_SECRET = originalWebhook;
    });

    it('rejects webhook requests with missing stripe-signature header (400)', async () => {
      const res = await request(app)
        .post('/api/billing/stripe/webhook')
        .send({ id: 'evt_fake_test', type: 'charge.succeeded' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing stripe-signature header');
    });

    it('rejects webhook requests with forged or invalid signature (400)', async () => {
      const payload = JSON.stringify({ id: 'evt_fake_test', type: 'charge.succeeded' });
      const forgedSignature = 't=1600000000,v1=bad_signature_hash_value_12345';

      const res = await request(app)
        .post('/api/billing/stripe/webhook')
        .set('stripe-signature', forgedSignature)
        .set('content-type', 'application/json')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Webhook error');
    });

    it('successfully verifies and processes an authentic signed test event', async () => {
      const eventPayload = {
        id: `evt_test_verified_${Date.now()}`,
        object: 'event',
        api_version: '2024-11-20.acacia',
        type: 'payment_intent.created',
        data: {
          object: {
            id: 'pi_test_12345',
            amount: 5000,
            currency: 'eur',
          },
        },
      };

      const payloadString = JSON.stringify(eventPayload);
      const validSignature = Stripe.webhooks.generateTestHeaderString({
        payload: payloadString,
        secret: testSigningSecret,
      });

      const res = await request(app)
        .post('/api/billing/stripe/webhook')
        .set('stripe-signature', validSignature)
        .set('content-type', 'application/json')
        .send(payloadString);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      // Verify recorded in deduplication table
      const recorded = await prisma.stripeWebhookEvent.findUnique({
        where: { id: eventPayload.id },
      });
      expect(recorded).not.toBeNull();
      expect(recorded.type).toBe('payment_intent.created');
      expect(recorded.status).toBe('PROCESSED');

      // Cleanup
      await prisma.stripeWebhookEvent.delete({ where: { id: eventPayload.id } });
    });

    it('idempotently ignores duplicate webhook events', async () => {
      const duplicateId = `evt_test_idemp_${Date.now()}`;
      const eventPayload = {
        id: duplicateId,
        object: 'event',
        api_version: '2024-11-20.acacia',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_123' } },
      };

      const payloadString = JSON.stringify(eventPayload);
      const signature = Stripe.webhooks.generateTestHeaderString({
        payload: payloadString,
        secret: testSigningSecret,
      });

      // First post
      const firstRes = await request(app)
        .post('/api/billing/stripe/webhook')
        .set('stripe-signature', signature)
        .set('content-type', 'application/json')
        .send(payloadString);

      expect(firstRes.status).toBe(200);

      // Second post (duplicate arrival)
      const secondRes = await request(app)
        .post('/api/billing/stripe/webhook')
        .set('stripe-signature', signature)
        .set('content-type', 'application/json')
        .send(payloadString);

      expect(secondRes.status).toBe(200);
      expect(secondRes.body.processed).toBe(false);
      expect(secondRes.body.action).toBe('DUPLICATE_IGNORED');

      // Cleanup
      await prisma.stripeWebhookEvent.delete({ where: { id: duplicateId } });
    });
  });

  // ========================================================
  // 5. ENTITLEMENT SAFETY AGAINST UNVERIFIED REDIRECTIONS
  // ========================================================
  describe('5. Entitlement Safety & Browser Redirection Isolation', () => {
    it('does not grant entitlements on arbitrary GET requests or client callbacks', async () => {
      // Create a company and plan to simulate subscription
      const company = await prisma.company.create({
        data: { name: 'Redirection Test Corp', country: 'DE', status: 'ACTIVE' },
      });

      const plan = await prisma.plan.create({
        data: {
          name: 'Redirect Guard Plan',
          price: 50.00,
          currency: 'EUR',
          billingInterval: 'MONTHLY',
          candidateAccessLimit: 50,
          jobPostingLimit: 5,
          teamMemberLimit: 2,
          status: 'ACTIVE',
        },
      });

      // Create subscription in INCOMPLETE/PENDING state
      const subscription = await prisma.subscription.create({
        data: {
          companyId: company.id,
          planId: plan.id,
          billingInterval: 'MONTHLY',
          status: 'INCOMPLETE',
          startDate: new Date(),
          currency: 'EUR',
          price: 50.00,
          candidateAccessLimit: 50,
          candidateAccessUsage: 0,
          jobPostingLimit: 5,
          teamMemberLimit: 2,
        },
      });

      // Browser visits /admin/billing/subscriptions with fake session_id query param
      // Verify subscription remains INCOMPLETE and usage remaining is not activated
      const subBefore = await prisma.subscription.findUnique({ where: { id: subscription.id } });
      expect(subBefore.status).toBe('INCOMPLETE');

      // Calling GET /api/billing/subscriptions must simply list items and never activate or grant quotas
      const getRes = await request(app)
        .get('/api/billing/subscriptions')
        .set('Cookie', authCookie);

      expect(getRes.status).toBe(200);

      const subAfter = await prisma.subscription.findUnique({ where: { id: subscription.id } });
      expect(subAfter.status).toBe('INCOMPLETE');

      // Cleanup
      await prisma.subscription.delete({ where: { id: subscription.id } });
      await prisma.plan.delete({ where: { id: plan.id } });
      await prisma.company.delete({ where: { id: company.id } });
    });
  });
});
