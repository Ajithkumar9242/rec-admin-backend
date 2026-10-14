import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Authenticates that an active admin session exists.
 * Attaches req.admin with sanitized admin details.
 */
export async function authenticateSession(req, res, next) {
  if (!req.session || !req.session.adminId) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. No active session found.',
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
 * Requires the authenticated admin to have one of the permitted roles.
 * SUPER_ADMIN is automatically permitted.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({
        success: false,
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
  if (req.admin && req.admin.totpEnabled && !req.session.is2FAVerified) {
    return res.status(403).json({
      success: false,
      error: 'Two-factor authentication verification is required.',
      requires2FA: true,
    });
  }
  next();
}
