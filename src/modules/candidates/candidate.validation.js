import { z } from 'zod';

export const candidateRegisterSchema = z.object({
  body: z.object({
    email: z.string().transform((v) => v.trim().toLowerCase()).pipe(z.string().email('Please provide a valid email address')),
    password: z.string().min(8, 'Password must be at least 8 characters long'),
    firstName: z.string().min(1, 'First name is required').trim(),
    middleName: z.string().trim().optional().nullable(),
    lastName: z.string().min(1, 'Last name is required').trim(),
    phone: z.string().trim().optional().nullable(),
    currentLocation: z.string().trim().optional().nullable(),
    country: z.string().trim().optional().default('DE'),
  }),
});

export const candidateLoginSchema = z.object({
  body: z.object({
    email: z.string().transform((v) => v.trim().toLowerCase()).pipe(z.string().email('Please provide a valid email address')),
    password: z.string().min(1, 'Password is required'),
  }),
});

export const candidateForgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().transform((v) => v.trim().toLowerCase()).pipe(z.string().email('Please provide a valid email address')),
  }),
});

export const candidateResetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Reset token is required'),
    password: z.string().min(8, 'Password must be at least 8 characters long'),
  }),
});

export const updateCandidateProfileSchema = z.object({
  body: z.object({
    // Personal Details
    firstName: z.string().min(1, 'First name is required').trim().optional(),
    middleName: z.string().trim().optional().nullable(),
    lastName: z.string().min(1, 'Last name is required').trim().optional(),
    phone: z.string().trim().optional().nullable(),
    alternateMobile: z.string().trim().optional().nullable(),
    dateOfBirth: z.string().datetime({ offset: true }).optional().nullable().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().nullable()),
    gender: z.string().trim().optional().nullable(),
    maritalStatus: z.string().trim().optional().nullable(),
    nationality: z.string().trim().optional().nullable(),

    // Address
    addressLine1: z.string().trim().optional().nullable(),
    addressLine2: z.string().trim().optional().nullable(),
    city: z.string().trim().optional().nullable(),
    state: z.string().trim().optional().nullable(),
    postalCode: z.string().trim().optional().nullable(),
    country: z.string().trim().optional().default('DE'),

    // Professional Background
    profession: z.string().trim().optional().nullable(),
    employmentType: z.string().trim().optional().nullable(),
    currentJobTitle: z.string().trim().optional().nullable(),
    currentCompany: z.string().trim().optional().nullable(),
    yearsOfExperience: z.coerce.number().min(0).max(99).optional().nullable(),
    noticePeriodDays: z.coerce.number().int().min(0).optional().nullable(),
    currentSalary: z.coerce.number().min(0).optional().nullable(),
    expectedSalary: z.coerce.number().min(0).optional().nullable(),
    preferredLocation: z.string().trim().optional().nullable(),
    willingToRelocate: z.boolean().optional(),
    headline: z.string().trim().optional().nullable(),
    summary: z.string().trim().optional().nullable(),
    currentLocation: z.string().trim().optional().nullable(),

    // Work Authorization
    passportNumber: z.string().trim().optional().nullable(),
    passportExpiryDate: z.string().datetime({ offset: true }).optional().nullable().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().nullable()),
    visaStatus: z.string().trim().optional().nullable(),
    workPermitAuthorized: z.boolean().optional(),

    // Online Profiles
    linkedinUrl: z.string().url('Invalid LinkedIn URL').trim().optional().nullable().or(z.literal('')),
    portfolioUrl: z.string().url('Invalid Portfolio URL').trim().optional().nullable().or(z.literal('')),
    githubUrl: z.string().url('Invalid GitHub URL').trim().optional().nullable().or(z.literal('')),
    // Company Association
    companyId: z.string().uuid('Invalid company ID format').optional().nullable().or(z.literal('')),
  }),
});

export const adminCreateCandidateSchema = z.object({
  body: z.object({
    // A. Identity and account information
    email: z.string().transform((v) => v.trim().toLowerCase()).pipe(z.string().email('Please provide a valid email address')),
    firstName: z.string().min(1, 'First name is required').trim(),
    middleName: z.string().trim().optional().nullable(),
    lastName: z.string().min(1, 'Last name is required').trim(),
    phone: z.string().trim().optional().nullable(),
    alternateMobile: z.string().trim().optional().nullable(),
    status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'INACTIVE', 'SUSPENDED']).optional().default('ACTIVE'),
    sendInvitation: z.preprocess((val) => val === true || val === 'true' || val === undefined, z.boolean()).optional().default(true),

    // B. Company association
    companyId: z.string().uuid('Invalid company ID format').optional().nullable().or(z.literal('')),

    // C. Personal information
    dateOfBirth: z.string().datetime({ offset: true }).optional().nullable().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().nullable()),
    gender: z.string().trim().optional().nullable(),
    maritalStatus: z.string().trim().optional().nullable(),
    nationality: z.string().trim().optional().nullable(),

    // D. Professional information
    profession: z.string().trim().optional().nullable(),
    employmentType: z.string().trim().optional().nullable(),
    currentJobTitle: z.string().trim().optional().nullable(),
    currentCompany: z.string().trim().optional().nullable(),
    yearsOfExperience: z.coerce.number().min(0).max(99).optional().nullable(),
    noticePeriodDays: z.coerce.number().int().min(0).optional().nullable(),
    currentSalary: z.coerce.number().min(0).optional().nullable(),
    expectedSalary: z.coerce.number().min(0).optional().nullable(),
    preferredLocation: z.string().trim().optional().nullable(),
    willingToRelocate: z.preprocess((val) => val === true || val === 'true', z.boolean()).optional(),
    headline: z.string().trim().optional().nullable(),
    summary: z.string().trim().optional().nullable(),
    currentLocation: z.string().trim().optional().nullable(),
    source: z.string().trim().optional().default('ADMIN'),

    // E. Address
    addressLine1: z.string().trim().optional().nullable(),
    addressLine2: z.string().trim().optional().nullable(),
    city: z.string().trim().optional().nullable(),
    state: z.string().trim().optional().nullable(),
    country: z.string().trim().optional().default('DE'),
    postalCode: z.string().trim().optional().nullable(),

    // F. Passport and work authorization
    passportNumber: z.string().trim().optional().nullable(),
    passportExpiryDate: z.string().datetime({ offset: true }).optional().nullable().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().nullable()),
    visaStatus: z.string().trim().optional().nullable(),
    workPermitAuthorized: z.preprocess((val) => val === true || val === 'true', z.boolean()).optional().default(false),

    // G. Online profiles
    linkedinUrl: z.string().url('Invalid LinkedIn URL').trim().optional().nullable().or(z.literal('')),
    portfolioUrl: z.string().url('Invalid Portfolio URL').trim().optional().nullable().or(z.literal('')),
    githubUrl: z.string().url('Invalid GitHub URL').trim().optional().nullable().or(z.literal('')),
  }),
});

export const candidateVerifyInvitationSchema = z.object({
  query: z.object({
    token: z.string().trim().min(1, 'Invitation token is required'),
  }),
});

export const candidateActivateInvitationSchema = z.object({
  body: z.object({
    token: z.string().trim().min(1, 'Invitation token is required'),
    password: z.string().min(8, 'Password must be at least 8 characters long'),
    firstName: z.string().trim().optional(),
    lastName: z.string().trim().optional(),
  }),
});

export const adminUpdateCandidateStatusSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid candidate ID format'),
  }),
  body: z.object({
    status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'INACTIVE', 'SUSPENDED']),
  }),
});

export const listCandidatesSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().optional(),
    status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
    country: z.string().trim().optional(),
    profession: z.string().trim().optional(),
    minExperience: z.coerce.number().min(0).optional(),
    maxExperience: z.coerce.number().min(0).optional(),
    inTrash: z.preprocess((val) => val === true || val === 'true', z.boolean()).default(false),
    sortBy: z.enum(['createdAt', 'updatedAt', 'lastName', 'yearsOfExperience', 'profileCompletion']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

export const candidateIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid candidate ID format'),
  }),
});

export const jobIdParamSchema = z.object({
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format'),
  }),
});
