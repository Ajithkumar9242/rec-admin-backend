import { NotificationService } from './notification.service.js';
import { isFirebaseConfigured, getFirebaseAdmin } from '../../lib/firebase.js';
import { env } from '../../config/env.js';

export class NotificationController {
  /**
   * Registers or updates an FCM device token for the authenticated admin.
   * Device tokens are sensitive and never echoed back in the response.
   */
  static async registerDevice(req, res, next) {
    try {
      const adminId = req.admin.id;
      const { token, platform, userAgent } = req.body;

      const device = await NotificationService.registerDeviceToken({
        adminId,
        token,
        platform,
        userAgent: userAgent || req.get('user-agent'),
      });

      return res.status(200).json({
        success: true,
        message: 'Device token registered successfully.',
        data: {
          id: device.id,
          platform: device.platform,
          lastUsedAt: device.lastUsedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Unregisters an FCM device token for the authenticated admin.
   */
  static async unregisterDevice(req, res, next) {
    try {
      const adminId = req.admin.id;
      const { token } = req.body;

      await NotificationService.unregisterDeviceToken({
        adminId,
        token,
      });

      return res.status(200).json({
        success: true,
        message: 'Device token unregistered successfully.',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Lists notifications for the authenticated admin with pagination and unread counts.
   */
  static async listNotifications(req, res, next) {
    try {
      const adminId = req.admin.id;
      const { page, limit, isRead } = req.query;

      const result = await NotificationService.listNotifications({
        adminId,
        page,
        limit,
        isRead,
      });

      return res.status(200).json({
        success: true,
        data: result.items,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Retrieves the unread notification count for the authenticated admin.
   */
  static async getUnreadCount(req, res, next) {
    try {
      const adminId = req.admin.id;
      const result = await NotificationService.getUnreadCount(adminId);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Marks a single notification as read, enforcing admin ownership.
   */
  static async markAsRead(req, res, next) {
    try {
      const adminId = req.admin.id;
      const { id } = req.params;

      const notification = await NotificationService.markAsRead({
        adminId,
        notificationId: id,
      });

      return res.status(200).json({
        success: true,
        message: 'Notification marked as read.',
        data: notification,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Marks all unread notifications as read for the authenticated admin.
   */
  static async markAllAsRead(req, res, next) {
    try {
      const adminId = req.admin.id;
      const result = await NotificationService.markAllAsRead(adminId);

      return res.status(200).json({
        success: true,
        message: 'All notifications marked as read.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Test-send endpoint guarded by Super Admin role / explicit administrative permission.
   * Never exposed unauthenticated.
   */
  static async testSend(req, res, next) {
    try {
      const adminId = req.admin.id;
      const { title, body, category, deepLinkUrl, metadata } = req.body;

      const result = await NotificationService.createNotification({
        adminId,
        title,
        body,
        category,
        deepLinkUrl,
        metadata,
        sendPush: true,
      });

      let statusMessage = 'Test notification created and processed.';
      if (result.delivery.sent > 0) {
        statusMessage = 'Test notification created and push delivered successfully.';
      } else if (result.delivery.failed > 0) {
        const errorDetail = result.delivery.errorCodes?.length
          ? ` (${result.delivery.errorCodes.join(', ')})`
          : '';
        statusMessage = `Notification saved to inbox, but browser push delivery failed${errorDetail}.`;
      } else if (result.delivery.skipped) {
        statusMessage = 'Notification saved to inbox. Browser push skipped (no device tokens or push unconfigured).';
      }

      return res.status(201).json({
        success: true,
        message: statusMessage,
        data: {
          notification: result.notification,
          delivery: result.delivery,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Retrieves safe push notification configuration diagnostic status.
   * Never exposes credentials, private keys, or tokens.
   */
  static async getConfigStatus(req, res, next) {
    try {
      const isConfigured = isFirebaseConfigured();
      let isInitialized = false;
      let errorReason = null;

      if (isConfigured) {
        try {
          const app = getFirebaseAdmin();
          isInitialized = Boolean(app);
          if (!isInitialized) {
            errorReason = 'Firebase Admin initialization failed.';
          }
        } catch (err) {
          isInitialized = false;
          errorReason = 'Firebase Admin initialization threw an exception.';
        }
      } else {
        errorReason = 'Firebase credentials are not configured or are placeholder values.';
      }

      return res.status(200).json({
        success: true,
        data: {
          pushConfigured: isConfigured,
          pushInitialized: isInitialized,
          inboxActive: true,
          projectId: isConfigured ? (env.FIREBASE_PROJECT_ID?.trim() || null) : null,
          reason: errorReason,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
