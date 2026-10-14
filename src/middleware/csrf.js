import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Middleware to manage and enforce CSRF tokens
 */
export function csrfProtection(req, res, next) {
  // Ensure session has a CSRF token
  if (req.session) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    // Always expose current CSRF token in response header
    res.setHeader('X-CSRF-Token', req.session.csrfToken);
  }

  // Safe HTTP methods do not change state
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // In test environment, allow bypassing CSRF if explicit header is present or during automated unit tests
  if (env.NODE_ENV === 'test' && req.headers['x-test-bypass-csrf'] === 'true') {
    return next();
  }

  // 1. Origin / Referer validation for state-changing requests
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try {
      const parsedOrigin = new URL(origin).origin;
      const isAllowed = env.ALLOWED_ORIGINS.some(allowed => {
        try {
          return new URL(allowed).origin === parsedOrigin;
        } catch {
          return false;
        }
      });

      if (!isAllowed && env.NODE_ENV === 'production') {
        logger.warn({ origin: parsedOrigin }, 'Blocked state-changing request from unauthorized origin');
        return res.status(403).json({
          success: false,
          error: 'Cross-origin request forbidden',
        });
      }
    } catch {
      // Invalid origin URL format
    }
  }

  // 2. Validate X-CSRF-Token header if session is established
  // If the user has an active session, state-changing requests MUST supply the matching CSRF token.
  if (req.session && req.session.adminId) {
    const clientToken = req.headers['x-csrf-token'];
    if (!clientToken || clientToken !== req.session.csrfToken) {
      logger.warn({ ip: req.ip }, 'CSRF token mismatch on state-changing request');
      return res.status(403).json({
        success: false,
        error: 'Invalid or missing CSRF token',
      });
    }
  }

  next();
}
