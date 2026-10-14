import { Router } from 'express';
import { AuthController } from './auth.controller.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticateSession,
  require2FAVerified,
} from '../../middleware/auth.js';
import {
  loginLimiter,
  forgotPasswordLimiter,
  twoFactorLimiter,
} from '../../middleware/rateLimiter.js';
import {
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verify2FALoginSchema,
  verifyBackupCodeLoginSchema,
  confirm2FASchema,
  regenerateBackupCodesSchema,
} from './auth.validation.js';

const router = Router();

// CSRF Token Retrieval
router.get('/csrf-token', AuthController.getCsrfToken);

// Login Flow
router.post('/login', loginLimiter, validate(loginSchema), AuthController.login);
router.post('/verify-2fa', twoFactorLimiter, validate(verify2FALoginSchema), AuthController.verify2FA);
router.post('/verify-backup-code', twoFactorLimiter, validate(verifyBackupCodeLoginSchema), AuthController.verifyBackupCode);

// Password Reset Flow
router.post('/forgot-password', forgotPasswordLimiter, validate(forgotPasswordSchema), AuthController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), AuthController.resetPassword);

// Session State & Logout
router.get('/me', authenticateSession, AuthController.me);
router.post('/logout', authenticateSession, AuthController.logout);

// Two-Factor Authentication Management (Protected)
router.post('/2fa/setup', authenticateSession, AuthController.setup2FA);
router.post('/2fa/confirm', authenticateSession, validate(confirm2FASchema), AuthController.confirm2FA);
router.post('/backup-codes/regenerate', authenticateSession, require2FAVerified, validate(regenerateBackupCodesSchema), AuthController.regenerateBackupCodes);

export default router;
