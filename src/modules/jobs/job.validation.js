import { z } from 'zod';

export const jobWorkArrangementEnum = z.enum(['REMOTE', 'HYBRID', 'ON_SITE']);
export const jobEmploymentTypeEnum = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP']);
export const jobHiringScopeEnum = z.enum(['DOMESTIC', 'EU', 'INTERNATIONAL']);
export const jobStatusEnum = z.enum(['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'CLOSED', 'ARCHIVED']);

export const createJobSchema = {
  body: z.object({
    companyId: z.string().uuid('Invalid company ID format'),
    title: z.string().trim().min(3, 'Title must be at least 3 characters').max(200),
    slug: z.string().trim().optional(),
    description: z.string().trim().min(10, 'Description must be at least 10 characters'),
    requirements: z.string().trim().optional().nullable(),
    benefits: z.string().trim().optional().nullable(),
    department: z.string().trim().max(100).optional().nullable(),
    location: z.string().trim().max(200).optional().nullable(),
    country: z.string().trim().length(2, 'Country must be a 2-letter ISO code').default('DE'),
    city: z.string().trim().max(100).optional().nullable(),
    workArrangement: jobWorkArrangementEnum.default('ON_SITE'),
    employmentType: jobEmploymentTypeEnum.default('FULL_TIME'),
    hiringScope: jobHiringScopeEnum.default('DOMESTIC'),
    currency: z.string().trim().max(3).default('EUR'),
    minSalary: z.coerce.number().min(0).optional().nullable(),
    maxSalary: z.coerce.number().min(0).optional().nullable(),
    status: jobStatusEnum.default('DRAFT'),
    expiresAt: z.string().datetime().optional().nullable(),
  }),
};

export const updateJobSchema = {
  params: z.object({
    id: z.string().uuid('Invalid job ID format'),
  }),
  body: z.object({
    title: z.string().trim().min(3).max(200).optional(),
    slug: z.string().trim().optional().nullable(),
    description: z.string().trim().min(10).optional(),
    requirements: z.string().trim().optional().nullable(),
    benefits: z.string().trim().optional().nullable(),
    department: z.string().trim().max(100).optional().nullable(),
    location: z.string().trim().max(200).optional().nullable(),
    country: z.string().trim().length(2).optional(),
    city: z.string().trim().max(100).optional().nullable(),
    workArrangement: jobWorkArrangementEnum.optional(),
    employmentType: jobEmploymentTypeEnum.optional(),
    hiringScope: jobHiringScopeEnum.optional(),
    currency: z.string().trim().max(3).optional(),
    minSalary: z.coerce.number().min(0).optional().nullable(),
    maxSalary: z.coerce.number().min(0).optional().nullable(),
    status: jobStatusEnum.optional(),
    expiresAt: z.string().datetime().optional().nullable(),
  }),
};

export const getJobByIdSchema = {
  params: z.object({
    id: z.string().uuid('Invalid job ID format'),
  }),
};

export const listCompanyJobsSchema = {
  params: z.object({
    companyId: z.string().uuid('Invalid company ID format'),
  }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    status: jobStatusEnum.optional(),
    search: z.string().trim().optional(),
    hiringScope: jobHiringScopeEnum.optional(),
  }),
};

export const listPublicJobsSchema = {
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    country: z.string().trim().optional(),
    city: z.string().trim().optional(),
    workArrangement: jobWorkArrangementEnum.optional(),
    employmentType: jobEmploymentTypeEnum.optional(),
    hiringScope: jobHiringScopeEnum.optional(),
    search: z.string().trim().optional(),
  }),
};

export const applyJobSchema = {
  params: z.object({
    id: z.string().uuid('Invalid job ID format'),
  }),
  body: z.object({
    firstName: z.string().trim().min(1, 'First name is required').max(100),
    lastName: z.string().trim().min(1, 'Last name is required').max(100),
    email: z.string().trim().email('Valid email is required'),
    phone: z.string().trim().max(30).optional().nullable(),
    headline: z.string().trim().max(200).optional().nullable(),
    summary: z.string().trim().max(2000).optional().nullable(),
    coverLetter: z.string().trim().max(5000).optional().nullable(),
    currentLocation: z.string().trim().max(100).optional().nullable(),
    country: z.string().trim().max(2).optional(),
    city: z.string().trim().max(100).optional().nullable(),
    willingToRelocate: z.boolean().default(false),
    resumeUrl: z.string().url('Invalid resume URL').optional().nullable(),
    resumeFileName: z.string().trim().optional().nullable(),
    resumeMimeType: z.string().trim().optional().nullable(),
    resumeBuffer: z.any().optional(),
    resumeSize: z.coerce.number().optional(),
  }),
};
