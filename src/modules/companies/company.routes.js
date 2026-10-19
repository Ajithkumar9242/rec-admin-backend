import { Router } from 'express';
import multer from 'multer';
import { CompanyController } from './company.controller.js';
import {
  authenticateSession,
  require2FAVerified,
  requireRole,
} from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { invitationLimiter } from '../../middleware/rateLimiter.js';
import {
  listCompaniesSchema,
  getCompanyByIdSchema,
  createCompanySchema,
  updateCompanySchema,
  updateCompanyStatusSchema,
  companyReviewDecisionSchema,
  createCompanyDocumentSchema,
  reviewDocumentSchema,
  sendCompanyInvitationSchema,
  directUploadSignSchema,
  deleteCompanySchema,
  restoreCompanySchema,
  verifyInvitationSchema,
  activateInvitationSchema,
} from './company.validation.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB ceiling for multipart buffer before validation
  },
});

const router = Router();

// ----------------------------------------------------
// Public Invitation Verification & Activation (Rate-limited, no admin session required)
// ----------------------------------------------------
router.get(
  '/invitations/verify',
  invitationLimiter,
  validate(verifyInvitationSchema),
  CompanyController.verifyInvitation
);

router.post(
  '/invitations/activate',
  invitationLimiter,
  validate(activateInvitationSchema),
  CompanyController.activateInvitation
);

// Protect all remaining company management routes with verified session & 2FA
router.use(authenticateSession);
router.use(require2FAVerified);

// ----------------------------------------------------
// Integrations & Status summaries
// ----------------------------------------------------
router.get(
  '/status-summary',
  requirePermission('COMPANIES', 'READ'),
  CompanyController.getStatusSummary
);

router.get(
  '/integrations-status',
  requirePermission('COMPANIES', 'READ'),
  CompanyController.getIntegrationsStatus
);

router.post(
  '/upload-signature',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'EDIT'),
  validate(directUploadSignSchema),
  CompanyController.getUploadSignature
);

// File asset uploads (logo, banner, staging compliance document)
router.post(
  '/upload',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'EDIT'),
  upload.single('file'),
  CompanyController.uploadAsset
);

// ----------------------------------------------------
// Company CRUD & Management
// ----------------------------------------------------
router.get(
  '/',
  requirePermission('COMPANIES', 'READ'),
  validate(listCompaniesSchema),
  CompanyController.listCompanies
);

router.post(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'CREATE'),
  validate(createCompanySchema),
  CompanyController.createCompany
);

router.get(
  '/:id',
  requirePermission('COMPANIES', 'READ'),
  validate(getCompanyByIdSchema),
  CompanyController.getCompanyById
);

router.put(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'EDIT'),
  validate(updateCompanySchema),
  CompanyController.updateCompany
);

router.patch(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'EDIT'),
  validate(updateCompanySchema),
  CompanyController.updateCompany
);

router.delete(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'DELETE'),
  validate(deleteCompanySchema),
  CompanyController.deleteCompany
);

router.post(
  '/:id/restore',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'EDIT'),
  validate(restoreCompanySchema),
  CompanyController.restoreCompany
);

router.patch(
  '/:id/status',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'EDIT'),
  validate(updateCompanyStatusSchema),
  CompanyController.updateCompanyStatus
);

router.post(
  '/:id/review',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'EDIT'),
  validate(companyReviewDecisionSchema),
  CompanyController.reviewCompany
);

// ----------------------------------------------------
// Documents
// ----------------------------------------------------
router.post(
  '/:id/documents',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'CREATE'),
  validate(createCompanyDocumentSchema),
  CompanyController.addCompanyDocument
);

router.post(
  '/:id/documents/upload',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'CREATE'),
  upload.single('file'),
  CompanyController.uploadAsset
);

router.patch(
  '/:id/documents/:documentId/review',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'EDIT'),
  validate(reviewDocumentSchema),
  CompanyController.reviewCompanyDocument
);

router.delete(
  '/:id/documents/:documentId',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('COMPANIES', 'DELETE'),
  CompanyController.deleteCompanyDocument
);

router.get(
  '/:id/documents/:documentId/download',
  requirePermission('COMPANIES', 'READ'),
  CompanyController.getDocumentDownloadUrl
);

router.get(
  '/:id/documents/:documentId/file',
  requirePermission('COMPANIES', 'READ'),
  CompanyController.streamCompanyDocument
);

router.get(
  '/:id/documents/:documentId/preview',
  requirePermission('COMPANIES', 'READ'),
  (req, res, next) => {
    req.query.disposition = 'inline';
    return CompanyController.streamCompanyDocument(req, res, next);
  }
);

// ----------------------------------------------------
// Invitations & Team
// ----------------------------------------------------
router.post(
  '/:id/invitations',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('TEAMS', 'CREATE'),
  validate(sendCompanyInvitationSchema),
  CompanyController.sendCompanyInvitation
);

router.post(
  '/:id/invitations/:invitationId/resend',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requirePermission('TEAMS', 'CREATE'),
  CompanyController.resendCompanyInvitation
);

export default router;
