import { Router } from 'express';
import { ConfigurationController } from './configuration.controller.js';
import {
  authenticateSession,
  require2FAVerified,
  requireRole,
} from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  createIndustrySchema,
  updateIndustrySchema,
  toggleIndustryStatusSchema,
  queryIndustrySchema,
  createDocumentDefinitionSchema,
  updateDocumentDefinitionSchema,
  toggleDocumentStatusSchema,
  queryDocumentDefinitionSchema,
  createRecruitmentStageSchema,
  updateRecruitmentStageSchema,
  reorderRecruitmentStagesSchema,
  toggleStageStatusSchema,
  queryRecruitmentStageSchema,
  updateCandidateSettingsSchema,
  updateEmployerVisibilitySchema,
  updateJobSettingsSchema,
} from './configuration.validation.js';

const router = Router();

// Protect all configuration routes with verified session & 2FA
router.use(authenticateSession);
router.use(require2FAVerified);

// ==========================================
// 1. Industry & Sector Management
// ==========================================
router.get(
  '/industries',
  validate(queryIndustrySchema),
  ConfigurationController.getIndustries
);
router.get(
  '/industries/:id',
  ConfigurationController.getIndustryById
);
router.post(
  '/industries',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(createIndustrySchema),
  ConfigurationController.createIndustry
);
router.patch(
  '/industries/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(updateIndustrySchema),
  ConfigurationController.updateIndustry
);
router.patch(
  '/industries/:id/status',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(toggleIndustryStatusSchema),
  ConfigurationController.toggleIndustryStatus
);
router.delete(
  '/industries/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  ConfigurationController.deleteIndustry
);

// ==========================================
// 2. Company & Candidate Document Definitions
// ==========================================
router.get(
  '/document-definitions',
  validate(queryDocumentDefinitionSchema),
  ConfigurationController.getDocumentDefinitions
);
router.get(
  '/document-definitions/:id',
  ConfigurationController.getDocumentDefinitionById
);
router.post(
  '/document-definitions',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(createDocumentDefinitionSchema),
  ConfigurationController.createDocumentDefinition
);
router.patch(
  '/document-definitions/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(updateDocumentDefinitionSchema),
  ConfigurationController.updateDocumentDefinition
);
router.patch(
  '/document-definitions/:id/status',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(toggleDocumentStatusSchema),
  ConfigurationController.toggleDocumentDefinitionStatus
);
router.delete(
  '/document-definitions/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  ConfigurationController.deleteDocumentDefinition
);

// ==========================================
// 3. Dynamic Recruitment Stages
// ==========================================
router.get(
  '/recruitment-stages',
  validate(queryRecruitmentStageSchema),
  ConfigurationController.getRecruitmentStages
);
router.get(
  '/recruitment-stages/:id',
  ConfigurationController.getRecruitmentStageById
);
router.post(
  '/recruitment-stages',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(createRecruitmentStageSchema),
  ConfigurationController.createRecruitmentStage
);
router.put(
  '/recruitment-stages/reorder',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(reorderRecruitmentStagesSchema),
  ConfigurationController.reorderRecruitmentStages
);
router.patch(
  '/recruitment-stages/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(updateRecruitmentStageSchema),
  ConfigurationController.updateRecruitmentStage
);
router.patch(
  '/recruitment-stages/:id/status',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(toggleStageStatusSchema),
  ConfigurationController.toggleRecruitmentStageStatus
);
router.delete(
  '/recruitment-stages/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  ConfigurationController.deleteRecruitmentStage
);

// ==========================================
// 4. Platform Settings (Candidate, Visibility, Job)
// ==========================================
router.get(
  '/settings',
  ConfigurationController.getPlatformSettings
);
router.patch(
  '/settings/candidate',
  requireRole('SUPER_ADMIN'),
  validate(updateCandidateSettingsSchema),
  ConfigurationController.updateCandidateSettings
);
router.patch(
  '/settings/employer-visibility',
  requireRole('SUPER_ADMIN'),
  validate(updateEmployerVisibilitySchema),
  ConfigurationController.updateEmployerVisibility
);
router.patch(
  '/settings/job',
  requireRole('SUPER_ADMIN'),
  validate(updateJobSettingsSchema),
  ConfigurationController.updateJobSettings
);
router.get(
  '/settings/audit-logs',
  requireRole('SUPER_ADMIN'),
  ConfigurationController.getAuditLogs
);

export default router;
