import { AuthService } from './auth.service.js';

export class AuthController {
  static async login(req, res, next) {
    try {
      const { email, password } = req.body;
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await AuthService.login({
        email,
        password,
        ipAddress,
        userAgent,
        req,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async verify2FA(req, res, next) {
    try {
      const { adminId, code } = req.body;
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await AuthService.verify2FALogin({
        adminId,
        code,
        ipAddress,
        userAgent,
        req,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async verifyBackupCode(req, res, next) {
    try {
      const { adminId, code } = req.body;
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await AuthService.verifyBackupCodeLogin({
        adminId,
        code,
        ipAddress,
        userAgent,
        req,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async me(req, res, next) {
    try {
      const user = await AuthService.getCurrentUser(req.admin.id);
      return res.status(200).json({
        success: true,
        state: req.session.authState,
        user,
        session: {
          authenticatedAt: req.session.authenticatedAt || null,
          absoluteExpiresAt: req.session.absoluteExpiresAt || null,
          remainingSeconds: req.session.absoluteExpiresAt
            ? Math.max(0, Math.floor((req.session.absoluteExpiresAt - Date.now()) / 1000))
            : 0,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async logout(req, res, next) {
    try {
      const adminId = req.session?.adminId || req.session?.pendingAdminId;
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      await AuthService.logout({
        adminId,
        ipAddress,
        userAgent,
        req,
        res,
      });

      return res.status(200).json({
        success: true,
        state: 'UNAUTHENTICATED',
        message: 'Successfully logged out.',
      });
    } catch (error) {
      next(error);
    }
  }

  static async forgotPassword(req, res, next) {
    try {
      const { email } = req.body;
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await AuthService.requestPasswordReset({
        email,
        ipAddress,
        userAgent,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async resetPassword(req, res, next) {
    try {
      const { token, password } = req.body;
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await AuthService.resetPassword({
        token,
        newPassword: password,
        ipAddress,
        userAgent,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async setup2FA(req, res, next) {
    try {
      const effectiveAdminId = req.enrollmentAdmin?.id || req.session?.pendingAdminId || req.admin?.id;
      const result = await AuthService.start2FAEnrollment(effectiveAdminId, req);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async confirm2FA(req, res, next) {
    try {
      const { code } = req.body;
      const effectiveAdminId = req.enrollmentAdmin?.id || req.session?.pendingAdminId || req.admin?.id;
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await AuthService.confirm2FAEnrollment({
        adminId: effectiveAdminId,
        code,
        ipAddress,
        userAgent,
        req,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async regenerateBackupCodes(req, res, next) {
    try {
      const { password } = req.body;
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await AuthService.regenerateBackupCodes({
        adminId: req.admin.id,
        password,
        ipAddress,
        userAgent,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getCsrfToken(req, res) {
    return res.status(200).json({
      success: true,
      csrfToken: req.session?.csrfToken || '',
    });
  }
}
