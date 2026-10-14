import { Router } from 'express';
import { AdminController } from './admin.controller.js';
import {
  authenticateSession,
  require2FAVerified,
  requireRole,
} from '../../middleware/auth.js';

import { validate } from '../../middleware/validate.js';
import {
  updateProfileSchema,
  changePasswordSchema,
  dashboardQuerySchema,
  exportQuerySchema,
} from './admin.validation.js';

const router = Router();

// Protected admin shell endpoints
router.use(authenticateSession);
router.use(require2FAVerified);

// Dashboard & Telemetry
router.get('/dashboard', validate(dashboardQuerySchema), AdminController.getDashboard);
router.get('/overview', AdminController.getOverview);

// Security & Audit Logs
router.get('/audit-logs', requireRole('SUPER_ADMIN'), AdminController.getAuditLogs);
router.get('/audit-logs/export', requireRole('SUPER_ADMIN'), validate(exportQuerySchema), AdminController.exportAuditLogs);

// Profile & Account Management
router.patch('/profile', validate(updateProfileSchema), AdminController.updateProfile);
router.post('/change-password', validate(changePasswordSchema), AdminController.changePassword);

export default router;
