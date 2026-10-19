import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { MODULES, ACTIONS, ensureSystemRoles, SYSTEM_ROLE_DEFINITIONS } from '../modules/teams/roleBootstrap.js';

/**
 * Resolves the effective role and permissions for an authenticated actor (Admin or CompanyUser).
 */
export async function getEffectivePermissions(actor) {
  if (!actor) {
    return {
      isSuperAdmin: false,
      roleCode: null,
      companyId: null,
      permissions: {},
    };
  }

  // Super Admin check: strictly reserved for SUPER_ADMIN role
  if (actor.role === 'SUPER_ADMIN') {
    const fullPermissions = {};
    for (const mod of MODULES) {
      fullPermissions[mod] = {};
      for (const act of ACTIONS) {
        fullPermissions[mod][act] = true;
      }
    }
    return {
      isSuperAdmin: true,
      roleCode: 'SUPER_ADMIN',
      roleName: 'Super Admin',
      companyId: null,
      permissions: fullPermissions,
    };
  }

  let resolvedRole = null;
  let memberCompanyId = null;

  // 1. Check if actor has an explicit TeamMember role assignment
  if (actor.id) {
    const membership = await prisma.teamMember.findFirst({
      where: {
        team: { deletedAt: null },
        OR: [
          { adminId: actor.id },
          { companyUserId: actor.id },
        ],
      },
      include: {
        role: {
          include: { permissions: true },
        },
        team: {
          select: { companyId: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (membership?.role) {
      resolvedRole = membership.role;
      memberCompanyId = membership.team?.companyId || null;
    }
  }

  // 2. If actor has a customRoleId directly attached (e.g. on CompanyUser)
  if (!resolvedRole && actor.customRoleId) {
    resolvedRole = await prisma.role.findUnique({
      where: { id: actor.customRoleId },
      include: { permissions: true },
    });
  }

  // 3. Unassigned Platform Admin fallback (unrestricted platform admin unless explicitly assigned to a restricted team role)
  if (!resolvedRole && actor.role === 'ADMIN' && !actor.companyId) {
    const adminPermissions = {};
    for (const mod of MODULES) {
      adminPermissions[mod] = {};
      for (const act of ACTIONS) {
        adminPermissions[mod][act] = true;
      }
    }
    return {
      isSuperAdmin: false,
      isPlatformAdmin: true,
      roleCode: 'ADMIN',
      roleName: 'Platform Administrator',
      companyId: null,
      permissions: adminPermissions,
    };
  }

  // 4. Fallback to mapped system role
  let systemRoleCode = 'READ_ONLY';
  if (actor.role === 'OWNER' || actor.role === 'ADMIN' || actor.role === 'COMPANY_ADMIN') {
    systemRoleCode = 'COMPANY_ADMIN';
  } else if (actor.role === 'RECRUITER') {
    systemRoleCode = 'RECRUITER';
  } else if (actor.role === 'HIRING_MANAGER') {
    systemRoleCode = 'HIRING_MANAGER';
  } else if (actor.role === 'READ_ONLY' || actor.role === 'MEMBER') {
    systemRoleCode = 'READ_ONLY';
  }

  if (!resolvedRole) {
    resolvedRole = await prisma.role.findFirst({
      where: { code: systemRoleCode, isSystem: true, companyId: null },
      include: { permissions: true },
    });

    if (!resolvedRole) {
      await ensureSystemRoles(prisma);
      resolvedRole = await prisma.role.findFirst({
        where: { code: systemRoleCode, isSystem: true, companyId: null },
        include: { permissions: true },
      });
    }
  }

  const permissions = {};
  for (const mod of MODULES) {
    permissions[mod] = {};
    for (const act of ACTIONS) {
      permissions[mod][act] = false;
    }
  }

  if (resolvedRole?.permissions?.length) {
    for (const p of resolvedRole.permissions) {
      if (permissions[p.module]) {
        permissions[p.module][p.action] = p.allowed;
      }
    }
  } else {
    const fallback = SYSTEM_ROLE_DEFINITIONS[resolvedRole?.code || systemRoleCode]?.permissions || {};
    for (const mod of MODULES) {
      for (const act of ACTIONS) {
        permissions[mod][act] = Boolean(fallback[mod]?.[act]);
      }
    }
  }

  return {
    isSuperAdmin: false,
    roleId: resolvedRole?.id || null,
    roleCode: resolvedRole?.code || systemRoleCode,
    roleName: resolvedRole?.name || resolvedRole?.code || systemRoleCode,
    companyId: actor.companyId || memberCompanyId || resolvedRole?.companyId || null,
    permissions,
  };
}

/**
 * Middleware factory requiring a specific module and action permission.
 * e.g. requirePermission('TEAMS', 'READ') or requirePermission('CANDIDATES', 'CREATE')
 */
export function requirePermission(module, action) {
  return async (req, res, next) => {
    try {
      const actor = req.admin || req.companyUser;

      if (!actor) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required to access this resource.',
        });
      }

      // Super Admin bypasses all checks platform-wide
      if (actor.role === 'SUPER_ADMIN') {
        req.permissions = await getEffectivePermissions(actor);
        return next();
      }

      const effective = await getEffectivePermissions(actor);
      req.permissions = effective;

      // Check module and action
      const hasPermission = Boolean(effective.permissions?.[module]?.[action]);
      if (!hasPermission) {
        logger.warn(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            role: effective.roleCode,
            requiredModule: module,
            requiredAction: action,
          },
          'Access forbidden: insufficient RBAC permissions'
        );
        return res.status(403).json({
          success: false,
          error: `Forbidden: You do not have '${action}' permission for the '${module}' module.`,
          required: { module, action },
        });
      }

      // Check company isolation if actor has a company association
      const actorCompanyId = actor.companyId || effective.companyId;
      if (actorCompanyId) {
        const isCompanyRoute = req.baseUrl?.includes('companies');
        let targetCompanyId =
          req.params.companyId ||
          (isCompanyRoute && req.params.id ? req.params.id : null) ||
          req.body?.companyId ||
          req.query?.companyId;

        // Verify tenant scope for job resources
        if (!targetCompanyId && req.baseUrl?.includes('jobs') && req.params.id) {
          const job = await prisma.job.findUnique({
            where: { id: req.params.id },
            select: { companyId: true },
          });
          if (job) targetCompanyId = job.companyId;
        }

        // Verify tenant scope for team resources
        if (!targetCompanyId && req.baseUrl?.includes('teams') && req.params.id) {
          const team = await prisma.team.findUnique({
            where: { id: req.params.id },
            select: { companyId: true },
          });
          if (team?.companyId) targetCompanyId = team.companyId;
        }

        if (targetCompanyId && targetCompanyId !== actorCompanyId) {
          logger.warn(
            { actorId: actor.id, actorCompanyId, targetCompanyId },
            'Access forbidden: cross-company access prohibited'
          );
          return res.status(403).json({
            success: false,
            error: 'Access denied: You are not authorized to view or manage resources of another company.',
          });
        }
      }

      next();
    } catch (err) {
      logger.error({ error: err.message }, 'Error in requirePermission middleware');
      return res.status(500).json({
        success: false,
        error: 'Internal authorization error.',
      });
    }
  };
}

/**
 * Validates that an actor cannot assign a role with more permissions than their own
 * or perform unauthorized privilege escalation.
 */
export async function assertCanAssignRole(actor, targetRoleCodeOrId) {
  if (actor.role === 'SUPER_ADMIN') {
    return true;
  }

  // Non-super-admins cannot assign or create SUPER_ADMIN role
  if (targetRoleCodeOrId === 'SUPER_ADMIN') {
    const error = new Error('Only Super Administrators can assign or create Super Admin roles.');
    error.status = 403;
    throw error;
  }

  // Load target role
  const targetRole = await prisma.role.findFirst({
    where: {
      OR: [{ id: targetRoleCodeOrId }, { code: targetRoleCodeOrId }],
    },
    include: { permissions: true },
  });

  if (!targetRole) {
    const error = new Error(`Role "${targetRoleCodeOrId}" does not exist.`);
    error.status = 404;
    throw error;
  }

  if (targetRole.code === 'SUPER_ADMIN') {
    const error = new Error('Only Super Administrators can assign the Super Admin role.');
    error.status = 403;
    throw error;
  }

  // If actor is company-scoped, ensure target role belongs to their company or is an allowed system role
  if (actor.companyId && targetRole.companyId && targetRole.companyId !== actor.companyId) {
    const error = new Error('Cannot assign a role belonging to another company.');
    error.status = 403;
    throw error;
  }

  return true;
}
