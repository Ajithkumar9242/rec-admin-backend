import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { env } from '../src/config/env.js';
import { NotificationService } from '../src/modules/notifications/notification.service.js';
import {
  isFirebaseConfigured,
  getFirebaseAdmin,
  _setFirebaseApp,
  _resetFirebaseApp,
} from '../src/lib/firebase.js';

const SUPER_ADMIN_EMAIL = 'notif_super_admin@recruitrain.test';
const STANDARD_ADMIN_EMAIL = 'notif_standard_admin@recruitrain.test';
const SECONDARY_ADMIN_EMAIL = 'notif_secondary_admin@recruitrain.test';
const TEST_PASSWORD = 'NotifSecurePassword123!@#';

describe('RecruiTrain Phase 1: Firebase Push Notifications & In-App Persistence Suite', () => {
  let app;

  let superAdminId;
  let superAdminCookie;

  let standardAdminId;
  let standardAdminCookie;
  let pendingMfaCookie;

  let secondaryAdminId;
  let secondaryAdminCookie;

  async function createTestAdmin(email, role = 'ADMIN') {
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const { secret } = generateTotpSecret(email);
    const encryptedSecret = encryptTotpSecret(secret);

    const admin = await prisma.admin.create({
      data: {
        email,
        name: `Notification Test ${role}`,
        passwordHash,
        role,
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptedSecret,
      },
    });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email, password: TEST_PASSWORD });

    const sessionCookie = loginRes.headers['set-cookie'];

    const code = authenticator.generate(secret);
    const verifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', sessionCookie)
      .send({ adminId: admin.id, code });

    const verifiedCookie = verifyRes.headers['set-cookie'];

    return {
      adminId: admin.id,
      verifiedCookie,
      pendingMfaCookie: sessionCookie,
      secret,
    };
  }

  beforeAll(async () => {
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Clean prior test admins
    const existingAdmins = await prisma.admin.findMany({
      where: {
        email: {
          in: [SUPER_ADMIN_EMAIL, STANDARD_ADMIN_EMAIL, SECONDARY_ADMIN_EMAIL],
        },
      },
      select: { id: true },
    });

    const adminIds = existingAdmins.map((a) => a.id);
    if (adminIds.length > 0) {
      await prisma.adminDeviceToken.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminNotification.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    }

    const superAdmin = await createTestAdmin(SUPER_ADMIN_EMAIL, 'SUPER_ADMIN');
    superAdminId = superAdmin.adminId;
    superAdminCookie = superAdmin.verifiedCookie;

    const standardAdmin = await createTestAdmin(STANDARD_ADMIN_EMAIL, 'ADMIN');
    standardAdminId = standardAdmin.adminId;
    standardAdminCookie = standardAdmin.verifiedCookie;
    pendingMfaCookie = standardAdmin.pendingMfaCookie;

    const secondaryAdmin = await createTestAdmin(SECONDARY_ADMIN_EMAIL, 'ADMIN');
    secondaryAdminId = secondaryAdmin.adminId;
    secondaryAdminCookie = secondaryAdmin.verifiedCookie;
  });

  afterAll(async () => {
    _resetFirebaseApp();

    const adminIds = [superAdminId, standardAdminId, secondaryAdminId].filter(Boolean);
    if (adminIds.length > 0) {
      await prisma.adminDeviceToken.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminNotification.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    }
  });

  beforeEach(async () => {
    _resetFirebaseApp();
  });

  describe('1. Missing Credentials & Firebase Safe Degradation', () => {
    it('detects missing or placeholder credentials and skips push delivery safely', () => {
      const origProjectId = env.FIREBASE_PROJECT_ID;
      try {
        env.FIREBASE_PROJECT_ID = 'placeholder-project';
        expect(isFirebaseConfigured()).toBe(false);
        expect(getFirebaseAdmin()).toBeNull();
      } finally {
        env.FIREBASE_PROJECT_ID = origProjectId;
      }
    });

    it('health endpoint functions normally without Firebase configuration', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    });

    it('persists in-app notification and returns structured skipped result when Firebase is unconfigured', async () => {
      const result = await NotificationService.createNotification({
        adminId: standardAdminId,
        title: 'Platform Maintenance Notice',
        body: 'Scheduled system maintenance on Sunday at 02:00 UTC.',
        category: 'SYSTEM',
        deepLinkUrl: 'https://admin.recruitrain.com/maintenance',
        metadata: { maintenanceId: 'm-101', priority: 'high' },
        sendPush: true,
      });

      expect(result.notification).toBeDefined();
      expect(result.notification.id).toBeDefined();
      expect(result.notification.title).toBe('Platform Maintenance Notice');
      expect(result.notification.category).toBe('SYSTEM');
      expect(result.notification.isRead).toBe(false);
      expect(result.notification.metadata).toEqual({ maintenanceId: 'm-101', priority: 'high' });

      // Structured delivery skipped contract
      expect(result.delivery).toEqual({
        sent: 0,
        failed: 0,
        skipped: true,
        staleTokens: [],
      });
    });
  });

  describe('2. Device Token Registration & Idempotent Upsert', () => {
    const testToken = 'fcm_token_admin1_web_xyz123';

    afterAll(async () => {
      await prisma.adminDeviceToken.deleteMany({
        where: { token: { in: [testToken, 'fcm_token_admin1_ios_xyz456', 'fcm_token_admin2_web_789'] } },
      });
    });

    it('registers a device token for authenticated admin without leaking the token in response', async () => {
      const res = await request(app)
        .post('/api/notifications/devices/register')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie)
        .send({
          token: testToken,
          platform: 'WEB',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.platform).toBe('WEB');

      // Security check: Raw FCM token must never be echoed back in API response
      expect(res.body.data.token).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(testToken);

      // Verify DB record
      const dbRecord = await prisma.adminDeviceToken.findUnique({
        where: { token: testToken },
      });
      expect(dbRecord).not.toBeNull();
      expect(dbRecord.adminId).toBe(standardAdminId);
      expect(dbRecord.platform).toBe('WEB');
    });

    it('idempotently upserts an existing device token and updates lastUsedAt and platform', async () => {
      const initialRecord = await prisma.adminDeviceToken.findUnique({
        where: { token: testToken },
      });

      // Wait a tiny moment to ensure timestamp change
      await new Promise((r) => setTimeout(r, 50));

      const res = await request(app)
        .post('/api/notifications/devices/register')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie)
        .send({
          token: testToken,
          platform: 'ANDROID',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.platform).toBe('ANDROID');

      const updatedRecord = await prisma.adminDeviceToken.findUnique({
        where: { token: testToken },
      });
      expect(updatedRecord.id).toBe(initialRecord.id);
      expect(updatedRecord.platform).toBe('ANDROID');
      expect(new Date(updatedRecord.lastUsedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(initialRecord.lastUsedAt).getTime()
      );

      // Total records for this token is exactly 1 (no duplicates)
      const count = await prisma.adminDeviceToken.count({
        where: { token: testToken },
      });
      expect(count).toBe(1);
    });

    it('rejects invalid platform enum values with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/notifications/devices/register')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie)
        .send({
          token: 'fcm_invalid_platform_token',
          platform: 'SMART_TV',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('3. Device Token Unregistration & Ownership Checks', () => {
    const tokenAdmin1 = 'fcm_token_admin1_to_unregister';
    const tokenAdmin2 = 'fcm_token_admin2_owned';

    beforeAll(async () => {
      await prisma.adminDeviceToken.createMany({
        data: [
          { adminId: standardAdminId, token: tokenAdmin1, platform: 'WEB' },
          { adminId: secondaryAdminId, token: tokenAdmin2, platform: 'WEB' },
        ],
      });
    });

    afterAll(async () => {
      await prisma.adminDeviceToken.deleteMany({
        where: { token: { in: [tokenAdmin1, tokenAdmin2] } },
      });
    });

    it('rejects unregistering a device token owned by another admin with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/notifications/devices/unregister')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie)
        .send({ token: tokenAdmin2 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden');

      // Verify token still exists in DB
      const exists = await prisma.adminDeviceToken.findUnique({
        where: { token: tokenAdmin2 },
      });
      expect(exists).not.toBeNull();
    });

    it('returns 404 when unregistering a non-existent device token', async () => {
      const res = await request(app)
        .post('/api/notifications/devices/unregister')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie)
        .send({ token: 'fcm_non_existent_token_000' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('successfully unregisters a device token owned by authenticated admin', async () => {
      const res = await request(app)
        .post('/api/notifications/devices/unregister')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie)
        .send({ token: tokenAdmin1 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const exists = await prisma.adminDeviceToken.findUnique({
        where: { token: tokenAdmin1 },
      });
      expect(exists).toBeNull();
    });
  });

  describe('4. Inbox Pagination, Unread Counts & Scoped Isolation', () => {
    beforeAll(async () => {
      // Clean notifications for these admins
      await prisma.adminNotification.deleteMany({
        where: { adminId: { in: [standardAdminId, secondaryAdminId] } },
      });

      // Create 5 notifications for Admin 1 (3 unread, 2 read)
      for (let i = 1; i <= 5; i++) {
        await prisma.adminNotification.create({
          data: {
            adminId: standardAdminId,
            title: `Admin 1 Notification #${i}`,
            body: `Details for item ${i}`,
            category: i % 2 === 0 ? 'BILLING' : 'SECURITY',
            isRead: i > 3, // items 4 and 5 are read
            readAt: i > 3 ? new Date() : null,
            createdAt: new Date(Date.now() - (6 - i) * 60000),
          },
        });
      }

      // Create 2 notifications for Admin 2
      for (let i = 1; i <= 2; i++) {
        await prisma.adminNotification.create({
          data: {
            adminId: secondaryAdminId,
            title: `Admin 2 Notification #${i}`,
            body: `Details for admin 2 item ${i}`,
            category: 'GENERAL',
            isRead: false,
          },
        });
      }
    });

    it('returns paginated inbox strictly scoped to the authenticated admin', async () => {
      const res = await request(app)
        .get('/api/notifications?page=1&limit=2')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 5,
        totalPages: 3,
        unreadCount: 3,
      });

      // Verify all items belong exclusively to standardAdminId
      for (const item of res.body.data) {
        expect(item.adminId).toBe(standardAdminId);
      }
    });

    it('supports isRead filter in inbox list', async () => {
      const res = await request(app)
        .get('/api/notifications?isRead=false')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
      for (const item of res.body.data) {
        expect(item.isRead).toBe(false);
      }
    });

    it('returns quick unread count lookup for authenticated admin', async () => {
      const res = await request(app)
        .get('/api/notifications/unread-count')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.unreadCount).toBe(3);

      // Verify Admin 2 unread count is independent
      const res2 = await request(app)
        .get('/api/notifications/unread-count')
        .set('Cookie', secondaryAdminCookie);

      expect(res2.status).toBe(200);
      expect(res2.body.data.unreadCount).toBe(2);
    });
  });

  describe('5. Mark as Read & Mark All as Read Workflow', () => {
    let unreadNotifId;

    beforeAll(async () => {
      const notif = await prisma.adminNotification.findFirst({
        where: { adminId: standardAdminId, isRead: false },
      });
      unreadNotifId = notif.id;
    });

    it('marks a single notification as read and sets readAt timestamp', async () => {
      const res = await request(app)
        .patch(`/api/notifications/${unreadNotifId}/read`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(unreadNotifId);
      expect(res.body.data.isRead).toBe(true);
      expect(res.body.data.readAt).not.toBeNull();

      // Check DB
      const updated = await prisma.adminNotification.findUnique({
        where: { id: unreadNotifId },
      });
      expect(updated.isRead).toBe(true);
      expect(updated.readAt).not.toBeNull();
    });

    it('marks all unread notifications for authenticated admin as read', async () => {
      const res = await request(app)
        .patch('/api/notifications/read-all')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.updatedCount).toBeGreaterThanOrEqual(1);

      // Verify unread count is now 0 for Admin 1
      const countRes = await request(app)
        .get('/api/notifications/unread-count')
        .set('Cookie', standardAdminCookie);

      expect(countRes.body.data.unreadCount).toBe(0);

      // Verify Admin 2 unread notifications were untouched
      const admin2Unread = await prisma.adminNotification.count({
        where: { adminId: secondaryAdminId, isRead: false },
      });
      expect(admin2Unread).toBe(2);
    });
  });

  describe('6. Cross-Admin Isolation & Ownership Enforcement', () => {
    let admin2NotifId;

    beforeAll(async () => {
      const notif = await prisma.adminNotification.findFirst({
        where: { adminId: secondaryAdminId },
      });
      admin2NotifId = notif.id;
    });

    it('rejects cross-admin attempt to mark another admin notification as read with 403 Forbidden', async () => {
      const res = await request(app)
        .patch(`/api/notifications/${admin2NotifId}/read`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden');

      // Admin 2's notification remains unread
      const notif = await prisma.adminNotification.findUnique({
        where: { id: admin2NotifId },
      });
      expect(notif.isRead).toBe(false);
    });

    it('returns 404 when marking a non-existent notification ID', async () => {
      const nonExistentUuid = '00000000-0000-4000-8000-000000000000';
      const res = await request(app)
        .patch(`/api/notifications/${nonExistentUuid}/read`)
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('returns 400 for malformed notification UUID', async () => {
      const res = await request(app)
        .patch('/api/notifications/not-a-valid-uuid/read')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('7. Stale Token Cleanup & Simulated FCM Multicast Delivery', () => {
    const staleToken = 'fcm_stale_token_test_abc_123';
    const activeToken = 'fcm_valid_token_test_def_456';

    beforeAll(async () => {
      await prisma.adminDeviceToken.createMany({
        data: [
          { adminId: standardAdminId, token: staleToken, platform: 'WEB' },
          { adminId: standardAdminId, token: activeToken, platform: 'WEB' },
        ],
      });
    });

    afterAll(async () => {
      await prisma.adminDeviceToken.deleteMany({
        where: { token: { in: [staleToken, activeToken] } },
      });
    });

    it('automatically purges stale tokens from database when FCM reports token unregistered', async () => {
      // Mock Firebase Admin messaging client returning 1 success and 1 registration-token-not-registered
      const mockMessaging = {
        sendEachForMulticast: vi.fn().mockResolvedValue({
          successCount: 1,
          failureCount: 1,
          responses: [
            {
              success: false,
              error: {
                code: 'messaging/registration-token-not-registered',
                message: 'Requested entity was not found.',
              },
            },
            {
              success: true,
              messageId: 'projects/test-proj/messages/msg_456',
            },
          ],
        }),
      };

      const mockApp = {
        messaging: () => mockMessaging,
      };

      _setFirebaseApp(mockApp);

      const result = await NotificationService.createNotification({
        adminId: standardAdminId,
        title: 'New Applicant Submitted',
        body: 'Candidate Jane Doe submitted an application for Frontend Lead.',
        category: 'APPLICATION',
        sendPush: true,
      });

      expect(result.notification).toBeDefined();
      expect(result.delivery.sent).toBe(1);
      expect(result.delivery.failed).toBe(1);
      expect(result.delivery.staleTokens).toContain(staleToken);

      // Verify stale token is deleted from DB
      const staleInDb = await prisma.adminDeviceToken.findUnique({
        where: { token: staleToken },
      });
      expect(staleInDb).toBeNull();

      // Verify active token is still present in DB
      const activeInDb = await prisma.adminDeviceToken.findUnique({
        where: { token: activeToken },
      });
      expect(activeInDb).not.toBeNull();
    });
  });

  describe('8. Resilience: In-App Notification Persists When Firebase Delivery Fails', () => {
    it('preserves in-app notification in database even when FCM throws a critical exception', async () => {
      const mockMessaging = {
        sendEachForMulticast: vi.fn().mockRejectedValue(new Error('Firebase service connection reset by peer')),
      };

      const mockApp = {
        messaging: () => mockMessaging,
      };

      _setFirebaseApp(mockApp);

      const resilienceToken = 'fcm_token_resilience_test';
      await prisma.adminDeviceToken.upsert({
        where: { token: resilienceToken },
        create: { adminId: standardAdminId, token: resilienceToken, platform: 'WEB' },
        update: { adminId: standardAdminId },
      });

      const result = await NotificationService.createNotification({
        adminId: standardAdminId,
        title: 'Security Alert: Password Changed',
        body: 'Your administrative account password was recently changed.',
        category: 'SECURITY',
        sendPush: true,
      });

      await prisma.adminDeviceToken.deleteMany({
        where: { token: resilienceToken },
      });

      expect(result.notification).toBeDefined();
      expect(result.notification.id).toBeDefined();
      expect(result.notification.title).toBe('Security Alert: Password Changed');

      // Delivery reports failure without crashing the process
      expect(result.delivery.sent).toBe(0);
      expect(result.delivery.failed).toBeGreaterThanOrEqual(1);

      // Verify in-app notification exists and is queryable in database
      const savedInDb = await prisma.adminNotification.findUnique({
        where: { id: result.notification.id },
      });
      expect(savedInDb).not.toBeNull();
      expect(savedInDb.title).toBe('Security Alert: Password Changed');
    });
  });

  describe('9. RBAC, Session & MFA Route Protections', () => {
    it('rejects unauthenticated requests to notifications endpoints with 401', async () => {
      const res = await request(app).get('/api/notifications');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects pending-MFA sessions from notification endpoints with 401', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .set('x-test-bypass-csrf', 'true')
        .send({ email: STANDARD_ADMIN_EMAIL, password: TEST_PASSWORD });

      const pendingCookie = loginRes.headers['set-cookie'];

      const res = await request(app)
        .get('/api/notifications')
        .set('Cookie', pendingCookie);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.state).toBe('PASSWORD_ACCEPTED_MFA_PENDING');
    });

    it('rejects standard admin from guarded test-send endpoint with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/notifications/test-send')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', standardAdminCookie)
        .send({
          title: 'Unauthorized Test Push',
          body: 'This should be blocked for non-superadmins.',
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('authorizes SUPER_ADMIN on guarded test-send endpoint and creates notification', async () => {
      const res = await request(app)
        .post('/api/notifications/test-send')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          title: 'Super Admin Broadcast Test',
          body: 'System notification verification broadcast.',
          category: 'SYSTEM',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.notification).toBeDefined();
      expect(res.body.data.notification.adminId).toBe(superAdminId);
      expect(res.body.data.delivery).toBeDefined();
    });

    it('validates required fields on test-send endpoint with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/notifications/test-send')
        .set('x-test-bypass-csrf', 'true')
        .set('Cookie', superAdminCookie)
        .send({
          title: '', // empty title
          body: '',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('11. Push Configuration Diagnostic Status Endpoint', () => {
    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await request(app).get('/api/notifications/config-status');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects pending 2FA / invalid sessions with 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/notifications/config-status')
        .set('Cookie', pendingMfaCookie);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns safe diagnostic status for authenticated admin without leaking credentials', async () => {
      const res = await request(app)
        .get('/api/notifications/config-status')
        .set('Cookie', standardAdminCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(typeof res.body.data.pushConfigured).toBe('boolean');
      expect(typeof res.body.data.pushInitialized).toBe('boolean');
      expect(res.body.data.inboxActive).toBe(true);
      // Guarantee private keys and secrets are never exposed
      expect(res.body.data.privateKey).toBeUndefined();
      expect(res.body.data.clientEmail).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('BEGIN PRIVATE KEY');
    });
  });
});
