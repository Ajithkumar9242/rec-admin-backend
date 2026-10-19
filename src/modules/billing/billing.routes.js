import { Router } from 'express';
import { BillingController } from './billing.controller.js';
import {
  authenticateSession,
  require2FAVerified,
  requireRole,
} from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
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
router.get('/stripe/config', requirePermission('BILLING', 'READ'), BillingController.getStripeConfig);
router.post('/stripe/checkout-session', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), BillingController.createCheckoutSession);
router.post('/stripe/portal-session', requirePermission('BILLING', 'READ'), BillingController.createPortalSession);

// Plans
router.get('/plans', requirePermission('BILLING', 'READ'), BillingController.listPlans);
router.get('/plans/:id', requirePermission('BILLING', 'READ'), BillingController.getPlan);
router.post('/plans', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'CREATE'), validate(createPlanSchema), BillingController.createPlan);
router.patch('/plans/:id', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(updatePlanSchema), BillingController.updatePlan);
router.patch('/plans/:id/status', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(planStatusToggleSchema), BillingController.togglePlanStatus);
router.post('/plans/:id/restore', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), BillingController.restorePlan);
router.delete('/plans/:id', requireRole('SUPER_ADMIN'), requirePermission('BILLING', 'DELETE'), BillingController.archivePlan);

// Subscriptions
router.get('/subscriptions', requirePermission('BILLING', 'READ'), BillingController.listSubscriptions);
router.get('/subscriptions/:id', requirePermission('BILLING', 'READ'), BillingController.getSubscription);
router.get('/subscriptions/:id/history', requirePermission('BILLING', 'READ'), BillingController.getSubscriptionHistory);
router.post('/subscriptions', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'CREATE'), validate(createSubscriptionSchema), BillingController.createSubscription);
router.patch('/subscriptions/:id/entitlements', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(updateEntitlementsSchema), BillingController.updateEntitlements);
router.post('/subscriptions/:id/upgrade', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(upgradeSubscriptionSchema), BillingController.upgradeSubscription);
router.post('/subscriptions/:id/cancel', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(cancelSubscriptionSchema), BillingController.cancelSubscription);
router.post('/subscriptions/:id/revoke', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(revokeSubscriptionSchema), BillingController.revokeSubscription);
router.post('/subscriptions/:id/apply-plan-quotas', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(applyPlanQuotasSchema), BillingController.applyPlanQuotas);

// Invoices & Payments
router.get('/invoices', requirePermission('BILLING', 'READ'), BillingController.listInvoices);
router.get('/invoices/:id', requirePermission('BILLING', 'READ'), BillingController.getInvoice);
router.post('/invoices', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'CREATE'), validate(createInvoiceSchema), BillingController.createInvoice);
router.post('/invoices/:id/stripe-checkout', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(createInvoiceCheckoutSchema), BillingController.createInvoiceCheckoutSession);
router.post('/invoices/:id/confirm-stripe-checkout', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(confirmInvoiceCheckoutSchema), BillingController.confirmInvoiceCheckoutSession);
router.post('/invoices/:id/payments', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(recordPaymentSchema), BillingController.recordPayment);
router.post('/invoices/:id/void', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('BILLING', 'EDIT'), validate(voidInvoiceSchema), BillingController.voidInvoice);

// Canonical Companies / Employers Search
router.get('/companies', requirePermission('COMPANIES', 'READ'), BillingController.listCompanies);
router.post('/companies', requireRole('ADMIN', 'SUPER_ADMIN'), requirePermission('COMPANIES', 'CREATE'), validate(createCompanySchema), BillingController.createCompany);

// Analytics & Reports
router.get('/analytics', requirePermission('BILLING', 'READ'), validate(analyticsQuerySchema), BillingController.getAnalytics);

export default router;
