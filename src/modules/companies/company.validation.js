import { z } from 'zod';
import { isValidVideoUrl } from '../../lib/fileValidation.js';

export const companyStatusEnum = z.enum([
  'IN_REVIEW',
  'UNVERIFIED',
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
]);

export const companySizeEnum = z.enum([
  '1-10',
  '11-50',
  '51-200',
  '201-500',
  '501-1000',
  '1000+',
]);

export const companyUserRoleEnum = z.enum([
  'OWNER',
  'ADMIN',
  'RECRUITER',
  'MEMBER',
]);

export const documentReviewStatusEnum = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
]);

export const listCompaniesSchema = {
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().optional(),
    status: companyStatusEnum.optional(),
    industryId: z.string().uuid().optional(),
    country: z.string().trim().optional(),
    sortBy: z.enum(['name', 'createdAt', 'status', 'companyCode', 'country', 'updatedAt']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
};

export const getCompanyByIdSchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
  }),
};

export const createCompanySchema = {
  body: z.object({
    name: z.string().trim().min(2, 'Company name must be at least 2 characters').max(150),
    legalName: z.string().trim().max(150).optional().nullable(),
    taxId: z.string().trim().max(50).optional().nullable(),
    companyCode: z.string().trim().max(50).optional().nullable(),
    registrationNumber: z.string().trim().max(50).optional().nullable(),
    industryId: z.string().uuid('Invalid industry ID').optional().nullable(),
    subIndustryId: z.string().uuid('Invalid sub-industry ID').optional().nullable(),
    companySize: companySizeEnum.optional().nullable(),
    foundedYear: z.coerce.number().int().min(1800).max(new Date().getFullYear() + 1).optional().nullable(),
    description: z.string().trim().max(2000).optional().nullable(),
    hiringDomestic: z.boolean().optional().default(true),
    hiringInternational: z.boolean().optional().default(false),
    hiringEu: z.boolean().optional().default(false),
    email: z.string().trim().email('Invalid email address').optional().nullable().or(z.literal('')),
    hrEmail: z.string().trim().email('Invalid HR email address').optional().nullable().or(z.literal('')),
    supportEmail: z.string().trim().email('Invalid support email address').optional().nullable().or(z.literal('')),
    phone: z.string().trim().max(30).optional().nullable(),
    alternatePhone: z.string().trim().max(30).optional().nullable(),
    website: z.string().trim().url('Invalid website URL').optional().nullable().or(z.literal('')),
    addressLine1: z.string().trim().max(255).optional().nullable(),
    addressLine2: z.string().trim().max(255).optional().nullable(),
    city: z.string().trim().max(100).optional().nullable(),
    state: z.string().trim().max(100).optional().nullable(),
    postalCode: z.string().trim().max(30).optional().nullable(),
    country: z.string().trim().max(10).optional().default('DE'),
    billingEmail: z.string().trim().email('Invalid billing email').optional().nullable().or(z.literal('')),
    billingAddress: z.string().trim().max(255).optional().nullable(),
    logoUrl: z.string().trim().url('Invalid logo URL').optional().nullable().or(z.literal('')),
    logoPublicId: z.string().trim().optional().nullable(),
    bannerUrl: z.string().trim().url('Invalid banner URL').optional().nullable().or(z.literal('')),
    bannerPublicId: z.string().trim().optional().nullable(),
    promoVideoUrl: z
      .string()
      .trim()
      .refine(
        (val) => !val || isValidVideoUrl(val),
        { message: 'Promotional video must be a valid YouTube, Vimeo, or Cloudinary video link' }
      )
      .optional()
      .nullable()
      .or(z.literal('')),
    promoVideoPublicId: z.string().trim().optional().nullable(),
    initialAdminEmail: z.string().trim().email('Invalid initial admin email').optional().nullable().or(z.literal('')),
    initialAdminFirstName: z.string().trim().max(100).optional().nullable(),
    initialAdminLastName: z.string().trim().max(100).optional().nullable(),
    documents: z.array(
      z.object({
        documentDefinitionId: z.string().uuid().optional().nullable(),
        name: z.string().trim().min(1, 'Document name is required'),
        fileUrl: z.string().trim().url('Invalid document file URL'),
        publicId: z.string().trim().optional().nullable(),
        fileSizeBytes: z.number().int().optional().nullable(),
        mimeType: z.string().trim().optional().nullable(),
        isPrivate: z.boolean().optional().default(true),
      })
    ).optional().default([]),
  }),
};

export const updateCompanySchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
  }),
  body: z.object({
    name: z.string().trim().min(2, 'Company name must be at least 2 characters').max(150).optional(),
    legalName: z.string().trim().max(150).optional().nullable(),
    taxId: z.string().trim().max(50).optional().nullable(),
    companyCode: z.string().trim().max(50).optional().nullable(),
    registrationNumber: z.string().trim().max(50).optional().nullable(),
    industryId: z.string().uuid('Invalid industry ID').optional().nullable(),
    subIndustryId: z.string().uuid('Invalid sub-industry ID').optional().nullable(),
    companySize: companySizeEnum.optional().nullable(),
    foundedYear: z.coerce.number().int().min(1800).max(new Date().getFullYear() + 1).optional().nullable(),
    description: z.string().trim().max(2000).optional().nullable(),
    hiringDomestic: z.boolean().optional(),
    hiringInternational: z.boolean().optional(),
    hiringEu: z.boolean().optional(),
    email: z.string().trim().email('Invalid email address').optional().nullable().or(z.literal('')),
    hrEmail: z.string().trim().email('Invalid HR email address').optional().nullable().or(z.literal('')),
    supportEmail: z.string().trim().email('Invalid support email address').optional().nullable().or(z.literal('')),
    phone: z.string().trim().max(30).optional().nullable(),
    alternatePhone: z.string().trim().max(30).optional().nullable(),
    website: z.string().trim().url('Invalid website URL').optional().nullable().or(z.literal('')),
    addressLine1: z.string().trim().max(255).optional().nullable(),
    addressLine2: z.string().trim().max(255).optional().nullable(),
    city: z.string().trim().max(100).optional().nullable(),
    state: z.string().trim().max(100).optional().nullable(),
    postalCode: z.string().trim().max(30).optional().nullable(),
    country: z.string().trim().max(10).optional(),
    billingEmail: z.string().trim().email('Invalid billing email').optional().nullable().or(z.literal('')),
    billingAddress: z.string().trim().max(255).optional().nullable(),
    logoUrl: z.string().trim().url('Invalid logo URL').optional().nullable().or(z.literal('')),
    logoPublicId: z.string().trim().optional().nullable(),
    bannerUrl: z.string().trim().url('Invalid banner URL').optional().nullable().or(z.literal('')),
    bannerPublicId: z.string().trim().optional().nullable(),
    promoVideoUrl: z
      .string()
      .trim()
      .refine(
        (val) => !val || isValidVideoUrl(val),
        { message: 'Promotional video must be a valid YouTube, Vimeo, or Cloudinary video link' }
      )
      .optional()
      .nullable()
      .or(z.literal('')),
    promoVideoPublicId: z.string().trim().optional().nullable(),
  }),
};

export const updateCompanyStatusSchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
  }),
  body: z.object({
    status: companyStatusEnum,
    reason: z.string().trim().max(1000).optional().nullable(),
  }),
};

export const companyReviewDecisionSchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
  }),
  body: z.object({
    decision: z.enum(['APPROVE', 'REJECT']),
    notes: z.string().trim().max(2000).optional().nullable(),
    rejectionReason: z.string().trim().max(1000).optional().nullable(),
  }),
};

export const createCompanyDocumentSchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
  }),
  body: z.object({
    documentDefinitionId: z.string().uuid('Invalid document definition ID').optional().nullable(),
    name: z.string().trim().min(1, 'Document name is required').max(200),
    fileUrl: z.string().trim().url('Invalid document file URL'),
    publicId: z.string().trim().optional().nullable(),
    fileSizeBytes: z.number().int().optional().nullable(),
    mimeType: z.string().trim().optional().nullable(),
    isPrivate: z.boolean().optional().default(true),
  }),
};

export const reviewDocumentSchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
    documentId: z.string().uuid('Invalid document ID format'),
  }),
  body: z.object({
    decision: z.enum(['APPROVE', 'REJECT']),
    rejectionReason: z.string().trim().max(1000).optional().nullable(),
  }),
};

export const sendCompanyInvitationSchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
  }),
  body: z.object({
    email: z.string().trim().email('Invalid email address'),
    role: companyUserRoleEnum.optional().default('ADMIN'),
    firstName: z.string().trim().max(100).optional().nullable(),
    lastName: z.string().trim().max(100).optional().nullable(),
  }),
};

export const directUploadSignSchema = {
  body: z.object({
    folder: z.string().trim().optional(),
    resourceType: z.enum(['image', 'raw', 'video', 'auto']).optional().default('auto'),
    isPrivate: z.boolean().optional().default(false),
  }),
};

export const deleteCompanySchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
  }),
  query: z.object({
    mode: z.enum(['MOVE_TO_TRASH', 'DELETE_PERMANENTLY']).optional().default('MOVE_TO_TRASH'),
  }),
};

export const restoreCompanySchema = {
  params: z.object({
    id: z.string().uuid('Invalid company ID format'),
  }),
};

export const verifyInvitationSchema = {
  query: z.object({
    token: z.string().trim().min(1, 'Invitation token is required'),
  }),
};

export const activateInvitationSchema = {
  body: z.object({
    token: z.string().trim().min(1, 'Invitation token is required'),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    password: z.string().min(8, 'Password must be at least 8 characters').optional(),
  }),
};
