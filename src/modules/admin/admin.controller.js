import { prisma } from '../../lib/prisma.js';

export class AdminController {
  static async getOverview(req, res, next) {
    try {
      const [totalAdmins, activeAdmins, recentLogs] = await Promise.all([
        prisma.admin.count(),
        prisma.admin.count({ where: { status: 'ACTIVE' } }),
        prisma.authAuditLog.findMany({
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            admin: {
              select: {
                id: true,
                email: true,
                name: true,
                role: true,
              },
            },
          },
        }),
      ]);

      return res.status(200).json({
        success: true,
        stats: {
          totalAdmins,
          activeAdmins,
          platformStatus: 'OPERATIONAL',
          currentAdmin: {
            id: req.admin.id,
            email: req.admin.email,
            name: req.admin.name,
            role: req.admin.role,
          },
        },
        recentLogs,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getAuditLogs(req, res, next) {
    try {
      const page = parseInt(req.query.page || '1', 10);
      const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
      const skip = (page - 1) * limit;

      const [logs, total] = await Promise.all([
        prisma.authAuditLog.findMany({
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            admin: {
              select: {
                id: true,
                email: true,
                name: true,
                role: true,
              },
            },
          },
        }),
        prisma.authAuditLog.count(),
      ]);

      return res.status(200).json({
        success: true,
        data: logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
