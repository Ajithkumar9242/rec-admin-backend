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
        user,
      });
    } catch (error) {
      next(error);
    }
  }

  static async logout(req, res, next) {
    try {
      const adminId = req.session?.adminId;
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
      const result = await AuthService.start2FAEnrollment(req.admin.id, req);
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
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await AuthService.confirm2FAEnrollment({
        adminId: req.admin.id,
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
