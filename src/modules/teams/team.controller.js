import { TeamService } from './team.service.js';
import { getEffectivePermissions } from '../../middleware/rbac.js';

export class TeamController {
  // ----------------------------------------------------
  // Teams
  // ----------------------------------------------------

  static async listTeams(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const result = await TeamService.listTeams(req.query, actor);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getTeamById(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const team = await TeamService.getTeamById(req.params.id, actor);
      return res.status(200).json({
        success: true,
        data: team,
      });
    } catch (error) {
      next(error);
    }
  }

  static async createTeam(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const team = await TeamService.createTeam(req.body, actor);
      return res.status(201).json({
        success: true,
        message: 'Team created successfully',
        data: team,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateTeam(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const team = await TeamService.updateTeam(req.params.id, req.body, actor);
      return res.status(200).json({
        success: true,
        message: 'Team updated successfully',
        data: team,
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteTeam(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const result = await TeamService.deleteTeam(req.params.id, actor);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  // ----------------------------------------------------
  // Team Members
  // ----------------------------------------------------

  static async addMember(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const member = await TeamService.addMember(req.params.id, req.body, actor);
      return res.status(201).json({
        success: true,
        message: 'Member added to team successfully',
        data: member,
      });
    } catch (error) {
      next(error);
    }
  }

  static async removeMember(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const result = await TeamService.removeMember(req.params.id, req.params.memberId, actor);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async updateMemberRole(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const updated = await TeamService.updateMemberRole(req.params.id, req.params.memberId, req.body, actor);
      return res.status(200).json({
        success: true,
        message: 'Member role updated successfully',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateMemberStatus(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const updated = await TeamService.updateMemberStatus(req.params.userId, req.body, actor);
      return res.status(200).json({
        success: true,
        message: `Member status updated to ${req.body.status}`,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  static async listMembers(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const result = await TeamService.listMembers(req.query, actor);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async inviteMember(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const result = await TeamService.inviteMember(req.body, actor);
      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async resendInvitation(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const result = await TeamService.resendInvitation(req.params.invitationId, actor);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  // ----------------------------------------------------
  // Roles & Permissions
  // ----------------------------------------------------

  static async listRoles(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const roles = await TeamService.listRoles(req.query, actor);
      return res.status(200).json({
        success: true,
        data: roles,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getRoleById(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const role = await TeamService.getRoleById(req.params.id, actor);
      return res.status(200).json({
        success: true,
        data: role,
      });
    } catch (error) {
      next(error);
    }
  }

  static async createRole(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const role = await TeamService.createRole(req.body, actor);
      return res.status(201).json({
        success: true,
        message: 'Role created successfully',
        data: role,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateRole(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const role = await TeamService.updateRole(req.params.id, req.body, actor);
      return res.status(200).json({
        success: true,
        message: 'Role updated successfully',
        data: role,
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteRole(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const result = await TeamService.deleteRole(req.params.id, actor);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async getPermissionSchema(req, res, next) {
    try {
      const schema = TeamService.getPermissionSchema();
      return res.status(200).json({
        success: true,
        data: schema,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getMyPermissions(req, res, next) {
    try {
      const actor = req.admin || req.companyUser;
      const effective = await getEffectivePermissions(actor);
      return res.status(200).json({
        success: true,
        data: effective,
      });
    } catch (error) {
      next(error);
    }
  }
}
