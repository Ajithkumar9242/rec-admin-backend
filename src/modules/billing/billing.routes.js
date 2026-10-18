import { Router } from 'express';
import { BillingController } from './billing.controller.js';
import {
  authenticateSession,
  require2FAVerified,
  requireRole,
} from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  createPlanSchema,
  updatePlanSchema,
  planStatusToggleSchema,
  createSubscriptionSchema,
  updateEntitlementsSchema,
  upgradeSubscriptionSchema,
  cancelSubscriptionSchema,
  revokeSubscriptionSchema,
  applyPlanQuotasSchema,
  createInvoiceSchema,
  recordPaymentSchema,
  voidInvoiceSchema,
  createInvoiceCheckoutSchema,
  confirmInvoiceCheckoutSchema,
  createCompanySchema,
  analyticsQuerySchema,
} from './billing.validation.js';

const router = Router();

// ==========================================
// PUBLIC / WEBHOOK ROUTES
// ==========================================
// Stripe Webhook: Signature verified via raw body inside controller
router.post('/stripe/webhook', BillingController.handleWebhook);
router.post('/webhook', BillingController.handleWebhook);

// ==========================================
// PROTECTED ADMIN SHELL ROUTES
// ==========================================
router.use(authenticateSession);
router.use(require2FAVerified);

// Stripe Configuration Status
router.get('/stripe/config', BillingController.getStripeConfig);
router.post('/stripe/checkout-session', BillingController.createCheckoutSession);
router.post('/stripe/portal-session', BillingController.createPortalSession);

// Plans
router.get('/plans', BillingController.listPlans);
router.get('/plans/:id', BillingController.getPlan);
router.post('/plans', requireRole('ADMIN', 'SUPER_ADMIN'), validate(createPlanSchema), BillingController.createPlan);
router.patch('/plans/:id', requireRole('ADMIN', 'SUPER_ADMIN'), validate(updatePlanSchema), BillingController.updatePlan);
router.patch('/plans/:id/status', requireRole('ADMIN', 'SUPER_ADMIN'), validate(planStatusToggleSchema), BillingController.togglePlanStatus);
router.post('/plans/:id/restore', requireRole('ADMIN', 'SUPER_ADMIN'), BillingController.restorePlan);
router.delete('/plans/:id', requireRole('SUPER_ADMIN'), BillingController.archivePlan);

// Subscriptions
router.get('/subscriptions', BillingController.listSubscriptions);
router.get('/subscriptions/:id', BillingController.getSubscription);
router.get('/subscriptions/:id/history', BillingController.getSubscriptionHistory);
router.post('/subscriptions', requireRole('ADMIN', 'SUPER_ADMIN'), validate(createSubscriptionSchema), BillingController.createSubscription);
router.patch('/subscriptions/:id/entitlements', requireRole('ADMIN', 'SUPER_ADMIN'), validate(updateEntitlementsSchema), BillingController.updateEntitlements);
router.post('/subscriptions/:id/upgrade', requireRole('ADMIN', 'SUPER_ADMIN'), validate(upgradeSubscriptionSchema), BillingController.upgradeSubscription);
router.post('/subscriptions/:id/cancel', requireRole('ADMIN', 'SUPER_ADMIN'), validate(cancelSubscriptionSchema), BillingController.cancelSubscription);
router.post('/subscriptions/:id/revoke', requireRole('ADMIN', 'SUPER_ADMIN'), validate(revokeSubscriptionSchema), BillingController.revokeSubscription);
router.post('/subscriptions/:id/apply-plan-quotas', requireRole('ADMIN', 'SUPER_ADMIN'), validate(applyPlanQuotasSchema), BillingController.applyPlanQuotas);

// Invoices & Payments
router.get('/invoices', BillingController.listInvoices);
router.get('/invoices/:id', BillingController.getInvoice);
router.post('/invoices', requireRole('ADMIN', 'SUPER_ADMIN'), validate(createInvoiceSchema), BillingController.createInvoice);
router.post('/invoices/:id/stripe-checkout', requireRole('ADMIN', 'SUPER_ADMIN'), validate(createInvoiceCheckoutSchema), BillingController.createInvoiceCheckoutSession);
router.post('/invoices/:id/confirm-stripe-checkout', requireRole('ADMIN', 'SUPER_ADMIN'), validate(confirmInvoiceCheckoutSchema), BillingController.confirmInvoiceCheckoutSession);
router.post('/invoices/:id/payments', requireRole('ADMIN', 'SUPER_ADMIN'), validate(recordPaymentSchema), BillingController.recordPayment);
router.post('/invoices/:id/void', requireRole('ADMIN', 'SUPER_ADMIN'), validate(voidInvoiceSchema), BillingController.voidInvoice);

// Canonical Companies / Employers Search
router.get('/companies', BillingController.listCompanies);
router.post('/companies', requireRole('ADMIN', 'SUPER_ADMIN'), validate(createCompanySchema), BillingController.createCompany);

// Analytics & Reports
router.get('/analytics', validate(analyticsQuerySchema), BillingController.getAnalytics);

export default router;
