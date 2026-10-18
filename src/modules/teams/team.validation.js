import { z } from 'zod';
import { MODULES, ACTIONS } from './roleBootstrap.js';

export const listTeamsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    companyId: z.string().uuid().optional(),
  }),
});

export const getTeamByIdSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const createTeamSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Team name must be at least 2 characters').max(100),
    description: z.string().trim().max(500).optional().nullable(),
    companyId: z.string().uuid().optional().nullable(),
  }),
});

export const updateTeamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().trim().min(2, 'Team name must be at least 2 characters').max(100).optional(),
    description: z.string().trim().max(500).optional().nullable(),
  }),
});

export const deleteTeamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const addTeamMemberSchema = z.object({
  params: z.object({
    id: z.string().uuid(), // teamId
  }),
  body: z.object({
    companyUserId: z.string().uuid().optional(),
    adminId: z.string().uuid().optional(),
    roleId: z.string().optional().nullable(),
  }).refine((data) => data.companyUserId || data.adminId, {
    message: 'Either companyUserId or adminId is required',
  }),
});

export const removeTeamMemberSchema = z.object({
  params: z.object({
    id: z.string().uuid(), // teamId
    memberId: z.string().uuid(),
  }),
});

export const updateTeamMemberRoleSchema = z.object({
  params: z.object({
    id: z.string().uuid(), // teamId
    memberId: z.string().uuid(),
  }),
  body: z.object({
    roleId: z.string().optional().nullable(),
    role: z.string().optional(),
  }),
});

export const updateMemberStatusSchema = z.object({
  params: z.object({
    userId: z.string().uuid(),
  }),
  body: z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
  }),
});

export const inviteTeamMemberSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Valid email address is required').toLowerCase(),
    firstName: z.string().trim().max(80).optional(),
    lastName: z.string().trim().max(80).optional(),
    teamId: z.string().uuid().optional().nullable(),
    companyId: z.string().uuid().optional().nullable(),
    role: z.enum(['OWNER', 'ADMIN', 'RECRUITER', 'MEMBER']).default('MEMBER'),
    roleId: z.string().optional().nullable(),
  }),
});

export const resendTeamInvitationSchema = z.object({
  params: z.object({
    invitationId: z.string().uuid(),
  }),
});

export const permissionItemSchema = z.object({
  module: z.enum(MODULES),
  action: z.enum(ACTIONS),
  allowed: z.boolean(),
});

export const createRoleSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Role name must be at least 2 characters').max(80),
    description: z.string().trim().max(500).optional().nullable(),
    companyId: z.string().uuid().optional().nullable(),
    permissions: z.array(permissionItemSchema).optional(),
  }),
});

export const updateRoleSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().trim().min(2, 'Role name must be at least 2 characters').max(80).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    permissions: z.array(permissionItemSchema).optional(),
  }),
});

export const deleteRoleSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});
