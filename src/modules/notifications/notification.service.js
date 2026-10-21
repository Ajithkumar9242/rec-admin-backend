import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { sendPushNotification } from '../../lib/firebase.js';

export class NotificationService {
  /**
   * Persists an in-app notification and optionally dispatches an FCM push notification.
   * If FCM push delivery fails or is skipped, the persisted in-app notification remains safely available.
   */
  static async createNotification({
    adminId,
    title,
    body,
    category = 'GENERAL',
    deepLinkUrl,
    linkUrl,
    metadata = null,
    sendPush = true,
  }) {
    if (!adminId) {
      throw new Error('Admin ID is required to create a notification.');
    }
    if (!title || !title.trim()) {
      throw new Error('Notification title is required.');
    }
    if (!body || !body.trim()) {
      throw new Error('Notification body is required.');
    }

    const effectiveDeepLink = (deepLinkUrl || linkUrl || '').trim() || null;

    // 1. Persist the in-app notification first
    const notification = await prisma.adminNotification.create({
      data: {
        adminId,
        title: title.trim(),
        body: body.trim(),
        category: category ? String(category).trim().toUpperCase() : 'GENERAL',
        deepLinkUrl: effectiveDeepLink,
        metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
        isRead: false,
      },
    });

    let deliveryResult = {
      sent: 0,
      failed: 0,
      skipped: true,
      staleTokens: [],
    };

    // 2. Dispatch push notification if requested
    if (sendPush) {
      try {
        const deviceTokens = await prisma.adminDeviceToken.findMany({
          where: { adminId },
          select: { token: true },
        });

        if (deviceTokens.length > 0) {
          const rawTokens = deviceTokens.map((d) => d.token);

          deliveryResult = await sendPushNotification({
            tokens: rawTokens,
            title: notification.title,
            body: notification.body,
            deepLinkUrl: notification.deepLinkUrl,
            metadata: notification.metadata,
          });

          // 3. Remove stale / invalid tokens detected during delivery
          if (deliveryResult.staleTokens && deliveryResult.staleTokens.length > 0) {
            try {
              const deleteRes = await prisma.adminDeviceToken.deleteMany({
                where: {
                  token: { in: deliveryResult.staleTokens },
                },
              });
              logger.info(
                { count: deleteRes.count },
                'Successfully cleaned up stale FCM device tokens'
              );
            } catch (cleanupErr) {
              logger.warn(
                { error: cleanupErr.message },
                'Failed to clean up stale device tokens from database'
              );
            }
          }
        }
      } catch (pushErr) {
        // Safe logging: never log device tokens or credentials
        logger.warn(
          { error: pushErr.message, notificationId: notification.id },
          'Push notification dispatch encountered error, but in-app notification is preserved.'
        );
        deliveryResult = {
          sent: 0,
          failed: 1,
          skipped: false,
          staleTokens: [],
          error: pushErr.message,
        };
      }
    }

    return {
      notification,
      delivery: deliveryResult,
    };
  }

  /**
   * Lists notifications for the authenticated admin with pagination and unread counts.
   */
  static async listNotifications({ adminId, page = 1, limit = 20, isRead }) {
    if (!adminId) {
      throw new Error('Admin ID is required to list notifications.');
    }

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;

    const where = { adminId };
    if (typeof isRead === 'boolean') {
      where.isRead = isRead;
    }

    const [items, total, unreadCount] = await Promise.all([
      prisma.adminNotification.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.adminNotification.count({ where }),
      prisma.adminNotification.count({
        where: { adminId, isRead: false },
      }),
    ]);

    const totalPages = Math.ceil(total / safeLimit) || 1;

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages,
        unreadCount,
      },
    };
  }

  /**
   * Retrieves the count of unread notifications for the authenticated admin.
   */
  static async getUnreadCount(adminId) {
    if (!adminId) {
      throw new Error('Admin ID is required.');
    }

    const unreadCount = await prisma.adminNotification.count({
      where: { adminId, isRead: false },
    });

    return { unreadCount };
  }

  /**
   * Marks a single notification as read, enforcing strict admin ownership.
   */
  static async markAsRead({ adminId, notificationId }) {
    if (!adminId || !notificationId) {
      const err = new Error('Admin ID and Notification ID are required.');
      err.status = 400;
      throw err;
    }

    const existing = await prisma.adminNotification.findUnique({
      where: { id: notificationId },
    });

    if (!existing) {
      const err = new Error('Notification not found.');
      err.status = 404;
      throw err;
    }

    if (existing.adminId !== adminId) {
      const err = new Error('Forbidden: You do not have permission to access this notification.');
      err.status = 403;
      throw err;
    }

    const updated = await prisma.adminNotification.update({
      where: { id: notificationId },
      data: {
        isRead: true,
        readAt: existing.readAt || new Date(),
      },
    });

    return updated;
  }

  /**
   * Marks all notifications for the authenticated admin as read.
   */
  static async markAllAsRead(adminId) {
    if (!adminId) {
      const err = new Error('Admin ID is required.');
      err.status = 400;
      throw err;
    }

    const now = new Date();
    const result = await prisma.adminNotification.updateMany({
      where: { adminId, isRead: false },
      data: {
        isRead: true,
        readAt: now,
      },
    });

    return {
      updatedCount: result.count,
    };
  }

  /**
   * Registers or updates an FCM device token for the authenticated admin.
   * Device tokens are treated as sensitive credentials and never exposed in responses or logs.
   */
  static async registerDeviceToken({ adminId, token, platform = 'WEB', userAgent }) {
    if (!adminId) {
      const err = new Error('Admin ID is required.');
      err.status = 401;
      throw err;
    }
    if (!token || typeof token !== 'string' || !token.trim()) {
      const err = new Error('FCM device token is required.');
      err.status = 400;
      throw err;
    }

    const trimmedToken = token.trim();
    const normalizedPlatform = ['WEB', 'IOS', 'ANDROID'].includes(platform)
      ? platform
      : 'WEB';

    const device = await prisma.adminDeviceToken.upsert({
      where: { token: trimmedToken },
      update: {
        adminId,
        platform: normalizedPlatform,
        userAgent: userAgent || null,
        lastUsedAt: new Date(),
      },
      create: {
        adminId,
        token: trimmedToken,
        platform: normalizedPlatform,
        userAgent: userAgent || null,
        lastUsedAt: new Date(),
      },
      select: {
        id: true,
        platform: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });

    return {
      id: device.id,
      platform: device.platform,
      lastUsedAt: device.lastUsedAt,
    };
  }

  /**
   * Unregisters an FCM device token for the authenticated admin, enforcing ownership.
   */
  static async unregisterDeviceToken({ adminId, token }) {
    if (!adminId) {
      const err = new Error('Admin ID is required.');
      err.status = 401;
      throw err;
    }
    if (!token || typeof token !== 'string' || !token.trim()) {
      const err = new Error('FCM device token is required.');
      err.status = 400;
      throw err;
    }

    const trimmedToken = token.trim();

    const existing = await prisma.adminDeviceToken.findUnique({
      where: { token: trimmedToken },
      select: { id: true, adminId: true },
    });

    if (!existing) {
      const err = new Error('Device token not found.');
      err.status = 404;
      throw err;
    }

    if (existing.adminId !== adminId) {
      const err = new Error('Forbidden: You do not have permission to unregister this device token.');
      err.status = 403;
      throw err;
    }

    await prisma.adminDeviceToken.delete({
      where: { id: existing.id },
    });

    return {
      unregistered: true,
    };
  }
}
