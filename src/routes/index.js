import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import adminRoutes from '../modules/admin/admin.routes.js';
import billingRoutes from '../modules/billing/billing.routes.js';
import configurationRoutes from '../modules/configuration/configuration.routes.js';
import companyRoutes from '../modules/companies/company.routes.js';
import jobRoutes from '../modules/jobs/job.routes.js';
import candidateRoutes from '../modules/candidates/candidate.routes.js';
import { teamRouter, roleRouter } from '../modules/teams/team.routes.js';
import notificationRoutes from '../modules/notifications/notification.routes.js';

const router = Router();

// Health Check
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'recruitrain-admin-backend',
  });
});

// Mount modules
router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/billing', billingRoutes);
router.use('/configuration', configurationRoutes);
router.use('/companies', companyRoutes);
router.use('/jobs', jobRoutes);
router.use('/candidates', candidateRoutes);
router.use('/teams', teamRouter);
router.use('/roles', roleRouter);
router.use('/notifications', notificationRoutes);

export default router;

