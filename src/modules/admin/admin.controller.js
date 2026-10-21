import { prisma } from '../../lib/prisma.js';

function sanitizeCsvCell(value) {
  if (value === null || value === undefined) {
    return '""';
  }
  let str = String(value);
  // Protect against spreadsheet formula injection (CWE-1236)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

export class AdminController {
  static async getDashboard(req, res, next) {
    try {
      const { from, to, groupBy = 'day' } = req.query;

      const validUnits = ['day', 'month', 'year'];
      const unit = validUnits.includes(groupBy?.toLowerCase()) ? groupBy.toLowerCase() : 'day';

      let fromDate;
      let toDate;

      if (from && to) {
        fromDate = new Date(from);
        toDate = new Date(to);
      } else {
        toDate = new Date();
        fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      }

      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format provided for date range filter.',
        });
      }

      if (fromDate > toDate) {
        return res.status(400).json({
          success: false,
          error: 'Start date cannot be after end date.',
        });
      }

      fromDate.setUTCHours(0, 0, 0, 0);
      toDate.setUTCHours(23, 59, 59, 999);

      const [
        totalAdmins,
        activeAdmins,
        mfaEnrolledAdmins,
        totalAuditEvents,
        seriesRows,
        authLogs,
        companyLogs,
        billingLogs,
        configLogs,
        jobSeriesRows,
        candidateSeriesRows,
        jobStatusGroups,
        candidateStatusGroups,
        totalJobsCount,
        totalCandidatesCount,
      ] = await Promise.all([
        prisma.admin.count(),
        prisma.admin.count({ where: { status: 'ACTIVE' } }),
        prisma.admin.count({ where: { totpEnabled: true } }),
        prisma.authAuditLog.count({
          where: {
            createdAt: {
              gte: fromDate,
              lte: toDate,
            },
          },
        }),
        prisma.$queryRaw`
          SELECT 
            DATE_TRUNC(${unit}, "createdAt") AS bucket,
            COUNT(*)::int AS count
          FROM "auth_audit_logs"
          WHERE "createdAt" >= ${fromDate} AND "createdAt" <= ${toDate}
          GROUP BY bucket
          ORDER BY bucket ASC;
        `,
        prisma.authAuditLog.findMany({
          take: 15,
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
        prisma.companyAuditLog.findMany({
          take: 15,
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
            company: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        }),
        prisma.billingAuditLog.findMany({
          take: 15,
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
        prisma.platformConfigAuditLog.findMany({
          take: 15,
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
        prisma.$queryRaw`
          SELECT 
            DATE_TRUNC(${unit}, "createdAt") AS bucket,
            COUNT(*)::int AS count
          FROM "jobs"
          WHERE "deletedAt" IS NULL AND "createdAt" >= ${fromDate} AND "createdAt" <= ${toDate}
          GROUP BY bucket
          ORDER BY bucket ASC;
        `,
        prisma.$queryRaw`
          SELECT 
            DATE_TRUNC(${unit}, "createdAt") AS bucket,
            COUNT(*)::int AS count
          FROM "candidates"
          WHERE "deletedAt" IS NULL AND "createdAt" >= ${fromDate} AND "createdAt" <= ${toDate}
          GROUP BY bucket
          ORDER BY bucket ASC;
        `,
        prisma.job.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.candidate.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.job.count({ where: { deletedAt: null } }),
        prisma.candidate.count({ where: { deletedAt: null } }),
      ]);

      const formattedSeries = (seriesRows || []).map((row) => ({
        bucket: row.bucket instanceof Date ? row.bucket.toISOString() : String(row.bucket),
        count: Number(row.count) || 0,
      }));

      const formattedJobSeries = (jobSeriesRows || []).map((row) => ({
        bucket: row.bucket instanceof Date ? row.bucket.toISOString() : String(row.bucket),
        count: Number(row.count) || 0,
      }));

      const formattedCandidateSeries = (candidateSeriesRows || []).map((row) => ({
        bucket: row.bucket instanceof Date ? row.bucket.toISOString() : String(row.bucket),
        count: Number(row.count) || 0,
      }));

      const jobCounts = (jobStatusGroups || []).reduce((acc, curr) => {
        acc[curr.status] = curr._count._all;
        return acc;
      }, {});
      const activeJobsCount = jobCounts.PUBLISHED || 0;
      const inactiveJobsCount = (totalJobsCount || 0) - activeJobsCount;

      const candidateCounts = (candidateStatusGroups || []).reduce((acc, curr) => {
        acc[curr.status] = curr._count._all;
        return acc;
      }, {});
      const activeCandidatesCount = candidateCounts.ACTIVE || 0;
      const pendingCandidatesCount = candidateCounts.PENDING_APPROVAL || 0;
      const inactiveCandidatesCount = (candidateCounts.INACTIVE || 0) + (candidateCounts.SUSPENDED || 0);

      // Normalize activity logs into a unified platform activity stream
      const normalizedAuth = (authLogs || []).map((log) => ({
        id: log.id,
        createdAt: log.createdAt,
        category: 'SECURITY',
        eventType: log.eventType,
        action: log.eventType,
        admin: log.admin,
        actor: log.admin ? `${log.admin.name} (${log.admin.email})` : 'System',
        resourceType: 'AUTHENTICATION',
        resourceName: 'Admin Portal',
        outcome: log.eventType.includes('FAIL') || log.eventType.includes('LOCKED') ? 'FAILURE' : 'SUCCESS',
        ipAddress: log.ipAddress || null,
        userAgent: log.userAgent || null,
        details: log.details || null,
      }));

      const normalizedCompany = (companyLogs || []).map((log) => ({
        id: log.id,
        createdAt: log.createdAt,
        category: 'COMPANY',
        eventType: log.action,
        action: log.action,
        admin: log.admin,
        actor: log.admin ? `${log.admin.name} (${log.admin.email})` : (log.actor || 'System'),
        resourceType: 'COMPANY',
        resourceName: log.company?.name || 'Company',
        outcome: log.action.includes('REJECT') || log.action.includes('SUSPEND') || log.action.includes('DELETE') ? 'WARNING' : 'SUCCESS',
        ipAddress: log.details?.ipAddress || null,
        userAgent: null,
        details: log.details || null,
      }));

      const normalizedBilling = (billingLogs || []).map((log) => ({
        id: log.id,
        createdAt: log.createdAt,
        category: 'BILLING',
        eventType: log.action,
        action: log.action,
        admin: log.admin,
        actor: log.admin ? `${log.admin.name} (${log.admin.email})` : (log.actor || 'System'),
        resourceType: log.entityType || 'BILLING',
        resourceName: `${log.entityType || 'Billing'} #${log.entityId ? log.entityId.slice(0, 8) : ''}`,
        outcome: log.action.includes('FAIL') || log.action.includes('CANCEL') ? 'WARNING' : 'SUCCESS',
        ipAddress: log.details?.ipAddress || null,
        userAgent: null,
        details: log.details || null,
      }));

      const normalizedConfig = (configLogs || []).map((log) => ({
        id: log.id,
        createdAt: log.createdAt,
        category: 'CONFIGURATION',
        eventType: log.action,
        action: log.action,
        admin: log.admin,
        actor: log.admin ? `${log.admin.name} (${log.admin.email})` : (log.actor || 'System'),
        resourceType: log.entityType || 'CONFIGURATION',
        resourceName: `${log.entityType || 'Config'} #${log.entityId ? log.entityId.slice(0, 8) : ''}`,
        outcome: log.action.includes('DELETE') ? 'WARNING' : 'SUCCESS',
        ipAddress: log.details?.ipAddress || null,
        userAgent: null,
        details: log.details || null,
      }));

      const unifiedRecentActivity = [
        ...normalizedAuth,
        ...normalizedCompany,
        ...normalizedBilling,
        ...normalizedConfig,
      ]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 20);

      return res.status(200).json({
        success: true,
        dateRange: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          groupBy: unit,
        },
        kpis: {
          activeJobs: {
            count: activeJobsCount,
            connected: true,
            module: 'Jobs',
            label: 'Active Jobs',
          },
          inactiveJobs: {
            count: inactiveJobsCount,
            connected: true,
            module: 'Jobs',
            label: 'Inactive Jobs',
          },
          totalCompanies: {
            count: null,
            connected: false,
            module: 'Employers',
            status: 'NOT_CONNECTED',
            message: 'Employers module scheduled for Phase 3',
          },
          totalCandidates: {
            count: totalCandidatesCount,
            connected: true,
            module: 'Candidates',
            label: 'Total Candidates',
          },
          totalAdmins: {
            count: totalAdmins,
            connected: true,
            label: 'Total Administrators',
          },
          activeAdmins: {
            count: activeAdmins,
            connected: true,
            label: 'Active Administrators',
          },
          totalAuditEvents: {
            count: totalAuditEvents,
            connected: true,
            label: 'Security Audit Events',
          },
          mfaAdoption: {
            percentage: totalAdmins > 0 ? Math.round((mfaEnrolledAdmins / totalAdmins) * 100) : 0,
            connected: true,
            label: 'MFA Adoption Rate',
          },
        },
        charts: {
          auditActivity: {
            connected: true,
            label: 'Security & Audit Events',
            dateField: 'createdAt',
            groupBy: unit,
            series: formattedSeries,
          },
          jobPostings: {
            connected: true,
            label: 'Job Postings',
            dateField: 'createdAt',
            groupBy: unit,
            series: formattedJobSeries,
            total: totalJobsCount,
            active: activeJobsCount,
            inactive: inactiveJobsCount,
            counts: jobCounts,
          },
          candidateRegistrations: {
            connected: true,
            label: 'Candidate Registrations',
            dateField: 'createdAt',
            groupBy: unit,
            series: formattedCandidateSeries,
            total: totalCandidatesCount,
            active: activeCandidatesCount,
            pending: pendingCandidatesCount,
            inactive: inactiveCandidatesCount,
            counts: candidateCounts,
          },
          employerRegistrations: {
            connected: false,
            label: 'Employer Registrations',
            series: [],
            message: 'Employers table not yet persisted',
          },
        },
        recentNotifications: {
          connected: false,
          unreadCount: 0,
          items: [],
          message: 'Notification source scheduled for Phase 3',
        },
        recentActivity: unifiedRecentActivity,
      });
    } catch (error) {
      next(error);
    }
  }

  static async exportAuditLogs(req, res, next) {
    try {
      const { from, to, eventType, search } = req.query;
      const where = {};

      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      if (eventType) {
        where.eventType = eventType;
      }

      if (search) {
        where.OR = [
          { ipAddress: { contains: search, mode: 'insensitive' } },
          { userAgent: { contains: search, mode: 'insensitive' } },
          { admin: { email: { contains: search, mode: 'insensitive' } } },
          { admin: { name: { contains: search, mode: 'insensitive' } } },
        ];
      }

      const logs = await prisma.authAuditLog.findMany({
        where,
        take: 1000,
        orderBy: { createdAt: 'desc' },
        include: {
          admin: {
            select: { id: true, email: true, name: true, role: true },
          },
        },
      });

      const headers = ['Timestamp', 'Event Type', 'Administrator Name', 'Administrator Email', 'IP Address', 'Details'];
      const rows = logs.map((log) => [
        sanitizeCsvCell(log.createdAt.toISOString()),
        sanitizeCsvCell(log.eventType),
        sanitizeCsvCell(log.admin?.name || 'System'),
        sanitizeCsvCell(log.admin?.email || 'N/A'),
        sanitizeCsvCell(log.ipAddress || 'Unknown'),
        sanitizeCsvCell(log.details ? JSON.stringify(log.details) : ''),
      ]);

      const csvContent = '\uFEFF' + [headers.map(sanitizeCsvCell).join(','), ...rows.map((r) => r.join(','))].join('\r\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${Date.now()}.csv"`);
      return res.status(200).send(csvContent);
    } catch (error) {
      next(error);
    }
  }

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

  static async updateProfile(req, res, next) {
    try {
      const { name, email, currentPassword } = req.body;
      const ipAddress = req.ip || req.connection?.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const admin = await prisma.admin.findUnique({
        where: { id: req.admin.id },
      });

      if (!admin) {
        return res.status(404).json({ success: false, error: 'Administrator not found.' });
      }

      // Re-authenticate password
      const { verifyPassword } = await import('../../lib/crypto.js');
      const isPasswordValid = await verifyPassword(admin.passwordHash, currentPassword);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'Current password is incorrect. Verification failed.',
        });
      }

      // Validate email uniqueness if changing email
      if (email && email.toLowerCase() !== admin.email.toLowerCase()) {
        const normalizedNewEmail = email.trim().toLowerCase();
        const existingWithEmail = await prisma.admin.findUnique({
          where: { email: normalizedNewEmail },
        });

        if (existingWithEmail) {
          return res.status(409).json({
            success: false,
            error: 'The requested login email is already registered to another administrator.',
          });
        }
      }

      const updateData = {};
      if (name && name.trim()) updateData.name = name.trim();
      if (email && email.trim()) updateData.email = email.trim().toLowerCase();

      const updated = await prisma.admin.update({
        where: { id: admin.id },
        data: updateData,
      });

      // Audit profile change without logging sensitive credentials
      await prisma.authAuditLog.create({
        data: {
          adminId: admin.id,
          eventType: 'SESSION_REVOKED',
          ipAddress,
          userAgent,
          details: {
            action: 'admin_profile_updated',
            previousEmail: admin.email,
            newEmail: updated.email,
            nameUpdated: Boolean(name && name !== admin.name),
          },
        },
      });

      // If email was changed, revoke other sessions in Redis for security
      if (email && email.toLowerCase() !== admin.email.toLowerCase()) {
        try {
          const { revokeAdminSessions } = await import('../../lib/redis.js');
          await revokeAdminSessions(admin.id, undefined, req.sessionID);
        } catch (err) {
          // ignore redis error
        }
      }

      const remainingBackupCodes = await prisma.adminBackupCode.count({
        where: { adminId: admin.id, usedAt: null },
      });

      const { AuthService } = await import('../auth/auth.service.js');
      return res.status(200).json({
        success: true,
        message: 'Administrator profile successfully updated.',
        user: AuthService.sanitizeAdmin(updated, remainingBackupCodes),
      });
    } catch (error) {
      next(error);
    }
  }

  static async changePassword(req, res, next) {
    try {
      const { currentPassword, newPassword } = req.body;
      const ipAddress = req.ip || req.connection?.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const admin = await prisma.admin.findUnique({
        where: { id: req.admin.id },
      });

      if (!admin) {
        return res.status(404).json({ success: false, error: 'Administrator not found.' });
      }

      const { verifyPassword, hashPassword } = await import('../../lib/crypto.js');
      const isPasswordValid = await verifyPassword(admin.passwordHash, currentPassword);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'Current password is incorrect.',
        });
      }

      const newPasswordHash = await hashPassword(newPassword);

      await prisma.admin.update({
        where: { id: admin.id },
        data: {
          passwordHash: newPasswordHash,
          passwordChangedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });

      // Audit password update
      await prisma.authAuditLog.create({
        data: {
          adminId: admin.id,
          eventType: 'PASSWORD_RESET_COMPLETED',
          ipAddress,
          userAgent,
          details: { action: 'password_changed_in_settings' },
        },
      });

      // Invalidate all OTHER sessions for this admin (preserve current active session)
      try {
        const { revokeAdminSessions } = await import('../../lib/redis.js');
        await revokeAdminSessions(admin.id, undefined, req.sessionID);
      } catch (err) {
        // ignore redis error
      }

      return res.status(200).json({
        success: true,
        message: 'Password has been successfully updated.',
      });
    } catch (error) {
      next(error);
    }
  }
}
