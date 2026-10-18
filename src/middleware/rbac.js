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

  // Super Admin check
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
      companyId: null,
      permissions: fullPermissions,
    };
  }

  // 1. If actor is an Admin with role ADMIN
  if (actor.role === 'ADMIN' && !actor.companyId) {
    // Platform Admin has platform-wide access to all modules
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
      companyId: null,
      permissions: adminPermissions,
    };
  }

  // 2. If actor has a customRoleId attached
  let customRole = null;
  if (actor.customRoleId) {
    customRole = await prisma.role.findUnique({
      where: { id: actor.customRoleId },
      include: { permissions: true },
    });
  }

  if (customRole) {
    const permissions = {};
    for (const mod of MODULES) {
      permissions[mod] = {};
      for (const act of ACTIONS) {
        permissions[mod][act] = false;
      }
    }
    for (const p of customRole.permissions) {
      if (permissions[p.module]) {
        permissions[p.module][p.action] = p.allowed;
      }
    }

    return {
      isSuperAdmin: false,
      roleId: customRole.id,
      roleCode: customRole.code,
      roleName: customRole.name,
      companyId: actor.companyId || customRole.companyId || null,
      permissions,
    };
  }

  // 3. Fallback to mapped system role
  let systemRoleCode = 'READ_ONLY';
  if (actor.role === 'OWNER' || actor.role === 'ADMIN' || actor.role === 'COMPANY_ADMIN') {
    systemRoleCode = 'COMPANY_ADMIN';
  } else if (actor.role === 'RECRUITER') {
    systemRoleCode = 'RECRUITER';
  } else if (actor.role === 'HIRING_MANAGER') {
    systemRoleCode = 'HIRING_MANAGER';
  }

  // Load system role permissions from database or fallback definition
  let systemRole = await prisma.role.findFirst({
    where: { code: systemRoleCode, isSystem: true, companyId: null },
    include: { permissions: true },
  });

  if (!systemRole) {
    await ensureSystemRoles(prisma);
    systemRole = await prisma.role.findFirst({
      where: { code: systemRoleCode, isSystem: true, companyId: null },
      include: { permissions: true },
    });
  }

  const permissions = {};
  for (const mod of MODULES) {
    permissions[mod] = {};
    for (const act of ACTIONS) {
      permissions[mod][act] = false;
    }
  }

  if (systemRole && systemRole.permissions) {
    for (const p of systemRole.permissions) {
      if (permissions[p.module]) {
        permissions[p.module][p.action] = p.allowed;
      }
    }
  } else {
    const fallback = SYSTEM_ROLE_DEFINITIONS[systemRoleCode]?.permissions || {};
    for (const mod of MODULES) {
      for (const act of ACTIONS) {
        permissions[mod][act] = Boolean(fallback[mod]?.[act]);
      }
    }
  }

  return {
    isSuperAdmin: false,
    roleId: systemRole?.id || null,
    roleCode: systemRoleCode,
    companyId: actor.companyId || null,
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

      // Platform admin bypass
      if (effective.isPlatformAdmin) {
        return next();
      }

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
        const targetCompanyId =
          req.params.companyId ||
          req.body?.companyId ||
          req.query?.companyId;

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
