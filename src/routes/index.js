import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import adminRoutes from '../modules/admin/admin.routes.js';

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

export default router;
