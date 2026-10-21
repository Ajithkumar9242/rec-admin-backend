import { Router } from 'express';
import { NotificationController } from './notification.controller.js';
import { authenticateSession, require2FAVerified, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  registerDeviceSchema,
  unregisterDeviceSchema,
  listNotificationsSchema,
  markReadSchema,
  testSendNotificationSchema,
} from './notification.validation.js';

const router = Router();

// All notification endpoints strictly require an active, 2FA-verified admin session
router.use(authenticateSession);
router.use(require2FAVerified);

// Device token registration & unregistration (scoped strictly to authenticated admin)
router.post(
  '/devices/register',
  validate(registerDeviceSchema),
  NotificationController.registerDevice
);

router.post(
  '/devices/unregister',
  validate(unregisterDeviceSchema),
  NotificationController.unregisterDevice
);

// Push configuration diagnostic status (safe, no secrets)
router.get(
  '/config-status',
  NotificationController.getConfigStatus
);

// Unread count quick lookup (placed before parameterized routes)
router.get(
  '/unread-count',
  NotificationController.getUnreadCount
);

// Notification inbox list with pagination and read filtering
router.get(
  '/',
  validate(listNotificationsSchema),
  NotificationController.listNotifications
);

// Bulk mark-all-read (placed before /:id/read to prevent route shadowing)
router.patch(
  '/read-all',
  NotificationController.markAllAsRead
);

// Mark single notification as read
router.patch(
  '/:id/read',
  validate(markReadSchema),
  NotificationController.markAsRead
);

// Guarded test-send endpoint strictly restricted to SUPER_ADMIN role
router.post(
  '/test-send',
  requireRole('SUPER_ADMIN'),
  validate(testSendNotificationSchema),
  NotificationController.testSend
);

export default router;
