import { z } from 'zod';

export const planBillingIntervalEnum = z.enum(['DAY', 'MONTHLY', 'YEARLY', 'ONE_TIME']);
export const planStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']);
export const subscriptionStatusEnum = z.enum(['ACTIVE', 'CANCELLED', 'EXPIRED', 'REVOKED', 'PAST_DUE', 'INCOMPLETE']);
export const invoiceStatusEnum = z.enum(['DRAFT', 'OPEN', 'PAID', 'OVERDUE', 'VOID', 'UNCOLLECTIBLE']);

export const createPlanSchema = {
  body: z.object({
    name: z.string().trim().min(2, 'Plan name must be at least 2 characters').max(100),
    description: z.string().trim().max(1000).optional().nullable(),
    price: z.coerce.number().min(0, 'Price must be non-negative'),
    offerPrice: z.coerce.number().min(0, 'Offer price must be non-negative').optional().nullable(),
    currency: z.string().trim().toUpperCase().min(3).max(3).default('EUR'),
    billingInterval: planBillingIntervalEnum,
    candidateAccessLimit: z.coerce.number().int().min(0, 'Candidate access limit must be non-negative integer'),
    jobPostingLimit: z.coerce.number().int().min(0, 'Job posting limit must be non-negative integer'),
    teamMemberLimit: z.coerce.number().int().min(0, 'Team member limit must be non-negative integer'),
    status: planStatusEnum.default('ACTIVE'),
  }).refine((data) => {
    if (data.offerPrice !== null && data.offerPrice !== undefined) {
      return data.offerPrice <= data.price;
    }
    return true;
  }, {
    message: 'Offer price cannot be greater than regular price',
    path: ['offerPrice'],
  }),
};

export const updatePlanSchema = {
  params: z.object({
    id: z.string().uuid('Invalid plan ID format'),
  }),
  body: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(1000).optional().nullable(),
    price: z.coerce.number().min(0, 'Price must be non-negative').optional(),
    offerPrice: z.coerce.number().min(0, 'Offer price must be non-negative').optional().nullable(),
    currency: z.string().trim().toUpperCase().min(3).max(3).optional(),
    billingInterval: planBillingIntervalEnum.optional(),
    candidateAccessLimit: z.coerce.number().int().min(0).optional(),
    jobPostingLimit: z.coerce.number().int().min(0).optional(),
    teamMemberLimit: z.coerce.number().int().min(0).optional(),
    status: planStatusEnum.optional(),
  }).refine((data) => {
    if (data.price !== undefined && data.offerPrice !== undefined && data.offerPrice !== null) {
      return data.offerPrice <= data.price;
    }
    return true;
  }, {
    message: 'Offer price cannot be greater than regular price',
    path: ['offerPrice'],
  }),
};

export const planStatusToggleSchema = {
  params: z.object({
    id: z.string().uuid('Invalid plan ID format'),
  }),
  body: z.object({
    status: z.enum(['ACTIVE', 'INACTIVE']),
  }),
};

export const createSubscriptionSchema = {
  body: z.object({
    companyId: z.string().uuid('Invalid company ID format'),
    planId: z.string().uuid('Invalid plan ID format'),
    startDate: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
    customCandidateAccessLimit: z.coerce.number().int().min(0).optional(),
    customJobPostingLimit: z.coerce.number().int().min(0).optional(),
    customTeamMemberLimit: z.coerce.number().int().min(0).optional(),
  }),
};

export const updateEntitlementsSchema = {
  params: z.object({
    id: z.string().uuid('Invalid subscription ID format'),
  }),
  body: z.object({
    candidateAccessLimit: z.coerce.number().int().min(0, 'Candidate access limit must be non-negative'),
    jobPostingLimit: z.coerce.number().int().min(0, 'Job posting limit must be non-negative'),
    teamMemberLimit: z.coerce.number().int().min(0, 'Team member limit must be non-negative'),
    confirmBelowUsage: z.boolean().default(false),
  }),
};

export const upgradeSubscriptionSchema = {
  params: z.object({
    id: z.string().uuid('Invalid subscription ID format'),
  }),
  body: z.object({
    newPlanId: z.string().uuid('Invalid new plan ID format'),
  }),
};

export const cancelSubscriptionSchema = {
  params: z.object({
    id: z.string().uuid('Invalid subscription ID format'),
  }),
  body: z.object({
    reason: z.string().trim().max(500).optional(),
  }),
};

export const revokeSubscriptionSchema = {
  params: z.object({
    id: z.string().uuid('Invalid subscription ID format'),
  }),
  body: z.object({
    reason: z.string().trim().min(3, 'Revocation reason is required and must be at least 3 characters').max(500),
  }),
};

export const createInvoiceSchema = {
  body: z.object({
    companyId: z.string().uuid('Invalid company ID format'),
    subscriptionId: z.string().uuid().optional().nullable(),
    netAmount: z.coerce.number().min(0, 'Net amount must be non-negative'),
    currency: z.string().trim().toUpperCase().min(3).max(3).default('EUR'),
    customTaxRate: z.coerce.number().min(0).max(1).optional().nullable(),
    dueDate: z.string().optional(),
  }),
};

export const recordPaymentSchema = {
  params: z.object({
    id: z.string().uuid('Invalid invoice ID format'),
  }),
  body: z.object({
    amount: z.coerce.number().positive('Payment amount must be greater than zero'),
    paymentMethod: z.string().trim().min(2).max(50).default('manual_bank_transfer'),
    reference: z.string().trim().max(100).optional().nullable(),
  }),
};

export const voidInvoiceSchema = {
  params: z.object({
    id: z.string().uuid('Invalid invoice ID format'),
  }),
  body: z.object({
    reason: z.string().trim().min(3, 'Void reason is required and must be at least 3 characters').max(500),
  }),
};

export const createCompanySchema = {
  body: z.object({
    name: z.string().trim().min(2, 'Company name must be at least 2 characters').max(150),
    legalName: z.string().trim().max(200).optional().nullable(),
    taxId: z.string().trim().max(50).optional().nullable(),
    billingEmail: z.string().trim().email('Invalid email address').optional().nullable(),
    billingAddress: z.string().trim().max(500).optional().nullable(),
    country: z.string().trim().toUpperCase().min(2).max(3).default('DE'),
  }),
};

export const analyticsQuerySchema = {
  query: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    groupBy: z.enum(['day', 'month', 'year']).default('month'),
    currency: z.string().trim().toUpperCase().optional(),
  }),
};
