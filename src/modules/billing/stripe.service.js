/**
 * Stripe Payment Provider Foundation Service
 *
 * Implements a clean, decoupled provider abstraction for Stripe:
 * - Fails safely with explicit unconfigured status when credentials are not present.
 * - Supports Day, Month, Year recurring intervals and One-Time payment sessions.
 * - Raw body HMAC-SHA256 signature verification.
 * - Database-backed event deduplication and idempotent out-of-order handling.
 * - Never trusts client-side redirection callbacks for payment confirmation.
 */

import Stripe from 'stripe';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { logBillingAction } from './billingAudit.service.js';
import { generateNextInvoiceNumber } from './invoiceNumberService.js';
import { calculateInvoiceTotals } from './taxService.js';
import { calculateSubscriptionEndDate } from './billingDateUtils.js';

export class StripeNotConfiguredError extends Error {
  constructor(message = 'Stripe payment provider is not configured. Secret key or webhook secret is missing.') {
    super(message);
    this.name = 'StripeNotConfiguredError';
    this.code = 'STRIPE_NOT_CONFIGURED';
    this.statusCode = 503;
  }
}

class StripeService {
  constructor() {
    this._client = null;
    this.initClient();
  }

  /**
   * Validates Stripe key configuration against security and environment rules.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateKeyConfiguration() {
    const secretKey = (env.STRIPE_SECRET_KEY || '').trim();
    const publishableKey = (env.STRIPE_PUBLISHABLE_KEY || '').trim();
    const webhookSecret = (env.STRIPE_WEBHOOK_SECRET || '').trim();

    const isPlaceholder = (val) => !val || val.includes('placeholder') || val.includes('replace_with');

    // Reject live keys strictly to ensure test mode cannot silently become live mode
    if (secretKey.startsWith('sk_live_') || publishableKey.startsWith('pk_live_')) {
      logger.warn('[SECURITY] Live Stripe keys are disabled. Only test keys (sk_test_*, pk_test_*) are permitted.');
      return { valid: false, error: 'Live Stripe keys are disabled in this environment. Only test keys (sk_test_*) are permitted.' };
    }

    // Check for mismatched live/test combinations
    const secretIsTest = secretKey.startsWith('sk_test_');
    const publishableIsTest = publishableKey.startsWith('pk_test_');

    if (secretKey && publishableKey && secretIsTest !== publishableIsTest) {
      return { valid: false, error: 'Mismatched Stripe key configuration: both secret and publishable keys must be test keys.' };
    }

    if (!secretKey || isPlaceholder(secretKey) || !secretIsTest) {
      return { valid: false, error: 'Valid Stripe test secret key (sk_test_*) is required.' };
    }

    // Webhook secret validation if provided
    if (webhookSecret) {
      if (webhookSecret === secretKey) {
        return { valid: false, error: 'Webhook secret must not be identical to the API secret key.' };
      }
      if (!webhookSecret.startsWith('whsec_') || isPlaceholder(webhookSecret)) {
        return { valid: false, error: 'Invalid webhook secret format: must start with whsec_ and not be a placeholder.' };
      }
    }

    return { valid: true };
  }

  initClient() {
    const key = (env.STRIPE_SECRET_KEY || '').trim();
    const keyCheck = this.validateKeyConfiguration();
    if (keyCheck.valid && key && key.startsWith('sk_test_') && !key.includes('placeholder')) {
      try {
        this._client = new Stripe(key, {
          apiVersion: '2024-11-20.acacia',
          typescript: false,
        });
      } catch (err) {
        logger.warn({ error: err.message }, 'Failed to initialize Stripe client');
        this._client = null;
      }
    } else {
      this._client = null;
    }
  }

  /**
   * Evaluates if Stripe API is configured and ready for test transactions.
   * @returns {boolean}
   */
  isApiConfigured() {
    const key = (env.STRIPE_SECRET_KEY || '').trim();
    return Boolean(
      key &&
      key.startsWith('sk_test_') &&
      !key.includes('placeholder') &&
      this._client
    );
  }

  /**
   * Evaluates if Stripe webhook signing secret is configured.
   * @returns {boolean}
   */
  isWebhookConfigured() {
    const webhook = (env.STRIPE_WEBHOOK_SECRET || '').trim();
    const secret = (env.STRIPE_SECRET_KEY || '').trim();
    return Boolean(
      webhook &&
      webhook.startsWith('whsec_') &&
      !webhook.includes('placeholder') &&
      webhook !== secret
    );
  }

  /**
   * Evaluates if Stripe is configured and ready for checkout sessions.
   * @returns {boolean}
   */
  isConfigured() {
    return this.isApiConfigured();
  }

  /**
   * Returns current operational status of the Stripe provider.
   * Exposes only the publishable key; secret keys are never returned.
   * @returns {{ configured: boolean, mode: 'test'|'unconfigured', publishableKey: string, webhookConfigured: boolean }}
   */
  getStatus() {
    const configured = this.isApiConfigured();
    const publishableKey = (env.STRIPE_PUBLISHABLE_KEY || '').trim();
    const isSafePublishable = publishableKey.startsWith('pk_test_') && !publishableKey.includes('placeholder');

    return {
      configured,
      mode: configured ? 'test' : 'unconfigured',
      publishableKey: (configured && isSafePublishable) ? publishableKey : '',
      webhookConfigured: this.isWebhookConfigured(),
    };
  }

  /**
   * Gets initialized Stripe client or throws safe configuration error.
   * @returns {Stripe}
   */
  getClient() {
    if (!this._client || !this.isApiConfigured()) {
      throw new StripeNotConfiguredError('Stripe payment provider is not configured. Valid test secret key (sk_test_*) is required.');
    }
    return this._client;
  }

  /**
   * Creates or resolves a Stripe customer record for an employer.
   *
   * @param {object} params
   * @param {string} params.companyId
   * @param {string} params.companyName
   * @param {string} [params.email]
   * @param {string} [params.idempotencyKey]
   * @returns {Promise<string>} Stripe customer ID
   */
  async getOrCreateCustomer({ companyId, companyName, email, idempotencyKey = null }) {
    const stripe = this.getClient();

    // Check if company already has an active subscription with a stripeCustomerId
    const existingSub = await prisma.subscription.findFirst({
      where: { companyId, stripeCustomerId: { not: null } },
      select: { stripeCustomerId: true },
    });

    if (existingSub?.stripeCustomerId) {
      return existingSub.stripeCustomerId;
    }

    const options = idempotencyKey ? { idempotencyKey } : {};
    const customer = await stripe.customers.create(
      {
        name: companyName,
        email: email || undefined,
        metadata: { companyId },
      },
      options
    );

    return customer.id;
  }

  /**
   * Creates a Stripe Checkout Session for subscription or one-time payment.
   *
   * @param {object} params
   * @param {string} params.companyId
   * @param {string} params.companyName
   * @param {string} [params.billingEmail]
   * @param {object} params.plan
   * @param {string} [params.subscriptionId]
   * @param {string} params.successUrl
   * @param {string} params.cancelUrl
   * @param {string} [params.idempotencyKey]
   * @returns {Promise<{ sessionId: string, url: string }>}
   */
  async createCheckoutSession({
    companyId,
    companyName,
    billingEmail,
    plan,
    subscriptionId,
    successUrl,
    cancelUrl,
    idempotencyKey = null,
  }) {
    const stripe = this.getClient();
    const customerId = await this.getOrCreateCustomer({
      companyId,
      companyName,
      email: billingEmail,
      idempotencyKey: idempotencyKey ? `cust_${idempotencyKey}` : undefined,
    });

    const isRecurring = plan.billingInterval !== 'ONE_TIME';
    const unitAmountCents = Math.round(Number(plan.offerPrice ?? plan.price) * 100);

    let lineItem;

    if (isRecurring) {
      const intervalMap = {
        DAY: { interval: 'day', interval_count: 1 },
        MONTHLY: { interval: 'month', interval_count: 1 },
        YEARLY: { interval: 'year', interval_count: 1 },
      };

      const recurringConfig = intervalMap[plan.billingInterval];
      if (!recurringConfig) {
        throw new Error(`Unsupported billing interval for recurring checkout: ${plan.billingInterval}`);
      }

      lineItem = {
        price_data: {
          currency: (plan.currency || 'EUR').toLowerCase(),
          product_data: {
            name: plan.name,
            description: plan.description || undefined,
          },
          unit_amount: unitAmountCents,
          recurring: recurringConfig,
        },
        quantity: 1,
      };
    } else {
      lineItem = {
        price_data: {
          currency: (plan.currency || 'EUR').toLowerCase(),
          product_data: {
            name: plan.name,
            description: plan.description || undefined,
          },
          unit_amount: unitAmountCents,
        },
        quantity: 1,
      };
    }

    const sessionOptions = idempotencyKey ? { idempotencyKey } : {};
    const session = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: isRecurring ? 'subscription' : 'payment',
        line_items: [lineItem],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: companyId,
        metadata: {
          companyId,
          planId: plan.id,
          subscriptionId: subscriptionId || '',
          billingInterval: plan.billingInterval,
        },
      },
      sessionOptions
    );

    return {
      sessionId: session.id,
      url: session.url,
    };
  }

  /**
   * Creates a Stripe Checkout Session for an unpaid or partially paid invoice.
   *
   * @param {object} params
   * @param {object} params.invoice
   * @param {object} params.company
   * @param {number} params.outstandingBalance
   * @param {string} params.successUrl
   * @param {string} params.cancelUrl
   * @param {string} [params.idempotencyKey]
   * @returns {Promise<{ sessionId: string, url: string }>}
   */
  async createInvoiceCheckoutSession({
    invoice,
    company,
    outstandingBalance,
    successUrl,
    cancelUrl,
    idempotencyKey = null,
  }) {
    const stripe = this.getClient();

    if (outstandingBalance <= 0) {
      throw new Error('Invoice has no outstanding balance to pay.');
    }

    const customerId = await this.getOrCreateCustomer({
      companyId: invoice.companyId,
      companyName: company?.legalName || company?.name || 'Company',
      email: company?.billingEmail || undefined,
      idempotencyKey: idempotencyKey ? `cust_${idempotencyKey}` : undefined,
    });

    const unitAmountCents = Math.round(Number(outstandingBalance) * 100);

    const lineItem = {
      price_data: {
        currency: (invoice.currency || 'EUR').toLowerCase(),
        product_data: {
          name: `Invoice ${invoice.invoiceNumber}`,
          description: `Payment for Invoice ${invoice.invoiceNumber}`,
        },
        unit_amount: unitAmountCents,
      },
      quantity: 1,
    };

    const sessionOptions = idempotencyKey ? { idempotencyKey } : {};
    const session = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: 'payment',
        line_items: [lineItem],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: invoice.id,
        metadata: {
          paymentType: 'INVOICE_PAYMENT',
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          companyId: invoice.companyId,
        },
      },
      sessionOptions
    );

    return {
      sessionId: session.id,
      url: session.url,
    };
  }

  /**
   * Verifies Stripe Webhook signature against raw request body.
   * @param {Buffer|string} rawBody
   * @param {string} signature
   * @returns {Stripe.Event}
   */
  verifyWebhookSignature(rawBody, signature) {
    if (!this.isWebhookConfigured()) {
      throw new StripeNotConfiguredError('Stripe webhook signing secret (whsec_*) is not configured.');
    }

    if (!rawBody) {
      throw new Error('Raw body buffer is required for webhook signature verification.');
    }

    if (!signature) {
      throw new Error('Missing stripe-signature header.');
    }

    const webhookSecret = (env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (this._client) {
      return this._client.webhooks.constructEvent(rawBody, signature, webhookSecret);
    }
    return Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }

  /**
   * Idempotent webhook event processor with deduplication.
   *
   * @param {Stripe.Event} event
   * @returns {Promise<{ processed: boolean, action: string, eventId: string }>}
   */
  async handleWebhookEvent(event) {
    const eventId = event.id;

    // 1. Deduplication check in stripe_webhook_events
    try {
      await prisma.stripeWebhookEvent.create({
        data: {
          id: eventId,
          type: event.type,
          status: 'PROCESSED',
        },
      });
    } catch (err) {
      // Unique constraint violation indicates event was already handled
      logger.info({ eventId, type: event.type }, 'Ignoring duplicate Stripe webhook event');
      return { processed: false, action: 'DUPLICATE_IGNORED', eventId };
    }

    logger.info({ eventId, type: event.type }, 'Processing verified Stripe webhook event');

    // 2. Dispatch event to state reconciliation
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await this._handleCheckoutSessionCompleted(session);
        return { processed: true, action: 'CHECKOUT_COMPLETED', eventId };
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        await this._handleInvoicePaymentSucceeded(invoice);
        return { processed: true, action: 'INVOICE_PAID', eventId };
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await this._handleInvoicePaymentFailed(invoice);
        return { processed: true, action: 'INVOICE_PAYMENT_FAILED', eventId };
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await this._handleStripeSubscriptionDeleted(sub);
        return { processed: true, action: 'SUBSCRIPTION_DELETED', eventId };
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await this._handleStripeSubscriptionUpdated(sub);
        return { processed: true, action: 'SUBSCRIPTION_UPDATED', eventId };
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        await this._handleChargeRefunded(charge);
        return { processed: true, action: 'CHARGE_REFUNDED', eventId };
      }

      default:
        logger.debug({ type: event.type }, 'Unhandled Stripe event received');
        return { processed: true, action: 'EVENT_ACKNOWLEDGED', eventId };
    }
  }

  async _handleInvoiceCheckoutCompleted(session) {
    const invoiceId = session.metadata?.invoiceId || session.client_reference_id;
    if (!invoiceId) {
      logger.warn({ session: session.id }, 'Invoice checkout session completed without invoice ID metadata');
      return;
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true },
    });

    if (!invoice) {
      logger.warn({ invoiceId, session: session.id }, 'Invoice not found for completed checkout session');
      return;
    }

    // Check for existing payment with same stripePaymentIntentId or session
    const stripePaymentIntentId = session.payment_intent || null;
    if (stripePaymentIntentId) {
      const existingPayment = invoice.payments.find(
        (p) => p.stripePaymentIntentId && p.stripePaymentIntentId === stripePaymentIntentId
      );
      if (existingPayment) {
        logger.info({ invoiceId, stripePaymentIntentId }, 'Duplicate payment detected for invoice checkout, skipping');
        return;
      }
    }

    const amountPaid = session.amount_total ? session.amount_total / 100 : Number(invoice.grossTotal);

    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amount: amountPaid,
          currency: (session.currency || invoice.currency).toUpperCase(),
          status: 'SUCCEEDED',
          paymentMethod: 'stripe_checkout',
          stripePaymentIntentId,
          paidAt: new Date(),
        },
      });

      const currentTotalPaid = invoice.payments
        .filter((p) => p.status === 'SUCCEEDED')
        .reduce((sum, p) => sum + Number(p.amount), 0) + amountPaid;

      if (currentTotalPaid >= Number(invoice.grossTotal)) {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            status: 'PAID',
            paidDate: new Date(),
            stripePaymentIntentId,
          },
        });
      }

      await logBillingAction({
        entityType: 'INVOICE',
        entityId: invoice.id,
        action: 'STRIPE_INVOICE_PAYMENT_COMPLETED',
        actor: 'STRIPE_WEBHOOK',
        details: {
          sessionId: session.id,
          paymentId: payment.id,
          amountPaid,
          stripePaymentIntentId,
          invoiceNumber: invoice.invoiceNumber,
        },
        tx,
      });
    });
  }

  async _handleCheckoutSessionCompleted(session) {
    if (session.metadata?.paymentType === 'INVOICE_PAYMENT' || session.metadata?.invoiceId) {
      return this._handleInvoiceCheckoutCompleted(session);
    }

    const { companyId, planId, subscriptionId } = session.metadata || {};
    const stripeCustomerId = session.customer;
    const stripeSubscriptionId = session.subscription || null;

    if (!companyId || !planId) {
      logger.warn({ session: session.id }, 'Checkout completed without valid metadata');
      return;
    }

    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return;

    await prisma.$transaction(async (tx) => {
      let sub;
      const startDate = new Date();
      const endDate = calculateSubscriptionEndDate(startDate, plan.billingInterval);

      if (subscriptionId) {
        sub = await tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            status: 'ACTIVE',
            stripeCustomerId,
            stripeSubscriptionId,
            stripeCheckoutSessionId: session.id,
            startDate,
            endDate,
            nextBillingDate: endDate,
            candidateAccessLimit: plan.candidateAccessLimit,
            jobPostingLimit: plan.jobPostingLimit,
            teamMemberLimit: plan.teamMemberLimit,
          },
        });
      } else {
        // Create new active subscription
        sub = await tx.subscription.create({
          data: {
            companyId,
            planId,
            status: 'ACTIVE',
            startDate,
            endDate,
            nextBillingDate: endDate,
            billingInterval: plan.billingInterval,
            currency: plan.currency,
            price: plan.offerPrice ?? plan.price,
            candidateAccessLimit: plan.candidateAccessLimit,
            jobPostingLimit: plan.jobPostingLimit,
            teamMemberLimit: plan.teamMemberLimit,
            stripeCustomerId,
            stripeSubscriptionId,
            stripeCheckoutSessionId: session.id,
          },
        });
      }

      // Generate invoice
      const company = await tx.company.findUnique({ where: { id: companyId } });
      const invoiceNumber = await generateNextInvoiceNumber(tx);
      const totals = calculateInvoiceTotals(plan.offerPrice ?? plan.price, null, company?.country || 'DE');

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          companyId,
          subscriptionId: sub.id,
          dueDate: new Date(),
          paidDate: new Date(),
          currency: plan.currency,
          netAmount: totals.netAmount,
          taxRate: totals.taxRate,
          taxAmount: totals.taxAmount,
          grossTotal: totals.grossTotal,
          status: 'PAID',
          legalNameSnapshot: company?.legalName || company?.name,
          taxIdSnapshot: company?.taxId,
          billingAddressSnapshot: company?.billingAddress,
          stripeInvoiceId: session.invoice || null,
          stripePaymentIntentId: session.payment_intent || null,
        },
      });

      // Record payment
      await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amount: totals.grossTotal,
          currency: plan.currency,
          status: 'SUCCEEDED',
          paymentMethod: 'stripe',
          stripePaymentIntentId: session.payment_intent || null,
          paidAt: new Date(),
        },
      });

      await logBillingAction({
        entityType: 'SUBSCRIPTION',
        entityId: sub.id,
        action: 'STRIPE_CHECKOUT_COMPLETED',
        actor: 'STRIPE_WEBHOOK',
        details: { sessionId: session.id, planId, companyId, status: 'ACTIVE' },
        tx,
      });
    });
  }

  async _handleInvoicePaymentSucceeded(stripeInvoice) {
    const stripeSubscriptionId = stripeInvoice.subscription;
    if (!stripeSubscriptionId) return;

    const sub = await prisma.subscription.findFirst({
      where: { stripeSubscriptionId },
      include: { company: true },
    });

    if (!sub) return;

    await prisma.$transaction(async (tx) => {
      // Re-activate or advance next billing date
      const newEndDate = calculateSubscriptionEndDate(new Date(), sub.billingInterval);
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          endDate: newEndDate,
          nextBillingDate: newEndDate,
        },
      });

      // Reconcile or create invoice
      const existingInv = await tx.invoice.findFirst({
        where: { stripeInvoiceId: stripeInvoice.id },
      });

      const amountPaid = Number(stripeInvoice.amount_paid || 0) / 100;

      if (existingInv) {
        await tx.invoice.update({
          where: { id: existingInv.id },
          data: { status: 'PAID', paidDate: new Date() },
        });

        await tx.payment.create({
          data: {
            invoiceId: existingInv.id,
            amount: amountPaid,
            currency: stripeInvoice.currency.toUpperCase(),
            status: 'SUCCEEDED',
            paymentMethod: 'stripe',
            stripeChargeId: stripeInvoice.charge || null,
            paidAt: new Date(),
          },
        });
      } else {
        const invNum = await generateNextInvoiceNumber(tx);
        const totals = calculateInvoiceTotals(sub.price, null, sub.company.country);

        const newInv = await tx.invoice.create({
          data: {
            invoiceNumber: invNum,
            companyId: sub.companyId,
            subscriptionId: sub.id,
            dueDate: new Date(),
            paidDate: new Date(),
            currency: sub.currency,
            netAmount: totals.netAmount,
            taxRate: totals.taxRate,
            taxAmount: totals.taxAmount,
            grossTotal: totals.grossTotal,
            status: 'PAID',
            legalNameSnapshot: sub.company.legalName || sub.company.name,
            taxIdSnapshot: sub.company.taxId,
            stripeInvoiceId: stripeInvoice.id,
          },
        });

        await tx.payment.create({
          data: {
            invoiceId: newInv.id,
            amount: totals.grossTotal,
            currency: sub.currency,
            status: 'SUCCEEDED',
            paymentMethod: 'stripe',
            stripeChargeId: stripeInvoice.charge || null,
            paidAt: new Date(),
          },
        });
      }

      await logBillingAction({
        entityType: 'INVOICE',
        entityId: stripeInvoice.id,
        action: 'STRIPE_INVOICE_PAID',
        actor: 'STRIPE_WEBHOOK',
        details: { subscriptionId: sub.id, amountPaid },
        tx,
      });
    });
  }

  async _handleInvoicePaymentFailed(stripeInvoice) {
    const stripeSubscriptionId = stripeInvoice.subscription;
    if (!stripeSubscriptionId) return;

    const sub = await prisma.subscription.findFirst({
      where: { stripeSubscriptionId },
    });

    if (sub) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'PAST_DUE' },
      });

      await logBillingAction({
        entityType: 'SUBSCRIPTION',
        entityId: sub.id,
        action: 'PAYMENT_FAILED_PAST_DUE',
        actor: 'STRIPE_WEBHOOK',
        details: { stripeInvoiceId: stripeInvoice.id },
      });
    }
  }

  async _handleStripeSubscriptionDeleted(stripeSub) {
    const sub = await prisma.subscription.findFirst({
      where: { stripeSubscriptionId: stripeSub.id },
    });

    if (sub && sub.status !== 'CANCELLED') {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: 'Cancelled via Stripe dashboard/webhook',
        },
      });

      await logBillingAction({
        entityType: 'SUBSCRIPTION',
        entityId: sub.id,
        action: 'CANCEL_VIA_STRIPE',
        actor: 'STRIPE_WEBHOOK',
        details: { stripeSubscriptionId: stripeSub.id },
      });
    }
  }

  async _handleStripeSubscriptionUpdated(stripeSub) {
    const sub = await prisma.subscription.findFirst({
      where: { stripeSubscriptionId: stripeSub.id },
    });

    if (sub) {
      const statusMap = {
        active: 'ACTIVE',
        past_due: 'PAST_DUE',
        canceled: 'CANCELLED',
        unpaid: 'PAST_DUE',
        incomplete: 'INCOMPLETE',
      };

      const mappedStatus = statusMap[stripeSub.status] || sub.status;
      const currentPeriodEnd = stripeSub.current_period_end
        ? new Date(stripeSub.current_period_end * 1000)
        : sub.endDate;

      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: mappedStatus,
          endDate: currentPeriodEnd,
          nextBillingDate: currentPeriodEnd,
        },
      });
    }
  }

  async _handleChargeRefunded(charge) {
    const payment = await prisma.payment.findFirst({
      where: {
        OR: [
          { stripeChargeId: charge.id },
          { stripePaymentIntentId: charge.payment_intent },
        ],
      },
    });

    if (payment) {
      const refundedAmount = Number(charge.amount_refunded || 0) / 100;
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'REFUNDED',
          refundedAmount,
        },
      });

      await logBillingAction({
        entityType: 'PAYMENT',
        entityId: payment.id,
        action: 'CHARGE_REFUNDED',
        actor: 'STRIPE_WEBHOOK',
        details: { chargeId: charge.id, refundedAmount },
      });
    }
  }

  /**
   * Creates a Stripe Customer Portal session for managing subscriptions and payment methods.
   *
   * @param {object} params
   * @param {string} params.customerId Stripe customer ID
   * @param {string} params.returnUrl URL to redirect back to
   * @returns {Promise<any>}
   */
  async createCustomerPortalSession({ customerId, returnUrl }) {
    if (!this.isConfigured() || !this._client) {
      throw new StripeNotConfiguredError();
    }
    if (!customerId) {
      throw new Error('customerId is required to create a Stripe Customer Portal session.');
    }
    return this._client.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }
}

export const stripeService = new StripeService();
