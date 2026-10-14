import { Router } from 'express';
import { AdminController } from './admin.controller.js';
import {
  authenticateSession,
  require2FAVerified,
  requireRole,
} from '../../middleware/auth.js';

const router = Router();

// Protected admin shell endpoints
router.use(authenticateSession);
router.use(require2FAVerified);

router.get('/overview', AdminController.getOverview);
router.get('/audit-logs', requireRole('SUPER_ADMIN'), AdminController.getAuditLogs);

export default router;
