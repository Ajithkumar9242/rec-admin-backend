import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { BusinessEventNotificationService } from '../notifications/businessEvent.service.js';
import {
  hashPassword,
  verifyPassword,
  generateSecureToken,
  hashToken,
  generateBackupCodes,
  hashBackupCode,
  encryptTotpSecret,
  decryptTotpSecret,
} from '../../lib/crypto.js';
import {
  generateTotpSecret,
  generateQrCodeDataUrl,
  verifyTotp,
} from '../../lib/totp.js';
import { sendPasswordResetEmail } from '../../lib/mailer.js';
import { AuthState } from '../../middleware/auth.js';
import { revokeAdminSessions } from '../../lib/redis.js';

export const SESSION_ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$6+4jK82WcE0mOqj7Tf1L4XwN4x8aA9m1K1b4C3d2E5g';

export class AuthService {
  /**
   * Helper to regenerate session safely as a Promise
   */
  static async regenerateSession(req) {
    return new Promise((resolve, reject) => {
      if (!req.session) return resolve();
      req.session.regenerate((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Helper to record audit events in the database
   */
  static async recordAuditLog({ adminId, eventType, ipAddress, userAgent, details = {} }) {
    try {
      await prisma.authAuditLog.create({
        data: {
          adminId: adminId || null,
          eventType,
          ipAddress: ipAddress || null,
          userAgent: userAgent || null,
          details,
        },
      });
    } catch (err) {
      logger.error({ error: err.message, eventType }, 'Failed to write auth audit log');
    }
  }

  /**
   * Format sanitized admin response
   */
  static sanitizeAdmin(admin, remainingBackupCodes = 0) {
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      status: admin.status,
      totpEnabled: admin.totpEnabled,
      lastLoginAt: admin.lastLoginAt,
      remainingBackupCodes,
    };
  }

  /**
   * Admin Login with email and password
   */
  static async login({ email, password, ipAddress, userAgent, req }) {
    const normalizedEmail = email.trim().toLowerCase();

    const admin = await prisma.admin.findUnique({
      where: { email: normalizedEmail },
    });

    if (!admin) {
      // Mitigate timing attack with dummy verify
      await verifyPassword(DUMMY_HASH, password);
      await this.recordAuditLog({
        eventType: 'LOGIN_FAILURE',
        ipAddress,
        userAgent,
        details: { email: normalizedEmail, reason: 'account_not_found' },
      });
      const error = new Error('Invalid email or password.');
      error.status = 401;
      throw error;
    }

    // Check account lockout
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      const waitMinutes = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 60000);
      await this.recordAuditLog({
        adminId: admin.id,
        eventType: 'LOGIN_FAILURE',
        ipAddress,
        userAgent,
        details: { reason: 'account_locked', lockedUntil: admin.lockedUntil },
      });
      const error = new Error(`Account is temporarily locked. Please try again in ${waitMinutes} minutes.`);
      error.status = 423; // Locked
      throw error;
    }

    // Verify password
    const isPasswordValid = await verifyPassword(admin.passwordHash, password);

    if (!isPasswordValid) {
      const failedAttempts = admin.failedLoginAttempts + 1;
      const isNowLocked = failedAttempts >= env.LOGIN_MAX_FAILED_ATTEMPTS;
      const lockedUntil = isNowLocked
        ? new Date(Date.now() + env.ACCOUNT_LOCKOUT_MINUTES * 60 * 1000)
        : null;

      await prisma.admin.update({
        where: { id: admin.id },
        data: {
          failedLoginAttempts: failedAttempts,
          lockedUntil,
        },
      });

      if (isNowLocked) {
        await this.recordAuditLog({
          adminId: admin.id,
          eventType: 'ACCOUNT_LOCKED',
          ipAddress,
          userAgent,
          details: { failedAttempts, lockedUntil },
        });

        BusinessEventNotificationService.notifyAccountLocked({
          admin,
          failedAttempts,
          lockoutMinutes: env.ACCOUNT_LOCKOUT_MINUTES,
        }).catch((err) => logger.warn(`[Auth] Failed to send account locked notification: ${err.message}`));
      }

      await this.recordAuditLog({
        adminId: admin.id,
        eventType: 'LOGIN_FAILURE',
        ipAddress,
        userAgent,
        details: { reason: 'invalid_password', failedAttempts },
      });

      const error = new Error('Invalid email or password.');
      error.status = 401;
      throw error;
    }

    // Check account status
    if (admin.status !== 'ACTIVE') {
      await this.recordAuditLog({
        adminId: admin.id,
        eventType: 'LOGIN_FAILURE',
        ipAddress,
        userAgent,
        details: { reason: `account_${admin.status.toLowerCase()}` },
      });
      const error = new Error(`Account is ${admin.status.toLowerCase()}. Access denied.`);
      error.status = 403;
      throw error;
    }

    // Reset failed login attempts on valid password
    if (admin.failedLoginAttempts > 0 || admin.lockedUntil) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    }

    // If 2FA is enrolled, transition to PASSWORD_ACCEPTED_MFA_PENDING
    if (admin.totpEnabled) {
      await this.regenerateSession(req);
      req.session.authState = AuthState.PASSWORD_ACCEPTED_MFA_PENDING;
      req.session.pendingAdminId = admin.id;
      delete req.session.adminId;

      return {
        state: AuthState.PASSWORD_ACCEPTED_MFA_PENDING,
        requires2FA: true,
        adminId: admin.id,
      };
    }

    // If 2FA is NOT enrolled, mandatory enrollment transition
    await this.regenerateSession(req);
    req.session.authState = AuthState.MFA_ENROLLMENT_REQUIRED;
    req.session.pendingAdminId = admin.id;
    delete req.session.adminId;

    return {
      state: AuthState.MFA_ENROLLMENT_REQUIRED,
      requiresMFAEnrollment: true,
      adminId: admin.id,
    };
  }

  /**
   * Verify TOTP 2FA code during login
   */
  static async verify2FALogin({ adminId, code, ipAddress, userAgent, req }) {
    const effectiveAdminId = req.session?.pendingAdminId || adminId;

    if (!effectiveAdminId) {
      const error = new Error('No pending two-factor authentication challenge.');
      error.status = 401;
      throw error;
    }

    const admin = await prisma.admin.findUnique({
      where: { id: effectiveAdminId },
      include: {
        backupCodes: {
          where: { usedAt: null },
        },
      },
    });

    if (!admin || !admin.totpEnabled || !admin.totpSecret) {
      const error = new Error('Two-factor authentication is not active on this account.');
      error.status = 400;
      throw error;
    }

    if (admin.status !== 'ACTIVE') {
      const error = new Error('Account is not active.');
      error.status = 403;
      throw error;
    }

    // Decrypt authenticated TOTP secret
    const plainSecret = decryptTotpSecret(admin.totpSecret);
    const isValid = verifyTotp(code, plainSecret);

    if (!isValid) {
      await this.recordAuditLog({
        adminId: admin.id,
        eventType: 'LOGIN_FAILURE',
        ipAddress,
        userAgent,
        details: { reason: 'invalid_totp_code' },
      });
      const error = new Error('Invalid two-factor authentication code.');
      error.status = 400;
      throw error;
    }

    // Transition to AUTHENTICATED_MFA_VERIFIED
    await this.regenerateSession(req);
    const now = Date.now();
    req.session.authState = AuthState.AUTHENTICATED_MFA_VERIFIED;
    req.session.adminId = admin.id;
    req.session.role = admin.role;
    req.session.authenticatedAt = now;
    req.session.absoluteExpiresAt = now + SESSION_ABSOLUTE_LIFETIME_MS;
    delete req.session.pendingAdminId;

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    await this.recordAuditLog({
      adminId: admin.id,
      eventType: 'TWO_FACTOR_VERIFIED',
      ipAddress,
      userAgent,
      details: { method: 'totp' },
    });

    await this.recordAuditLog({
      adminId: admin.id,
      eventType: 'LOGIN_SUCCESS',
      ipAddress,
      userAgent,
      details: { method: '2fa_totp' },
    });

    return {
      state: AuthState.AUTHENTICATED_MFA_VERIFIED,
      user: this.sanitizeAdmin(admin, admin.backupCodes.length),
    };
  }

  /**
   * Recover login using single-use emergency backup code (with atomic concurrency protection)
   */
  static async verifyBackupCodeLogin({ adminId, code, ipAddress, userAgent, req }) {
    const effectiveAdminId = req.session?.pendingAdminId || adminId;

    if (!effectiveAdminId) {
      const error = new Error('No pending two-factor challenge found.');
      error.status = 401;
      throw error;
    }

    const admin = await prisma.admin.findUnique({
      where: { id: effectiveAdminId },
    });

    if (!admin || !admin.totpEnabled) {
      const error = new Error('Two-factor authentication is not active.');
      error.status = 400;
      throw error;
    }

    const hashedInput = hashBackupCode(code);

    // Atomic transaction with single-row update to strictly prevent concurrent replay
    const consumedCode = await prisma.$transaction(async (tx) => {
      const candidate = await tx.adminBackupCode.findFirst({
        where: {
          adminId: admin.id,
          codeHash: hashedInput,
          usedAt: null,
        },
      });

      if (!candidate) return null;

      const updateResult = await tx.adminBackupCode.updateMany({
        where: {
          id: candidate.id,
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });

      return updateResult.count === 1 ? candidate : null;
    });

    if (!consumedCode) {
      await this.recordAuditLog({
        adminId: admin.id,
        eventType: 'LOGIN_FAILURE',
        ipAddress,
        userAgent,
        details: { reason: 'invalid_or_replayed_backup_code' },
      });
      const error = new Error('Invalid or already used backup code.');
      error.status = 400;
      throw error;
    }

    const remainingCount = await prisma.adminBackupCode.count({
      where: { adminId: admin.id, usedAt: null },
    });

    // Establish verified session
    await this.regenerateSession(req);
    const now = Date.now();
    req.session.authState = AuthState.AUTHENTICATED_MFA_VERIFIED;
    req.session.adminId = admin.id;
    req.session.role = admin.role;
    req.session.authenticatedAt = now;
    req.session.absoluteExpiresAt = now + SESSION_ABSOLUTE_LIFETIME_MS;
    delete req.session.pendingAdminId;

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    await this.recordAuditLog({
      adminId: admin.id,
      eventType: 'BACKUP_CODE_USED',
      ipAddress,
      userAgent,
      details: { remainingCodes: remainingCount },
    });

    await this.recordAuditLog({
      adminId: admin.id,
      eventType: 'LOGIN_SUCCESS',
      ipAddress,
      userAgent,
      details: { method: 'backup_code' },
    });

    return {
      state: AuthState.AUTHENTICATED_MFA_VERIFIED,
      user: this.sanitizeAdmin(admin, remainingCount),
      remainingBackupCodes: remainingCount,
    };
  }

  /**
   * Get current authenticated user details
   */
  static async getCurrentUser(adminId) {
    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
    });

    if (!admin) {
      const error = new Error('User not found.');
      error.status = 404;
      throw error;
    }

    const remainingBackupCodes = await prisma.adminBackupCode.count({
      where: { adminId: admin.id, usedAt: null },
    });

    return this.sanitizeAdmin(admin, remainingBackupCodes);
  }

  /**
   * Destroy session on logout
   */
  static async logout({ adminId, ipAddress, userAgent, req, res }) {
    if (adminId) {
      await this.recordAuditLog({
        adminId,
        eventType: 'LOGOUT',
        ipAddress,
        userAgent,
      });
    }

    return new Promise((resolve, reject) => {
      if (!req.session) {
        res.clearCookie(env.COOKIE_NAME);
        return resolve();
      }

      req.session.destroy((err) => {
        if (err) {
          logger.error({ error: err.message }, 'Error destroying session');
          return reject(err);
        }
        res.clearCookie(env.COOKIE_NAME);
        resolve();
      });
    });
  }

  /**
   * Request password reset link (privacy-preserving)
   */
  static async requestPasswordReset({ email, ipAddress, userAgent }) {
    const normalizedEmail = email.trim().toLowerCase();

    const admin = await prisma.admin.findUnique({
      where: { email: normalizedEmail },
    });

    let mailResult = { success: true };

    if (admin && admin.status === 'ACTIVE') {
      await prisma.passwordResetToken.deleteMany({
        where: { adminId: admin.id },
      });

      const rawToken = generateSecureToken(32);
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_EXPIRES_MINUTES * 60 * 1000);

      await prisma.passwordResetToken.create({
        data: {
          adminId: admin.id,
          tokenHash,
          expiresAt,
        },
      });

      const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${rawToken}`;

      mailResult = await sendPasswordResetEmail({
        to: admin.email,
        resetUrl,
        recipientName: admin.name,
      });

      await this.recordAuditLog({
        adminId: admin.id,
        eventType: 'PASSWORD_RESET_REQUESTED',
        ipAddress,
        userAgent,
      });
    } else {
      await this.recordAuditLog({
        eventType: 'PASSWORD_RESET_REQUESTED',
        ipAddress,
        userAgent,
        details: { email: normalizedEmail, result: 'not_found_or_inactive' },
      });
    }

    return {
      message: 'If an active account exists with that email address, a password reset link has been dispatched.',
      mailDelivered: mailResult.delivered,
      ...(mailResult.error && { deliveryNotice: mailResult.error }),
    };
  }

  /**
   * Execute password reset using valid token
   */
  static async resetPassword({ token, newPassword, ipAddress, userAgent }) {
    const tokenHash = hashToken(token);

    const resetTokenRecord = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { admin: true },
    });

    if (!resetTokenRecord || !resetTokenRecord.admin) {
      const error = new Error('Password reset token is invalid or has expired.');
      error.status = 400;
      throw error;
    }

    const newPasswordHash = await hashPassword(newPassword);

    await prisma.$transaction([
      prisma.admin.update({
        where: { id: resetTokenRecord.admin.id },
        data: {
          passwordHash: newPasswordHash,
          passwordChangedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetTokenRecord.id },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetToken.deleteMany({
        where: {
          adminId: resetTokenRecord.admin.id,
          id: { not: resetTokenRecord.id },
        },
      }),
    ]);

    await this.recordAuditLog({
      adminId: resetTokenRecord.admin.id,
      eventType: 'PASSWORD_RESET_COMPLETED',
      ipAddress,
      userAgent,
      details: { action: 'password_reset_via_token' },
    });

    // Invalidate all active Redis sessions for this administrator
    await revokeAdminSessions(resetTokenRecord.admin.id);

    return {
      message: 'Password has been successfully updated. You may now sign in with your new password.',
    };
  }

  /**
   * Initiate 2FA enrollment: returns secret and QR code URL
   */
  static async start2FAEnrollment(adminId, req) {
    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
    });

    if (!admin) {
      const error = new Error('Admin not found.');
      error.status = 404;
      throw error;
    }

    const { secret, otpAuthUrl } = generateTotpSecret(admin.email);
    const qrCodeUrl = await generateQrCodeDataUrl(otpAuthUrl);

    // Save encrypted candidate secret in session
    req.session.candidateEncryptedTotpSecret = encryptTotpSecret(secret);

    return {
      secret,
      qrCodeUrl,
    };
  }

  /**
   * Confirm 2FA enrollment and generate initial single-use backup codes
   */
  static async confirm2FAEnrollment({ adminId, code, ipAddress, userAgent, req }) {
    const encryptedSecret = req.session?.candidateEncryptedTotpSecret;

    if (!encryptedSecret) {
      const error = new Error('No pending 2FA enrollment found. Please restart setup.');
      error.status = 400;
      throw error;
    }

    const secret = decryptTotpSecret(encryptedSecret);
    const isValid = verifyTotp(code, secret);

    if (!isValid) {
      const error = new Error('Invalid verification code. Please check your authenticator app and try again.');
      error.status = 400;
      throw error;
    }

    // Generate 10 cryptographically secure backup codes
    const plainBackupCodes = generateBackupCodes(10);
    const backupCodeInserts = plainBackupCodes.map(c => ({
      adminId,
      codeHash: hashBackupCode(c),
    }));

    await prisma.$transaction([
      prisma.admin.update({
        where: { id: adminId },
        data: {
          totpSecret: encryptedSecret, // Stored encrypted with AES-256-GCM
          totpEnabled: true,
          totpVerifiedAt: new Date(),
        },
      }),
      prisma.adminBackupCode.deleteMany({
        where: { adminId },
      }),
      prisma.adminBackupCode.createMany({
        data: backupCodeInserts,
      }),
    ]);

    delete req.session.candidateEncryptedTotpSecret;
    delete req.session.pendingAdminId;

    // Transition session to fully authenticated
    await this.regenerateSession(req);
    const freshAdmin = await prisma.admin.findUnique({ where: { id: adminId } });
    const now = Date.now();
    req.session.authState = AuthState.AUTHENTICATED_MFA_VERIFIED;
    req.session.adminId = adminId;
    req.session.role = freshAdmin.role;
    req.session.authenticatedAt = now;
    req.session.absoluteExpiresAt = now + SESSION_ABSOLUTE_LIFETIME_MS;

    await this.recordAuditLog({
      adminId,
      eventType: 'TWO_FACTOR_ENROLLED',
      ipAddress,
      userAgent,
    });

    return {
      state: AuthState.AUTHENTICATED_MFA_VERIFIED,
      user: this.sanitizeAdmin(freshAdmin, 10),
      message: 'Two-factor authentication successfully enabled.',
      backupCodes: plainBackupCodes,
    };
  }

  /**
   * Regenerate single-use backup codes (requires password confirmation)
   */
  static async regenerateBackupCodes({ adminId, password, ipAddress, userAgent }) {
    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
    });

    if (!admin || !admin.totpEnabled) {
      const error = new Error('Two-factor authentication is not active.');
      error.status = 400;
      throw error;
    }

    const isPasswordValid = await verifyPassword(admin.passwordHash, password);
    if (!isPasswordValid) {
      const error = new Error('Invalid password confirmation.');
      error.status = 401;
      throw error;
    }

    const plainBackupCodes = generateBackupCodes(10);
    const backupCodeInserts = plainBackupCodes.map(c => ({
      adminId,
      codeHash: hashBackupCode(c),
    }));

    await prisma.$transaction([
      prisma.adminBackupCode.deleteMany({
        where: { adminId },
      }),
      prisma.adminBackupCode.createMany({
        data: backupCodeInserts,
      }),
    ]);

    await this.recordAuditLog({
      adminId,
      eventType: 'BACKUP_CODES_REGENERATED',
      ipAddress,
      userAgent,
    });

    return {
      message: 'Backup codes successfully regenerated. Previous codes are now invalid.',
      backupCodes: plainBackupCodes,
      remainingBackupCodes: 10,
    };
  }
}
