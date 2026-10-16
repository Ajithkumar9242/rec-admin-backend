import { z } from 'zod';
import { DANGEROUS_EXTENSIONS } from './candidateVisibilityPolicy.js';

// Common status enum
export const configurationStatusEnum = z.enum(['ACTIVE', 'INACTIVE']);
export const documentTargetTypeEnum = z.enum(['COMPANY', 'CANDIDATE']);
export const stageCategoryEnum = z.enum([
  'SOURCING',
  'SCREENING',
  'INTERVIEW',
  'EVALUATION',
  'OFFER',
  'HIRED',
  'REJECTED',
  'OTHER',
]);

// Helper validator for file types/extensions
const fileTypeItemSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine(
    (val) => {
      const lower = val.toLowerCase();
      // Cannot be dangerous executable/script
      if (DANGEROUS_EXTENSIONS.has(lower)) return false;
      // Must be a valid extension (e.g. .pdf) or valid MIME (e.g. application/pdf)
      return lower.startsWith('.') || lower.includes('/');
    },
    { message: 'File type must be a valid extension (e.g., .pdf) or MIME type (e.g., application/pdf) and cannot be an executable.' }
  );

// --- Industry Schemas ---
export const createIndustrySchema = {
  body: z.object({
    name: z.string().trim().min(2, 'Industry name must be at least 2 characters').max(100),
    code: z.string().trim().max(50).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    parentId: z.string().uuid('Invalid parent industry ID').optional().nullable(),
    status: configurationStatusEnum.optional().default('ACTIVE'),
  }),
};

export const updateIndustrySchema = {
  params: z.object({
    id: z.string().uuid('Invalid industry ID'),
  }),
  body: z.object({
    name: z.string().trim().min(2, 'Industry name must be at least 2 characters').max(100).optional(),
    code: z.string().trim().max(50).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    parentId: z.string().uuid('Invalid parent industry ID').optional().nullable(),
    status: configurationStatusEnum.optional(),
  }),
};

export const toggleIndustryStatusSchema = {
  params: z.object({
    id: z.string().uuid('Invalid industry ID'),
  }),
  body: z.object({
    status: configurationStatusEnum,
  }),
};

export const queryIndustrySchema = {
  query: z.object({
    search: z.string().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).optional().default('ALL'),
    parentId: z.string().optional(),
    hierarchy: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    sortBy: z.enum(['name', 'createdAt', 'status']).optional().default('name'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
  }),
};

// --- Document Definition Schemas ---
export const createDocumentDefinitionSchema = {
  body: z.object({
    targetType: documentTargetTypeEnum,
    name: z.string().trim().min(2, 'Document name must be at least 2 characters').max(100),
    code: z.string().trim().max(50).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    isRequired: z.boolean().optional().default(false),
    acceptedFileTypes: z.array(fileTypeItemSchema).min(1, 'At least one accepted file type is required'),
    maxFileSizeMb: z.number().int().min(1, 'Minimum file size is 1MB').max(100, 'Maximum file size is 100MB').default(10),
    status: configurationStatusEnum.optional().default('ACTIVE'),
  }),
};

export const updateDocumentDefinitionSchema = {
  params: z.object({
    id: z.string().uuid('Invalid document definition ID'),
  }),
  body: z.object({
    name: z.string().trim().min(2, 'Document name must be at least 2 characters').max(100).optional(),
    code: z.string().trim().max(50).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    isRequired: z.boolean().optional(),
    acceptedFileTypes: z.array(fileTypeItemSchema).min(1).optional(),
    maxFileSizeMb: z.number().int().min(1).max(100).optional(),
    status: configurationStatusEnum.optional(),
  }),
};

export const toggleDocumentStatusSchema = {
  params: z.object({
    id: z.string().uuid('Invalid document definition ID'),
  }),
  body: z.object({
    status: configurationStatusEnum,
  }),
};

export const queryDocumentDefinitionSchema = {
  query: z.object({
    targetType: documentTargetTypeEnum.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).optional().default('ALL'),
    search: z.string().optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),
};

// --- Dynamic Recruitment Stages Schemas ---
export const createRecruitmentStageSchema = {
  body: z.object({
    name: z.string().trim().min(2, 'Stage name must be at least 2 characters').max(80),
    description: z.string().trim().max(500).optional().nullable(),
    category: stageCategoryEnum.optional().default('SCREENING'),
    order: z.number().int().min(0).optional(),
    status: configurationStatusEnum.optional().default('ACTIVE'),
  }),
};

export const updateRecruitmentStageSchema = {
  params: z.object({
    id: z.string().uuid('Invalid recruitment stage ID'),
  }),
  body: z.object({
    name: z.string().trim().min(2, 'Stage name must be at least 2 characters').max(80).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    category: stageCategoryEnum.optional(),
    order: z.number().int().min(0).optional(),
    status: configurationStatusEnum.optional(),
  }),
};

export const reorderRecruitmentStagesSchema = {
  body: z.object({
    stages: z.array(
      z.object({
        id: z.string().uuid('Invalid stage ID in reorder list'),
        order: z.number().int().min(0),
      })
    ).min(1, 'Stages list cannot be empty'),
  }),
};

export const toggleStageStatusSchema = {
  params: z.object({
    id: z.string().uuid('Invalid recruitment stage ID'),
  }),
  body: z.object({
    status: configurationStatusEnum,
  }),
};

export const queryRecruitmentStageSchema = {
  query: z.object({
    status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).optional().default('ALL'),
    search: z.string().optional(),
    category: stageCategoryEnum.optional(),
  }),
};

// --- Platform Settings Schemas ---
export const updateCandidateSettingsSchema = {
  body: z.object({
    acceptedResumeFileTypes: z.array(fileTypeItemSchema).min(1, 'At least one accepted resume file type is required'),
    autoApproveCandidateProfiles: z.boolean(),
    showEmployerContactDetails: z.boolean(),
  }),
};

export const updateEmployerVisibilitySchema = {
  body: z.object({
    showCandidateResumes: z.boolean(),
    showCandidateFullName: z.boolean(),
    showCandidateEmail: z.boolean(),
    showCandidatePhone: z.boolean(),
  }),
};

export const updateJobSettingsSchema = {
  body: z.object({
    autoApproveJobs: z.boolean(),
  }),
};
