import { z } from 'zod';

export const jobWorkArrangementEnum = z.enum(['REMOTE', 'HYBRID', 'ON_SITE']);
export const jobEmploymentTypeEnum = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP']);
export const jobHiringScopeEnum = z.enum(['DOMESTIC', 'EU', 'INTERNATIONAL']);
export const jobStatusEnum = z.enum(['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'CLOSED', 'ARCHIVED']);
export const languageProficiencyEnum = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

export const createJobSchema = {
  body: z
    .object({
      companyId: z.string().uuid('Invalid company ID format'),
      title: z.string().trim().min(3, 'Title must be at least 3 characters').max(200),
      slug: z.string().trim().optional().nullable(),
      jobCode: z.string().trim().max(50).optional().nullable(),
      industryId: z.string().uuid().optional().nullable(),
      keywords: z
        .array(z.string().trim())
        .or(z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)))
        .optional()
        .default([]),
      description: z.string().trim().min(10, 'Description must be at least 10 characters'),
      responsibilities: z.string().trim().optional().nullable(),
      requirements: z.string().trim().optional().nullable(),
      benefits: z.string().trim().optional().nullable(),
      department: z.string().trim().max(100).optional().nullable(),
      profession: z.string().trim().max(100).optional().nullable(),
      openings: z.coerce.number().int().min(1, 'Number of openings must be at least 1').default(1),
      hiringManagerId: z.string().uuid().optional().nullable(),
      recruiterId: z.string().uuid().optional().nullable(),
      targetJoiningDate: z.coerce.date().optional().nullable(),
      compensationType: z.enum(['ANNUAL', 'MONTHLY', 'HOURLY']).default('ANNUAL'),
      currency: z.string().trim().max(3).default('EUR'),
      minSalary: z.coerce.number().min(0, 'Minimum salary must be non-negative').optional().nullable(),
      maxSalary: z.coerce.number().min(0, 'Maximum salary must be non-negative').optional().nullable(),
      salaryNegotiable: z.boolean().default(false),
      minExperience: z.coerce.number().int().min(0).default(0),
      maxExperience: z.coerce.number().int().min(0).default(5),
      maxApplicantsLimit: z.coerce.number().int().min(1).optional().nullable(),
      autoCloseOnLimit: z.boolean().default(false),
      address: z.string().trim().max(300).optional().nullable(),
      city: z.string().trim().max(100).optional().nullable(),
      state: z.string().trim().max(100).optional().nullable(),
      country: z.string().trim().length(2, 'Country must be a 2-letter ISO code').default('DE'),
      location: z.string().trim().max(200).optional().nullable(),
      workArrangement: jobWorkArrangementEnum.default('ON_SITE'),
      employmentType: jobEmploymentTypeEnum.default('FULL_TIME'),
      hiringScope: z.union([jobHiringScopeEnum, z.array(jobHiringScopeEnum)]).optional(),
      hiringScopes: z.array(jobHiringScopeEnum).min(1, 'At least one hiring scope must be selected').optional(),
      germanLevel: languageProficiencyEnum.optional().nullable(),
      englishLevel: languageProficiencyEnum.optional().nullable(),
      otherLanguages: z.any().optional().nullable(),
      status: jobStatusEnum.default('DRAFT'),
      expiresAt: z.coerce.date().optional().nullable(),
    })
    .refine(
      (data) => {
        if (data.minSalary != null && data.maxSalary != null) {
          return Number(data.minSalary) <= Number(data.maxSalary);
        }
        return true;
      },
      {
        message: 'Minimum salary must not exceed maximum salary',
        path: ['minSalary'],
      }
    )
    .refine(
      (data) => {
        if (data.minExperience != null && data.maxExperience != null) {
          return Number(data.minExperience) <= Number(data.maxExperience);
        }
        return true;
      },
      {
        message: 'Minimum experience must not exceed maximum experience',
        path: ['minExperience'],
      }
    ),
};

export const updateJobSchema = {
  params: z.object({
    id: z.string().uuid('Invalid job ID format'),
  }),
  body: z
    .object({
      companyId: z.string().uuid().optional(),
      title: z.string().trim().min(3).max(200).optional(),
      slug: z.string().trim().optional().nullable(),
      jobCode: z.string().trim().max(50).optional().nullable(),
      industryId: z.string().uuid().optional().nullable(),
      keywords: z
        .array(z.string().trim())
        .or(z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)))
        .optional(),
      description: z.string().trim().min(10).optional(),
      responsibilities: z.string().trim().optional().nullable(),
      requirements: z.string().trim().optional().nullable(),
      benefits: z.string().trim().optional().nullable(),
      department: z.string().trim().max(100).optional().nullable(),
      profession: z.string().trim().max(100).optional().nullable(),
      openings: z.coerce.number().int().min(1).optional(),
      hiringManagerId: z.string().uuid().optional().nullable(),
      recruiterId: z.string().uuid().optional().nullable(),
      targetJoiningDate: z.coerce.date().optional().nullable(),
      compensationType: z.enum(['ANNUAL', 'MONTHLY', 'HOURLY']).optional(),
      currency: z.string().trim().max(3).optional(),
      minSalary: z.coerce.number().min(0).optional().nullable(),
      maxSalary: z.coerce.number().min(0).optional().nullable(),
      salaryNegotiable: z.boolean().optional(),
      minExperience: z.coerce.number().int().min(0).optional(),
      maxExperience: z.coerce.number().int().min(0).optional(),
      maxApplicantsLimit: z.coerce.number().int().min(1).optional().nullable(),
      autoCloseOnLimit: z.boolean().optional(),
      address: z.string().trim().max(300).optional().nullable(),
      city: z.string().trim().max(100).optional().nullable(),
      state: z.string().trim().max(100).optional().nullable(),
      country: z.string().trim().length(2).optional(),
      location: z.string().trim().max(200).optional().nullable(),
      workArrangement: jobWorkArrangementEnum.optional(),
      employmentType: jobEmploymentTypeEnum.optional(),
      hiringScope: z.union([jobHiringScopeEnum, z.array(jobHiringScopeEnum)]).optional(),
      hiringScopes: z.array(jobHiringScopeEnum).min(1, 'At least one hiring scope must be selected').optional(),
      germanLevel: languageProficiencyEnum.optional().nullable(),
      englishLevel: languageProficiencyEnum.optional().nullable(),
      otherLanguages: z.any().optional().nullable(),
      status: jobStatusEnum.optional(),
      expiresAt: z.coerce.date().optional().nullable(),
    })
    .refine(
      (data) => {
        if (data.minSalary != null && data.maxSalary != null) {
          return Number(data.minSalary) <= Number(data.maxSalary);
        }
        return true;
      },
      {
        message: 'Minimum salary must not exceed maximum salary',
        path: ['minSalary'],
      }
    )
    .refine(
      (data) => {
        if (data.minExperience != null && data.maxExperience != null) {
          return Number(data.minExperience) <= Number(data.maxExperience);
        }
        return true;
      },
      {
        message: 'Minimum experience must not exceed maximum experience',
        path: ['minExperience'],
      }
    ),
};

export const getJobByIdSchema = {
  params: z.object({
    id: z.string().uuid('Invalid job ID format'),
  }),
};

export const listAdminJobsSchema = {
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().optional(),
    status: jobStatusEnum.optional(),
    hiringScope: jobHiringScopeEnum.optional(),
    employmentType: jobEmploymentTypeEnum.optional(),
    workArrangement: jobWorkArrangementEnum.optional(),
    companyId: z.string().uuid().optional(),
    sortBy: z.enum(['createdAt', 'title', 'publishedAt', 'status', 'openings', 'deletedAt']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    trashed: z.preprocess((val) => val === true || val === 'true', z.boolean()).optional().default(false),
  }),
};

export const deleteJobSchema = {
  params: z.object({
    id: z.string().uuid('Invalid job ID format'),
  }),
  query: z.object({
    mode: z.enum(['MOVE_TO_TRASH', 'DELETE_PERMANENTLY']).optional().default('MOVE_TO_TRASH'),
  }),
};

export const restoreJobSchema = {
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

export const getJobApplicantsSchema = {
  params: z.object({
    id: z.string().uuid('Invalid job ID format'),
  }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().optional(),
    status: z.enum(['SUBMITTED', 'IN_REVIEW', 'SHORTLISTED', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED']).optional(),
    stageId: z.string().uuid().optional(),
  }),
};

export const updateJobStatusSchema = {
  params: z.object({
    id: z.string().uuid('Invalid job ID format'),
  }),
  body: z.object({
    status: jobStatusEnum,
    reason: z.string().trim().optional().nullable(),
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
