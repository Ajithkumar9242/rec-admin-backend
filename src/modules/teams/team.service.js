import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { BusinessEventNotificationService } from '../notifications/businessEvent.service.js';
import { env, buildEmployerActivationUrl } from '../../config/env.js';
import { generateSecureToken, hashToken } from '../../lib/crypto.js';
import { sendTeamMemberInvitationEmail, sendCompanyAdminInvitationEmail } from '../../lib/mailer.js';
import { logCompanyAction } from '../companies/companyAudit.service.js';
import { logConfigAction } from '../configuration/configAudit.service.js';
import {
  MODULES,
  ACTIONS,
  MODULE_DEFINITIONS,
  ACTION_DEFINITIONS,
  ensureSystemRoles,
  SYSTEM_ROLE_DEFINITIONS,
} from './roleBootstrap.js';
import { assertCanAssignRole } from '../../middleware/rbac.js';

export class TeamService {
  // ----------------------------------------------------
  // Teams Management
  // ----------------------------------------------------

  static async listTeams({ page = 1, limit = 20, search, companyId }, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';
    const effectiveCompanyId = !isSuperAdmin && actor?.companyId ? actor.companyId : companyId;

    const where = {
      deletedAt: null,
    };

    if (effectiveCompanyId) {
      where.companyId = effectiveCompanyId;
    } else if (actor?.companyId) {
      where.companyId = actor.companyId;
    } else if (!isSuperAdmin) {
      // Platform admin without company association: can see platform teams (companyId: null) and teams they belong to
      where.OR = [
        { companyId: null },
        { members: { some: { adminId: actor?.id } } },
      ];
    }

    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }

    const skip = (page - 1) * limit;

    const [teams, total] = await Promise.all([
      prisma.team.findMany({
        where,
        include: {
          company: {
            select: { id: true, name: true, companyCode: true, logoUrl: true },
          },
          members: {
            include: {
              admin: { select: { id: true, name: true, email: true, role: true } },
              companyUser: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  role: true,
                  status: true,
                  customRole: { select: { id: true, name: true, code: true } },
                },
              },
              role: { select: { id: true, name: true, code: true, isSystem: true } },
            },
          },
          _count: {
            select: { members: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.team.count({ where }),
    ]);

    return {
      teams,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async getTeamById(id, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';

    const team = await prisma.team.findFirst({
      where: { id, deletedAt: null },
      include: {
        company: {
          select: { id: true, name: true, companyCode: true, logoUrl: true },
        },
        members: {
          include: {
            admin: { select: { id: true, name: true, email: true, role: true } },
            companyUser: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                role: true,
                status: true,
                customRole: { select: { id: true, name: true, code: true } },
              },
            },
            role: { select: { id: true, name: true, code: true, isSystem: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!team) {
      const err = new Error('Team not found');
      err.status = 404;
      throw err;
    }

    if (!isSuperAdmin && actor?.companyId && team.companyId && team.companyId !== actor.companyId) {
      const err = new Error('Access denied: You are not authorized to view this team');
      err.status = 403;
      throw err;
    }

    return team;
  }

  static async createTeam({ name, description, companyId }, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';
    const effectiveCompanyId = !isSuperAdmin && actor?.companyId ? actor.companyId : companyId || null;

    if (effectiveCompanyId) {
      const company = await prisma.company.findUnique({
        where: { id: effectiveCompanyId },
        select: { id: true, status: true, deletedAt: true },
      });
      if (!company || company.deletedAt !== null) {
        const err = new Error('Associated company not found or moved to trash');
        err.status = 404;
        throw err;
      }
    }

    const team = await prisma.team.create({
      data: {
        name: name.trim(),
        description: description ? description.trim() : null,
        companyId: effectiveCompanyId,
      },
      include: {
        company: {
          select: { id: true, name: true, companyCode: true },
        },
      },
    });

    if (team.companyId) {
      await logCompanyAction({
        companyId: team.companyId,
        adminId: actor?.id || null,
        action: 'TEAM_CREATED',
        actor: actor?.email || 'SYSTEM',
        details: { teamId: team.id, teamName: team.name },
      });
    }

    return team;
  }

  static async updateTeam(id, { name, description }, actor) {
    const existing = await this.getTeamById(id, actor);

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description ? description.trim() : null;

    const updated = await prisma.team.update({
      where: { id },
      data: updateData,
      include: {
        company: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });

    if (updated.companyId) {
      await logCompanyAction({
        companyId: updated.companyId,
        adminId: actor?.id || null,
        action: 'TEAM_UPDATED',
        actor: actor?.email || 'SYSTEM',
        details: { teamId: updated.id, changes: updateData },
      });
    }

    return updated;
  }

  static async deleteTeam(id, actor) {
    const existing = await this.getTeamById(id, actor);

    // Soft delete team and clean up memberships
    const deleted = await prisma.$transaction(async (tx) => {
      await tx.teamMember.deleteMany({ where: { teamId: id } });
      return await tx.team.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });

    if (existing.companyId) {
      await logCompanyAction({
        companyId: existing.companyId,
        adminId: actor?.id || null,
        action: 'TEAM_DELETED',
        actor: actor?.email || 'SYSTEM',
        details: { teamId: id, teamName: existing.name },
      });
    }

    return { success: true, message: `Team "${existing.name}" deleted successfully` };
  }

  // ----------------------------------------------------
  // Team Member Management
  // ----------------------------------------------------

  static async addMember(teamId, { companyUserId, adminId, roleId }, actor) {
    const team = await this.getTeamById(teamId, actor);

    if (roleId) {
      await assertCanAssignRole(actor, roleId);
    }

    // Verify company isolation for companyUserId
    if (companyUserId) {
      const companyUser = await prisma.companyUser.findUnique({
        where: { id: companyUserId },
      });
      if (!companyUser) {
        const err = new Error('Company user not found');
        err.status = 404;
        throw err;
      }
      if (team.companyId && companyUser.companyId !== team.companyId) {
        const err = new Error('User belongs to a different company');
        err.status = 403;
        throw err;
      }
    }

    // Check if already a member
    const existingMember = await prisma.teamMember.findFirst({
      where: {
        teamId,
        OR: [
          ...(companyUserId ? [{ companyUserId }] : []),
          ...(adminId ? [{ adminId }] : []),
        ],
      },
    });

    if (existingMember) {
      const err = new Error('User is already a member of this team');
      err.status = 400;
      throw err;
    }

    const member = await prisma.teamMember.create({
      data: {
        teamId,
        companyUserId: companyUserId || null,
        adminId: adminId || null,
        roleId: roleId || null,
      },
      include: {
        companyUser: {
          select: { id: true, firstName: true, lastName: true, email: true, role: true, status: true },
        },
        admin: {
          select: { id: true, name: true, email: true, role: true },
        },
        role: {
          select: { id: true, name: true, code: true },
        },
      },
    });

    if (team.companyId) {
      await logCompanyAction({
        companyId: team.companyId,
        adminId: actor?.id || null,
        action: 'TEAM_MEMBER_ADDED',
        actor: actor?.email || 'SYSTEM',
        details: {
          teamId,
          teamName: team.name,
          memberId: member.id,
          userEmail: member.companyUser?.email || member.admin?.email,
          roleId: member.roleId,
        },
      });
    }

    return member;
  }

  static async removeMember(teamId, memberId, actor) {
    const team = await this.getTeamById(teamId, actor);

    const member = await prisma.teamMember.findFirst({
      where: { id: memberId, teamId },
      include: {
        companyUser: { select: { email: true } },
        admin: { select: { email: true } },
      },
    });

    if (!member) {
      const err = new Error('Team member not found in this team');
      err.status = 404;
      throw err;
    }

    await prisma.teamMember.delete({ where: { id: memberId } });

    if (team.companyId) {
      await logCompanyAction({
        companyId: team.companyId,
        adminId: actor?.id || null,
        action: 'TEAM_MEMBER_REMOVED',
        actor: actor?.email || 'SYSTEM',
        details: {
          teamId,
          teamName: team.name,
          memberId,
          userEmail: member.companyUser?.email || member.admin?.email,
        },
      });
    }

    return { success: true, message: 'Member removed from team successfully' };
  }

  static async updateMemberRole(teamId, memberId, { roleId, role }, actor) {
    const team = await this.getTeamById(teamId, actor);

    const member = await prisma.teamMember.findFirst({
      where: { id: memberId, teamId },
      include: {
        companyUser: true,
        admin: true,
      },
    });

    if (!member) {
      const err = new Error('Team member not found');
      err.status = 404;
      throw err;
    }

    // Prevent self-role modification / privilege escalation
    if (actor?.id && (member.adminId === actor.id || member.companyUserId === actor.id)) {
      const err = new Error('Self-role modification is not permitted to prevent privilege escalation.');
      err.status = 403;
      throw err;
    }

    // Resolve target role
    let resolvedRoleId = roleId || null;
    let systemRoleCode = role || null;

    if (roleId) {
      await assertCanAssignRole(actor, roleId);
      const targetRole = await prisma.role.findUnique({ where: { id: roleId } });
      if (targetRole && targetRole.isSystem) {
        systemRoleCode = targetRole.code;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const tm = await tx.teamMember.update({
        where: { id: memberId },
        data: { roleId: resolvedRoleId },
        include: {
          role: true,
          companyUser: true,
          admin: true,
        },
      });

      // If companyUser, sync customRoleId and role enum where applicable
      if (member.companyUserId) {
        const updateData = {};
        if (resolvedRoleId) updateData.customRoleId = resolvedRoleId;
        if (['OWNER', 'ADMIN', 'RECRUITER', 'MEMBER'].includes(systemRoleCode)) {
          updateData.role = systemRoleCode;
        }
        if (Object.keys(updateData).length > 0) {
          await tx.companyUser.update({
            where: { id: member.companyUserId },
            data: updateData,
          });
        }
      }

      return tm;
    });

    if (team.companyId) {
      await logCompanyAction({
        companyId: team.companyId,
        adminId: actor?.id || null,
        action: 'TEAM_MEMBER_ROLE_UPDATED',
        actor: actor?.email || 'SYSTEM',
        details: {
          teamId,
          memberId,
          roleId: resolvedRoleId,
          userEmail: member.companyUser?.email || member.admin?.email,
        },
      });
    }

    return updated;
  }

  static async updateMemberStatus(userId, { status }, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';

    // Prevent self-deactivation/suspension
    if (actor?.id && actor.id === userId) {
      const err = new Error('You cannot deactivate or suspend your own account.');
      err.status = 403;
      throw err;
    }

    const user = await prisma.companyUser.findUnique({
      where: { id: userId },
    });

    if (!user) {
      // Check if user is a platform Admin
      const admin = await prisma.admin.findUnique({
        where: { id: userId },
      });

      if (!admin) {
        const err = new Error('User not found');
        err.status = 404;
        throw err;
      }

      // Only SUPER_ADMIN can modify platform admin status
      if (!isSuperAdmin) {
        const err = new Error('Access denied: Only Super Admins can update platform admin status');
        err.status = 403;
        throw err;
      }

      let adminStatus = status;
      if (status === 'DEACTIVATED') adminStatus = 'INACTIVE';
      if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(adminStatus)) {
        const err = new Error(`Invalid status for platform admin: ${status}`);
        err.status = 400;
        throw err;
      }

      const updatedAdmin = await prisma.admin.update({
        where: { id: userId },
        data: { status: adminStatus },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          updatedAt: true,
        },
      });

      await logConfigAction({
        adminId: actor?.id || null,
        entityType: 'ADMIN_USER',
        entityId: admin.id,
        action: `ADMIN_STATUS_${adminStatus}`,
        actor: actor?.email || 'SYSTEM',
        details: {
          adminId: admin.id,
          adminEmail: admin.email,
          previousStatus: admin.status,
          newStatus: adminStatus,
        },
      });

      return {
        id: updatedAdmin.id,
        email: updatedAdmin.email,
        name: updatedAdmin.name,
        role: updatedAdmin.role,
        status: updatedAdmin.status === 'INACTIVE' ? 'DEACTIVATED' : updatedAdmin.status,
        updatedAt: updatedAdmin.updatedAt,
      };
    }

    if (!isSuperAdmin && !actor?.companyId) {
      const err = new Error('Access denied: Insufficient permissions');
      err.status = 403;
      throw err;
    }

    if (!isSuperAdmin && actor?.companyId && user.companyId !== actor.companyId) {
      const err = new Error('Access denied: User belongs to a different company');
      err.status = 403;
      throw err;
    }

    const updated = await prisma.companyUser.update({
      where: { id: userId },
      data: { status },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        updatedAt: true,
      },
    });

    await logCompanyAction({
      companyId: user.companyId,
      adminId: actor?.id || null,
      action: `MEMBER_STATUS_${status}`,
      actor: actor?.email || 'SYSTEM',
      details: {
        userId: user.id,
        userEmail: user.email,
        previousStatus: user.status,
        newStatus: status,
      },
    });

    return updated;
  }

  // ----------------------------------------------------
  // Member Directory & Invitations
  // ----------------------------------------------------

  static async listMembers({ page = 1, limit = 50, search, companyId, role, status }, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';
    const effectiveCompanyId = !isSuperAdmin && actor?.companyId ? actor.companyId : companyId;
    const includeAdmins = !effectiveCompanyId;

    const cuAnd = [];
    if (effectiveCompanyId) {
      cuAnd.push({ companyId: effectiveCompanyId });
    }

    if (status) {
      cuAnd.push({ status });
    }

    if (role) {
      const cuRoleOr = [
        { customRole: { code: role } },
        { customRole: { name: { equals: role, mode: 'insensitive' } } },
        {
          teamMembers: {
            some: {
              team: { deletedAt: null },
              OR: [
                { role: { code: role } },
                { role: { name: { equals: role, mode: 'insensitive' } } },
              ],
            },
          },
        },
      ];
      if (['OWNER', 'ADMIN', 'RECRUITER', 'MEMBER'].includes(role)) {
        cuRoleOr.push({ role });
      }
      cuAnd.push({ OR: cuRoleOr });
    }

    if (search && search.trim()) {
      const q = search.trim();
      cuAnd.push({
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const cuWhere = cuAnd.length > 0 ? { AND: cuAnd } : {};

    let adminWhere = null;
    if (includeAdmins) {
      const adminAnd = [
        { teamMembers: { some: { team: { deletedAt: null } } } },
      ];

      if (status) {
        if (status === 'DEACTIVATED' || status === 'INACTIVE') {
          adminAnd.push({ status: 'INACTIVE' });
        } else if (status === 'ACTIVE' || status === 'SUSPENDED' || status === 'PENDING_SETUP') {
          adminAnd.push({ status });
        } else {
          // Status like INVITED that does not exist for Admin
          adminAnd.push({ id: '__NONE__' });
        }
      }

      if (role) {
        const adminRoleOr = [
          {
            teamMembers: {
              some: {
                team: { deletedAt: null },
                OR: [
                  { role: { code: role } },
                  { role: { name: { equals: role, mode: 'insensitive' } } },
                ],
              },
            },
          },
        ];
        if (['SUPER_ADMIN', 'ADMIN'].includes(role)) {
          adminRoleOr.push({ role });
        }
        adminAnd.push({ OR: adminRoleOr });
      }

      if (search && search.trim()) {
        const q = search.trim();
        adminAnd.push({
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
          ],
        });
      }

      adminWhere = { AND: adminAnd };
    }

    const [users, admins] = await Promise.all([
      prisma.companyUser.findMany({
        where: cuWhere,
        include: {
          company: { select: { id: true, name: true, companyCode: true } },
          customRole: { select: { id: true, name: true, code: true, isSystem: true } },
          teamMembers: {
            where: { team: { deletedAt: null } },
            include: {
              team: { select: { id: true, name: true } },
              role: { select: { id: true, name: true, code: true } },
            },
          },
          invitations: {
            where: { acceptedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, expiresAt: true, sentAt: true, createdAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      includeAdmins
        ? prisma.admin.findMany({
            where: adminWhere,
            include: {
              teamMembers: {
                where: { team: { deletedAt: null } },
                include: {
                  team: { select: { id: true, name: true, companyId: true } },
                  role: { select: { id: true, name: true, code: true, isSystem: true } },
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);

    const mappedCompanyUsers = users.map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
      role: u.role,
      customRole: u.customRole,
      effectiveRoleName: u.customRole?.name || u.customRole?.code || u.role,
      status: u.status,
      company: u.company,
      teams: u.teamMembers.map((tm) => ({
        teamId: tm.team.id,
        teamName: tm.team.name,
        role: tm.role?.name || tm.role?.code || u.role,
      })),
      pendingInvitation: u.invitations[0] || null,
      memberType: 'COMPANY_USER',
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }));

    const mappedAdmins = admins.map((a) => {
      const primaryRole = a.teamMembers[0]?.role;
      const nameParts = (a.name || '').trim().split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      return {
        id: a.id,
        email: a.email,
        firstName,
        lastName,
        name: a.name || a.email,
        role: primaryRole?.code || a.role,
        adminRole: a.role,
        customRole: primaryRole || null,
        effectiveRoleName: primaryRole?.code || a.role,
        status: a.status === 'INACTIVE' ? 'DEACTIVATED' : a.status,
        company: null,
        teams: a.teamMembers.map((tm) => ({
          teamId: tm.team.id,
          teamName: tm.team.name,
          role: tm.role?.code || tm.role?.name || a.role,
        })),
        pendingInvitation: null,
        memberType: 'PLATFORM_ADMIN',
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
    });

    const allMembers = [...mappedAdmins, ...mappedCompanyUsers].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const total = allMembers.length;
    const skip = (page - 1) * limit;
    const pagedMembers = allMembers.slice(skip, skip + limit);

    return {
      members: pagedMembers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  static async inviteMember({ email, firstName, lastName, teamId, companyId, role = 'MEMBER', roleId }, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';
    const effectiveCompanyId = !isSuperAdmin && actor?.companyId ? actor.companyId : companyId;

    if (!effectiveCompanyId) {
      const err = new Error('Company association is required for member invitation.');
      err.status = 400;
      throw err;
    }

    const company = await prisma.company.findUnique({
      where: { id: effectiveCompanyId },
    });
    if (!company || company.deletedAt !== null) {
      const err = new Error('Target company not found or moved to trash.');
      err.status = 404;
      throw err;
    }

    if (roleId) {
      await assertCanAssignRole(actor, roleId);
    }

    let team = null;
    if (teamId) {
      team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!team || team.deletedAt !== null) {
        const err = new Error('Target team not found.');
        err.status = 404;
        throw err;
      }
      if (team.companyId && team.companyId !== effectiveCompanyId) {
        const err = new Error('Team belongs to a different company.');
        err.status = 400;
        throw err;
      }
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if CompanyUser already exists
    let user = await prisma.companyUser.findUnique({
      where: { companyId_email: { companyId: effectiveCompanyId, email: normalizedEmail } },
    });

    if (user && user.status === 'ACTIVE') {
      // User already active. If teamId provided, add to team directly
      if (teamId) {
        const existingTm = await prisma.teamMember.findFirst({
          where: { teamId, companyUserId: user.id },
        });
        if (!existingTm) {
          await prisma.teamMember.create({
            data: {
              teamId,
              companyUserId: user.id,
              roleId: roleId || user.customRoleId || null,
            },
          });
        }
      }
      return {
        success: true,
        isExistingUser: true,
        message: `User ${normalizedEmail} is already active and has been linked to the team.`,
        data: user,
      };
    }

    // Generate cryptographic token
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresHours = env.COMPANY_INVITATION_EXPIRES_HOURS || 48;
    const expiresAt = new Date(Date.now() + expiresHours * 3600 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      if (!user) {
        const activeSub = await tx.subscription.findFirst({
          where: { companyId: effectiveCompanyId, status: 'ACTIVE' },
        });
        if (activeSub) {
          const currentCount = await tx.companyUser.count({
            where: { companyId: effectiveCompanyId },
          });
          if (currentCount >= activeSub.teamMemberLimit) {
            const err = new Error(
              `Team member quota exceeded for this employer (${currentCount}/${activeSub.teamMemberLimit}).`
            );
            err.status = 403;
            err.code = 'QUOTA_EXCEEDED';
            throw err;
          }
        }

        user = await tx.companyUser.create({
          data: {
            companyId: effectiveCompanyId,
            email: normalizedEmail,
            firstName: firstName ? firstName.trim() : null,
            lastName: lastName ? lastName.trim() : null,
            role,
            customRoleId: roleId || null,
            status: 'INVITED',
          },
        });
      } else {
        user = await tx.companyUser.update({
          where: { id: user.id },
          data: {
            firstName: firstName ? firstName.trim() : user.firstName,
            lastName: lastName ? lastName.trim() : user.lastName,
            role,
            customRoleId: roleId || user.customRoleId,
          },
        });
      }

      // Invalidate existing pending invitations for this user
      await tx.companyInvitation.deleteMany({
        where: { userId: user.id, acceptedAt: null },
      });

      // Create invitation
      const invitation = await tx.companyInvitation.create({
        data: {
          companyId: effectiveCompanyId,
          userId: user.id,
          email: normalizedEmail,
          role,
          customRoleId: roleId || null,
          tokenHash,
          expiresAt,
        },
      });

      // Add to team if teamId is provided
      if (teamId) {
        const existingTm = await tx.teamMember.findFirst({
          where: { teamId, companyUserId: user.id },
        });
        if (!existingTm) {
          await tx.teamMember.create({
            data: {
              teamId,
              companyUserId: user.id,
              roleId: roleId || null,
            },
          });
        }
      }

      return { user, invitation };
    });

    // Dispatch invitation email
    const activationUrl = buildEmployerActivationUrl(rawToken);
    let mailRes;
    try {
      mailRes = await sendTeamMemberInvitationEmail({
        to: normalizedEmail,
        recipientName: [firstName, lastName].filter(Boolean).join(' ') || normalizedEmail,
        companyName: company.name,
        teamName: team?.name || null,
        roleName: roleId ? (await prisma.role.findUnique({ where: { id: roleId } }))?.name : role,
        invitationUrl: activationUrl,
        expiresHours,
      });
    } catch (mailErr) {
      logger.warn({ error: mailErr.message, email: normalizedEmail }, 'Failed to dispatch team invitation email');
      mailRes = { success: false, delivered: false, error: mailErr.message };
    }

    await logCompanyAction({
      companyId: effectiveCompanyId,
      adminId: actor?.id || null,
      action: 'TEAM_MEMBER_INVITED',
      actor: actor?.email || 'SYSTEM',
      details: {
        userId: result.user.id,
        email: normalizedEmail,
        teamId: teamId || null,
        role,
        roleId: roleId || null,
        delivered: Boolean(mailRes?.delivered),
      },
    });

    return {
      success: true,
      message: `Invitation successfully sent to ${normalizedEmail}.`,
      data: {
        user: result.user,
        invitationId: result.invitation.id,
        delivered: Boolean(mailRes?.delivered),
        activationUrl: !mailRes?.delivered ? activationUrl : undefined,
      },
    };
  }

  static async resendInvitation(invitationId, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';

    const invitation = await prisma.companyInvitation.findUnique({
      where: { id: invitationId },
      include: {
        company: true,
        user: true,
        customRole: true,
      },
    });

    if (!invitation) {
      const err = new Error('Invitation record not found.');
      err.status = 404;
      throw err;
    }

    if (invitation.acceptedAt !== null) {
      const err = new Error('This invitation has already been accepted.');
      err.status = 400;
      throw err;
    }

    if (!isSuperAdmin && actor?.companyId && invitation.companyId !== actor.companyId) {
      const err = new Error('Access denied: You are not authorized to resend invitations for this company.');
      err.status = 403;
      throw err;
    }

    // Cooldown verification: 60 seconds
    const COOLDOWN_SECONDS = 60;
    const now = Date.now();
    const lastSent = new Date(invitation.sentAt).getTime();
    const elapsed = Math.floor((now - lastSent) / 1000);

    if (elapsed < COOLDOWN_SECONDS) {
      const waitTime = COOLDOWN_SECONDS - elapsed;
      const err = new Error(`Please wait ${waitTime} seconds before resending another invitation.`);
      err.status = 429;
      throw err;
    }

    // Regenerate cryptographic token
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresHours = env.COMPANY_INVITATION_EXPIRES_HOURS || 48;
    const expiresAt = new Date(now + expiresHours * 3600 * 1000);

    const updated = await prisma.companyInvitation.update({
      where: { id: invitationId },
      data: {
        tokenHash,
        expiresAt,
        sentAt: new Date(),
      },
    });

    const activationUrl = buildEmployerActivationUrl(rawToken);
    let mailRes;
    try {
      mailRes = await sendTeamMemberInvitationEmail({
        to: invitation.email,
        recipientName: [invitation.user?.firstName, invitation.user?.lastName].filter(Boolean).join(' ') || invitation.email,
        companyName: invitation.company.name,
        roleName: invitation.customRole?.name || invitation.role,
        invitationUrl: activationUrl,
        expiresHours,
      });
    } catch (mailErr) {
      mailRes = { success: false, delivered: false, error: mailErr.message };
    }

    await logCompanyAction({
      companyId: invitation.companyId,
      adminId: actor?.id || null,
      action: 'TEAM_INVITATION_RESENT',
      actor: actor?.email || 'SYSTEM',
      details: {
        invitationId: invitation.id,
        email: invitation.email,
        delivered: Boolean(mailRes?.delivered),
      },
    });

    return {
      success: true,
      message: `Invitation resent successfully to ${invitation.email}.`,
      data: {
        invitationId: updated.id,
        expiresAt: updated.expiresAt,
        sentAt: updated.sentAt,
        delivered: Boolean(mailRes?.delivered),
        activationUrl: !mailRes?.delivered ? activationUrl : undefined,
      },
    };
  }

  // ----------------------------------------------------
  // Role & Permissions Management
  // ----------------------------------------------------

  static async listRoles({ companyId } = {}, actor) {
    await ensureSystemRoles(prisma);

    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';
    const effectiveCompanyId = !isSuperAdmin && actor?.companyId ? actor.companyId : companyId;

    const where = effectiveCompanyId
      ? {
          OR: [
            { isSystem: true },
            { companyId: effectiveCompanyId },
          ],
        }
      : isSuperAdmin
      ? {}
      : { isSystem: true };

    const roles = await prisma.role.findMany({
      where,
      include: {
        permissions: true,
        company: { select: { id: true, name: true, companyCode: true } },
        _count: {
          select: { teamMembers: true, companyUsers: true },
        },
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });

    // Format permission matrix for each role: { [module]: { [action]: boolean } }
    const formatted = roles.map((r) => {
      const matrix = {};
      for (const mod of MODULES) {
        matrix[mod] = {};
        for (const act of ACTIONS) {
          matrix[mod][act] = false;
        }
      }
      for (const p of r.permissions) {
        if (matrix[p.module]) {
          matrix[p.module][p.action] = p.allowed;
        }
      }

      return {
        id: r.id,
        name: r.name,
        code: r.code,
        description: r.description,
        isSystem: r.isSystem,
        companyId: r.companyId,
        company: r.company,
        assignedCount: (r._count?.teamMembers || 0) + (r._count?.companyUsers || 0),
        permissions: matrix,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });

    return formatted;
  }

  static async getRoleById(id, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';

    const role = await prisma.role.findUnique({
      where: { id },
      include: {
        permissions: true,
        company: { select: { id: true, name: true } },
        _count: { select: { teamMembers: true, companyUsers: true } },
      },
    });

    if (!role) {
      const err = new Error('Role not found');
      err.status = 404;
      throw err;
    }

    if (!isSuperAdmin && actor?.companyId && role.companyId && role.companyId !== actor.companyId) {
      const err = new Error('Access denied: You are not authorized to view this role');
      err.status = 403;
      throw err;
    }

    const matrix = {};
    for (const mod of MODULES) {
      matrix[mod] = {};
      for (const act of ACTIONS) {
        matrix[mod][act] = false;
      }
    }
    for (const p of role.permissions) {
      if (matrix[p.module]) {
        matrix[p.module][p.action] = p.allowed;
      }
    }

    return {
      id: role.id,
      name: role.name,
      code: role.code,
      description: role.description,
      isSystem: role.isSystem,
      companyId: role.companyId,
      company: role.company,
      assignedCount: (role._count?.teamMembers || 0) + (role._count?.companyUsers || 0),
      permissions: matrix,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }

  static async createRole({ name, description, companyId, permissions = [] }, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';
    const effectiveCompanyId = !isSuperAdmin && actor?.companyId ? actor.companyId : companyId || null;

    // Generate unique code slug: CUSTOM_<name_slug>_<random>
    const slug = name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .slice(0, 30);
    const code = `CUSTOM_${slug}_${generateSecureToken(4).toUpperCase()}`;

    const created = await prisma.$transaction(async (tx) => {
      const r = await tx.role.create({
        data: {
          name: name.trim(),
          code,
          description: description ? description.trim() : null,
          isSystem: false,
          companyId: effectiveCompanyId,
        },
      });

      // Build permissions records for all modules x actions
      const permMap = new Map();
      for (const p of permissions) {
        permMap.set(`${p.module}:${p.action}`, Boolean(p.allowed));
      }

      const records = [];
      for (const mod of MODULES) {
        for (const act of ACTIONS) {
          records.push({
            roleId: r.id,
            module: mod,
            action: act,
            allowed: permMap.get(`${mod}:${act}`) || false,
          });
        }
      }

      await tx.rolePermission.createMany({ data: records });

      return r;
    });

    if (effectiveCompanyId) {
      await logCompanyAction({
        companyId: effectiveCompanyId,
        adminId: actor?.id || null,
        action: 'CUSTOM_ROLE_CREATED',
        actor: actor?.email || 'SYSTEM',
        details: { roleId: created.id, roleName: created.name, code: created.code },
      });
    }

    return this.getRoleById(created.id, actor);
  }

  static async updateRole(id, { name, description, permissions }, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';
    const role = await prisma.role.findUnique({
      where: { id },
      include: { permissions: true },
    });

    if (!role) {
      const err = new Error('Role not found');
      err.status = 404;
      throw err;
    }

    if (role.isSystem && !isSuperAdmin) {
      const err = new Error('System roles can only be updated by Super Administrators.');
      err.status = 403;
      throw err;
    }

    if (!isSuperAdmin && actor?.companyId && role.companyId !== actor.companyId) {
      const err = new Error('Access denied: You are not authorized to modify this role.');
      err.status = 403;
      throw err;
    }

    const updateData = {};
    if (name !== undefined && !role.isSystem) {
      updateData.name = name.trim();
    }
    if (description !== undefined) {
      updateData.description = description ? description.trim() : null;
    }

    await prisma.$transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx.role.update({
          where: { id },
          data: updateData,
        });
      }

      if (permissions && Array.isArray(permissions)) {
        for (const p of permissions) {
          await tx.rolePermission.upsert({
            where: {
              roleId_module_action: {
                roleId: id,
                module: p.module,
                action: p.action,
              },
            },
            update: { allowed: Boolean(p.allowed) },
            create: {
              roleId: id,
              module: p.module,
              action: p.action,
              allowed: Boolean(p.allowed),
            },
          });
        }
      }
    });

    if (role.companyId) {
      await logCompanyAction({
        companyId: role.companyId,
        adminId: actor?.id || null,
        action: 'ROLE_UPDATED',
        actor: actor?.email || 'SYSTEM',
        details: { roleId: role.id, roleName: role.name },
      });
    }

    const updatedRole = await this.getRoleById(id, actor);

    BusinessEventNotificationService.notifyRoleUpdated({
      role: updatedRole,
      actorName: actor?.name || actor?.email || 'Administrator',
      changesSummary: permissions ? `${permissions.length} permission(s) adjusted` : 'Role details updated',
    }).catch((err) => logger.warn(`[Teams] Failed to send role updated notification: ${err.message}`));

    return updatedRole;
  }

  static async deleteRole(id, actor) {
    const isSuperAdmin = actor?.role === 'SUPER_ADMIN';
    const role = await prisma.role.findUnique({
      where: { id },
      include: {
        _count: { select: { teamMembers: true, companyUsers: true } },
      },
    });

    if (!role) {
      const err = new Error('Role not found');
      err.status = 404;
      throw err;
    }

    if (role.isSystem) {
      const err = new Error('System roles cannot be deleted.');
      err.status = 400;
      throw err;
    }

    if (!isSuperAdmin && actor?.companyId && role.companyId !== actor.companyId) {
      const err = new Error('Access denied: You are not authorized to delete this role.');
      err.status = 403;
      throw err;
    }

    const totalAssigned = (role._count?.teamMembers || 0) + (role._count?.companyUsers || 0);
    if (totalAssigned > 0) {
      const err = new Error(
        `Cannot delete role "${role.name}" because it is currently assigned to ${totalAssigned} member(s). Reassign them first.`
      );
      err.status = 400;
      throw err;
    }

    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.role.delete({ where: { id } });
    });

    if (role.companyId) {
      await logCompanyAction({
        companyId: role.companyId,
        adminId: actor?.id || null,
        action: 'ROLE_DELETED',
        actor: actor?.email || 'SYSTEM',
        details: { roleId: id, roleName: role.name },
      });
    }

    return { success: true, message: `Role "${role.name}" deleted successfully.` };
  }

  static getPermissionSchema() {
    return {
      modules: MODULE_DEFINITIONS,
      actions: ACTION_DEFINITIONS,
    };
  }
}
