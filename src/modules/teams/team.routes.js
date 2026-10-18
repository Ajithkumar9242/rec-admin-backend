import { Router } from 'express';
import { TeamController } from './team.controller.js';
import {
  authenticateSession,
  require2FAVerified,
} from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  listTeamsSchema,
  getTeamByIdSchema,
  createTeamSchema,
  updateTeamSchema,
  deleteTeamSchema,
  addTeamMemberSchema,
  removeTeamMemberSchema,
  updateTeamMemberRoleSchema,
  updateMemberStatusSchema,
  inviteTeamMemberSchema,
  resendTeamInvitationSchema,
  createRoleSchema,
  updateRoleSchema,
  deleteRoleSchema,
} from './team.validation.js';

const teamRouter = Router();
const roleRouter = Router();

// Protect all routes with verified session & 2FA
teamRouter.use(authenticateSession);
teamRouter.use(require2FAVerified);

roleRouter.use(authenticateSession);
roleRouter.use(require2FAVerified);

// ----------------------------------------------------
// Member Directory & Invitation Routes (Must be before :id)
// ----------------------------------------------------
teamRouter.get(
  '/members/directory',
  requirePermission('TEAMS', 'READ'),
  TeamController.listMembers
);

teamRouter.post(
  '/members/invite',
  requirePermission('TEAMS', 'CREATE'),
  validate(inviteTeamMemberSchema),
  TeamController.inviteMember
);

teamRouter.post(
  '/members/invitations/:invitationId/resend',
  requirePermission('TEAMS', 'CREATE'),
  validate(resendTeamInvitationSchema),
  TeamController.resendInvitation
);

teamRouter.patch(
  '/members/:userId/status',
  requirePermission('TEAMS', 'EDIT'),
  validate(updateMemberStatusSchema),
  TeamController.updateMemberStatus
);

// ----------------------------------------------------
// Teams CRUD Routes
// ----------------------------------------------------
teamRouter.get(
  '/',
  requirePermission('TEAMS', 'READ'),
  validate(listTeamsSchema),
  TeamController.listTeams
);

teamRouter.post(
  '/',
  requirePermission('TEAMS', 'CREATE'),
  validate(createTeamSchema),
  TeamController.createTeam
);

teamRouter.get(
  '/:id',
  requirePermission('TEAMS', 'READ'),
  validate(getTeamByIdSchema),
  TeamController.getTeamById
);

teamRouter.put(
  '/:id',
  requirePermission('TEAMS', 'EDIT'),
  validate(updateTeamSchema),
  TeamController.updateTeam
);

teamRouter.delete(
  '/:id',
  requirePermission('TEAMS', 'DELETE'),
  validate(deleteTeamSchema),
  TeamController.deleteTeam
);

// ----------------------------------------------------
// Team Membership Routes
// ----------------------------------------------------
teamRouter.post(
  '/:id/members',
  requirePermission('TEAMS', 'EDIT'),
  validate(addTeamMemberSchema),
  TeamController.addMember
);

teamRouter.delete(
  '/:id/members/:memberId',
  requirePermission('TEAMS', 'EDIT'),
  validate(removeTeamMemberSchema),
  TeamController.removeMember
);

teamRouter.patch(
  '/:id/members/:memberId/role',
  requirePermission('TEAMS', 'EDIT'),
  validate(updateTeamMemberRoleSchema),
  TeamController.updateMemberRole
);

// ----------------------------------------------------
// Roles & Permissions Routes
// ----------------------------------------------------
roleRouter.get(
  '/schema',
  requirePermission('TEAMS', 'READ'),
  TeamController.getPermissionSchema
);

roleRouter.get(
  '/me',
  TeamController.getMyPermissions
);

roleRouter.get(
  '/',
  requirePermission('TEAMS', 'READ'),
  TeamController.listRoles
);

roleRouter.post(
  '/',
  requirePermission('TEAMS', 'CREATE'),
  validate(createRoleSchema),
  TeamController.createRole
);

roleRouter.get(
  '/:id',
  requirePermission('TEAMS', 'READ'),
  TeamController.getRoleById
);

roleRouter.put(
  '/:id',
  requirePermission('TEAMS', 'EDIT'),
  validate(updateRoleSchema),
  TeamController.updateRole
);

roleRouter.delete(
  '/:id',
  requirePermission('TEAMS', 'DELETE'),
  validate(deleteRoleSchema),
  TeamController.deleteRole
);

export { teamRouter, roleRouter };
