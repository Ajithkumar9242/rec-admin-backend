import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export const AuthState = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PASSWORD_ACCEPTED_MFA_PENDING: 'PASSWORD_ACCEPTED_MFA_PENDING',
  MFA_ENROLLMENT_REQUIRED: 'MFA_ENROLLMENT_REQUIRED',
  AUTHENTICATED_MFA_VERIFIED: 'AUTHENTICATED_MFA_VERIFIED',
  SESSION_EXPIRED_OR_REVOKED: 'SESSION_EXPIRED_OR_REVOKED',
};

/**
 * Middleware ensuring a fully verified, authenticated admin session.
 */
export async function authenticateSession(req, res, next) {
  if (!req.session) {
    return res.status(401).json({
      success: false,
      state: AuthState.UNAUTHENTICATED,
      error: 'Authentication required. No active session found.',
    });
  }

  // Check state machine
  if (req.session.authState === AuthState.PASSWORD_ACCEPTED_MFA_PENDING) {
    return res.status(401).json({
      success: false,
      state: AuthState.PASSWORD_ACCEPTED_MFA_PENDING,
      error: 'Two-factor authentication verification is pending. Access denied.',
    });
  }

  if (req.session.authState === AuthState.MFA_ENROLLMENT_REQUIRED) {
    return res.status(401).json({
      success: false,
      state: AuthState.MFA_ENROLLMENT_REQUIRED,
      error: 'Two-factor authentication enrollment is required before accessing admin resources.',
    });
  }

  if (!req.session.adminId || req.session.authState !== AuthState.AUTHENTICATED_MFA_VERIFIED) {
    return res.status(401).json({
      success: false,
      state: AuthState.UNAUTHENTICATED,
      error: 'Authentication required. Please sign in.',
    });
  }

  // Validate absolute 24-hour session lifetime server-side
  const now = Date.now();
  if (req.session.absoluteExpiresAt && now >= req.session.absoluteExpiresAt) {
    logger.info({ adminId: req.session.adminId }, 'Session absolute lifetime (24h) expired');
    return new Promise((resolve) => {
      req.session.destroy((err) => {
        if (err) {
          logger.warn({ error: err.message }, 'Error destroying expired session');
        }
        res.clearCookie(env.COOKIE_NAME, {
          path: '/',
          httpOnly: true,
          secure: env.COOKIE_SECURE,
          sameSite: env.COOKIE_SAME_SITE,
        });
        return resolve(
          res.status(401).json({
            success: false,
            state: AuthState.SESSION_EXPIRED_OR_REVOKED,
            error: 'Session has exceeded its 24-hour absolute lifetime limit. Please sign in again with your credentials and authenticator code.',
          })
        );
      });
    });
  }

  try {
    const admin = await prisma.admin.findUnique({
      where: { id: req.session.adminId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        totpEnabled: true,
        lastLoginAt: true,
      },
    });

    if (!admin) {
      req.session.destroy();
      return res.status(401).json({
        success: false,
        state: AuthState.SESSION_EXPIRED_OR_REVOKED,
        error: 'Administrator account not found.',
      });
    }

    if (admin.status !== 'ACTIVE') {
      req.session.destroy();
      logger.warn({ adminId: admin.id, status: admin.status }, 'Access denied: Admin account is not active');
      return res.status(403).json({
        success: false,
        error: `Account is ${admin.status.toLowerCase()}. Access denied.`,
      });
    }

    req.admin = admin;
    next();
  } catch (error) {
    logger.error({ error: error.message }, 'Failed during session verification');
    return res.status(500).json({
      success: false,
      error: 'Internal server error verifying session.',
    });
  }
}

/**
 * Middleware allowing access strictly for MFA enrollment workflow
 * (Applicable during initial login when MFA enrollment is required, or when fully authenticated to reconfigure)
 */
export async function requireMFAEnrollmentAccess(req, res, next) {
  if (!req.session) {
    return res.status(401).json({
      success: false,
      state: AuthState.UNAUTHENTICATED,
      error: 'Authentication required.',
    });
  }

  const effectiveAdminId = req.session.adminId || req.session.pendingAdminId;

  if (
    !effectiveAdminId ||
    (req.session.authState !== AuthState.MFA_ENROLLMENT_REQUIRED &&
     req.session.authState !== AuthState.AUTHENTICATED_MFA_VERIFIED)
  ) {
    return res.status(401).json({
      success: false,
      state: req.session.authState || AuthState.UNAUTHENTICATED,
      error: 'You do not have authorization to perform MFA enrollment.',
    });
  }

  try {
    const admin = await prisma.admin.findUnique({
      where: { id: effectiveAdminId },
      select: { id: true, email: true, name: true, role: true, status: true, totpEnabled: true },
    });

    if (!admin || admin.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, error: 'Account is not eligible for MFA enrollment.' });
    }

    req.enrollmentAdmin = admin;
    next();
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
}

/**
 * Requires the authenticated admin to have one of the permitted roles.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({
        success: false,
        state: AuthState.UNAUTHENTICATED,
        error: 'Authentication required.',
      });
    }

    if (req.admin.role === 'SUPER_ADMIN') {
      return next();
    }

    if (!allowedRoles.includes(req.admin.role)) {
      logger.warn(
        { adminId: req.admin.id, role: req.admin.role, required: allowedRoles },
        'Forbidden: Insufficient privileges'
      );
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You do not have permission to perform this action.',
      });
    }

    next();
  };
}

/**
 * Ensures that if 2FA is enrolled, the session has completed 2FA verification.
 */
export function require2FAVerified(req, res, next) {
  if (req.session?.authState !== AuthState.AUTHENTICATED_MFA_VERIFIED) {
    return res.status(403).json({
      success: false,
      state: req.session?.authState || AuthState.UNAUTHENTICATED,
      error: 'Two-factor authentication verification is required.',
      requires2FA: true,
    });
  }
  next();
}
