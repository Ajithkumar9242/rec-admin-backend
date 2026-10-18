import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import { ensureSystemRoles } from '../src/modules/teams/roleBootstrap.js';
import { TeamService } from '../src/modules/teams/team.service.js';

const TEST_ADMIN_EMAIL = 'teams_rbac_superadmin@recruitrain.test';
const TEST_PASSWORD = 'TeamsSuperSecure123!@#';

describe('Phase 5: Teams & Permission Management (RBAC) Integration Suite', () => {
  let app;
  let adminId;
  let adminCookie;
  let adminTotpSecret;

  const cleanupCompanyIds = [];
  const cleanupTeamIds = [];
  const cleanupRoleIds = [];

  beforeAll(async () => {
    const connectedDb = await assertConnectedDatabase(prisma);
    expect(connectedDb).toBe('recruitrain_admin_test');

    app = createApp();

    // Ensure system roles
    await ensureSystemRoles(prisma);

    // Clean prior admin if exists
    const existingAdmin = await prisma.admin.findUnique({
      where: { email: TEST_ADMIN_EMAIL },
      select: { id: true },
    });
    if (existingAdmin) {
      await prisma.teamMember.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.companyAuditLog.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.authAuditLog.deleteMany({ where: { adminId: existingAdmin.id } });
      await prisma.admin.delete({ where: { id: existingAdmin.id } });
    }

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const totpGen = generateTotpSecret(TEST_ADMIN_EMAIL);
    adminTotpSecret = totpGen.secret;
    const encryptedSecret = encryptTotpSecret(adminTotpSecret);

    const admin = await prisma.admin.create({
      data: {
        email: TEST_ADMIN_EMAIL,
        name: 'Teams RBAC Super Admin',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptedSecret,
      },
    });
    adminId = admin.id;

    // Login & 2FA
    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });

    const code = authenticator.generate(adminTotpSecret);
    const verifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', loginRes.headers['set-cookie'])
      .send({ adminId, code });

    adminCookie = verifyRes.headers['set-cookie'];
  }, 30000);

  afterAll(async () => {
    if (cleanupTeamIds.length > 0) {
      await prisma.teamMember.deleteMany({ where: { teamId: { in: cleanupTeamIds } } });
      await prisma.team.deleteMany({ where: { id: { in: cleanupTeamIds } } });
    }
    if (cleanupRoleIds.length > 0) {
      await prisma.rolePermission.deleteMany({ where: { roleId: { in: cleanupRoleIds } } });
      await prisma.role.deleteMany({ where: { id: { in: cleanupRoleIds } } });
    }
    if (cleanupCompanyIds.length > 0) {
      await prisma.companyAuditLog.deleteMany({ where: { companyId: { in: cleanupCompanyIds } } });
      await prisma.companyInvitation.deleteMany({ where: { companyId: { in: cleanupCompanyIds } } });
      await prisma.teamMember.deleteMany({ where: { companyUser: { companyId: { in: cleanupCompanyIds } } } });
      await prisma.team.deleteMany({ where: { companyId: { in: cleanupCompanyIds } } });
      await prisma.companyUser.deleteMany({ where: { companyId: { in: cleanupCompanyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: cleanupCompanyIds } } });
    }
    if (adminId) {
      await prisma.teamMember.deleteMany({ where: { adminId } });
      await prisma.companyAuditLog.deleteMany({ where: { adminId } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId } });
      await prisma.authAuditLog.deleteMany({ where: { adminId } });
      await prisma.admin.deleteMany({ where: { id: adminId } });
    }
  }, 30000);

  describe('1. Role-Based Access Control (RBAC) System Roles & Schema', () => {
    it('seeds and returns system roles with full permission matrices', async () => {
      const res = await request(app)
        .get('/api/roles')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);

      const codes = res.body.data.map((r) => r.code);
      expect(codes).toContain('SUPER_ADMIN');
      expect(codes).toContain('COMPANY_ADMIN');
      expect(codes).toContain('RECRUITER');
      expect(codes).toContain('HIRING_MANAGER');
      expect(codes).toContain('READ_ONLY');

      // Verify SUPER_ADMIN has true for all modules and actions
      const superAdminRole = res.body.data.find((r) => r.code === 'SUPER_ADMIN');
      expect(superAdminRole.permissions.CANDIDATES.CREATE).toBe(true);
      expect(superAdminRole.permissions.TEAMS.DELETE).toBe(true);
      expect(superAdminRole.permissions.BILLING.EXPORT).toBe(true);

      // Verify RECRUITER permissions
      const recruiterRole = res.body.data.find((r) => r.code === 'RECRUITER');
      expect(recruiterRole.permissions.CANDIDATES.CREATE).toBe(true);
      expect(recruiterRole.permissions.BILLING.READ).toBe(false);
    });

    it('returns the permission schema containing modules and actions', async () => {
      const res = await request(app)
        .get('/api/roles/schema')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.modules.length).toBeGreaterThanOrEqual(7);
      expect(res.body.data.actions.length).toBe(5);

      const actionKeys = res.body.data.actions.map((a) => a.key);
      expect(actionKeys).toEqual(['READ', 'CREATE', 'EDIT', 'DELETE', 'EXPORT']);
    });

    it('returns the current authenticated user permissions via /api/roles/me', async () => {
      const res = await request(app)
        .get('/api/roles/me')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isSuperAdmin).toBe(true);
      expect(res.body.data.roleCode).toBe('SUPER_ADMIN');
      expect(res.body.data.permissions.TEAMS.CREATE).toBe(true);
    });
  });

  describe('2. Custom Roles CRUD & Safety Guards', () => {
    let customRoleId;

    it('creates a custom role with a granular permission matrix', async () => {
      const res = await request(app)
        .post('/api/roles')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          name: 'Talent Acquisition Specialist',
          description: 'Specialist role focusing on candidate sourcing and pipeline reviews',
          permissions: [
            { module: 'CANDIDATES', action: 'READ', allowed: true },
            { module: 'CANDIDATES', action: 'CREATE', allowed: true },
            { module: 'CANDIDATES', action: 'EDIT', allowed: true },
            { module: 'CANDIDATES', action: 'EXPORT', allowed: true },
            { module: 'JOBS', action: 'READ', allowed: true },
            { module: 'APPLICATIONS', action: 'READ', allowed: true },
            { module: 'APPLICATIONS', action: 'EDIT', allowed: true },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Talent Acquisition Specialist');
      expect(res.body.data.isSystem).toBe(false);
      expect(res.body.data.permissions.CANDIDATES.CREATE).toBe(true);
      expect(res.body.data.permissions.BILLING.READ).toBe(false);

      customRoleId = res.body.data.id;
      cleanupRoleIds.push(customRoleId);
    });

    it('updates custom role permissions', async () => {
      const res = await request(app)
        .put(`/api/roles/${customRoleId}`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          name: 'Senior Talent Acquisition Specialist',
          description: 'Updated description',
          permissions: [
            { module: 'JOBS', action: 'CREATE', allowed: true },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Senior Talent Acquisition Specialist');
      expect(res.body.data.permissions.JOBS.CREATE).toBe(true);
    });

    it('prohibits deleting system roles', async () => {
      const rolesRes = await request(app)
        .get('/api/roles')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      const companyAdminRole = rolesRes.body.data.find((r) => r.code === 'COMPANY_ADMIN');

      const delRes = await request(app)
        .delete(`/api/roles/${companyAdminRole.id}`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(delRes.status).toBe(400);
      expect(delRes.body.error).toMatch(/system roles cannot be deleted/i);
    });

    it('deletes an unassigned custom role successfully', async () => {
      const delRes = await request(app)
        .delete(`/api/roles/${customRoleId}`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      const check = await prisma.role.findUnique({ where: { id: customRoleId } });
      expect(check).toBeNull();
    });
  });

  describe('3. Teams Lifecycle & Member Management', () => {
    let testCompanyId;
    let testTeamId;
    let testCompanyUserId;
    let testInvitationId;

    beforeAll(async () => {
      // Create a test company
      const company = await prisma.company.create({
        data: {
          name: 'Acme RBAC Test Corp',
          companyCode: `ACME-RBAC-${Date.now().toString().slice(-4)}`,
          status: 'ACTIVE',
        },
      });
      testCompanyId = company.id;
      cleanupCompanyIds.push(testCompanyId);
    });

    it('creates a team successfully', async () => {
      const res = await request(app)
        .post('/api/teams')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          name: 'Tech Recruitment Core',
          description: 'Primary technical hiring squad',
          companyId: testCompanyId,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Tech Recruitment Core');
      expect(res.body.data.companyId).toBe(testCompanyId);

      testTeamId = res.body.data.id;
      cleanupTeamIds.push(testTeamId);
    });

    it('updates team details', async () => {
      const res = await request(app)
        .put(`/api/teams/${testTeamId}`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          name: 'Tech Recruitment Alpha',
          description: 'Updated squad description',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Tech Recruitment Alpha');
    });

    it('invites a new member by email with secure cryptographic token and role assignment', async () => {
      const memberEmail = `squad_member_${Date.now()}@acme.test`;
      const res = await request(app)
        .post('/api/teams/members/invite')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({
          email: memberEmail,
          firstName: 'Alice',
          lastName: 'Recruiter',
          companyId: testCompanyId,
          teamId: testTeamId,
          role: 'RECRUITER',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(memberEmail);
      expect(res.body.data.user.status).toBe('INVITED');

      testCompanyUserId = res.body.data.user.id;
      testInvitationId = res.body.data.invitationId;

      // Verify token hash is stored in database
      const invitationRecord = await prisma.companyInvitation.findUnique({
        where: { id: testInvitationId },
      });
      expect(invitationRecord).not.toBeNull();
      expect(invitationRecord.tokenHash).toBeDefined();
      expect(invitationRecord.acceptedAt).toBeNull();
    });

    it('enforces 60-second cooldown on resending invitations', async () => {
      const res = await request(app)
        .post(`/api/teams/members/invitations/${testInvitationId}/resend`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(429);
      expect(res.body.error).toMatch(/please wait \d+ seconds/i);
    });

    it('lists team members in directory with team association and invitation metadata', async () => {
      const res = await request(app)
        .get('/api/teams/members/directory')
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .query({ companyId: testCompanyId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.members.length).toBeGreaterThanOrEqual(1);

      const member = res.body.members.find((m) => m.id === testCompanyUserId);
      expect(member).toBeDefined();
      expect(member.status).toBe('INVITED');
      expect(member.teams.some((t) => t.teamId === testTeamId)).toBe(true);
      expect(member.pendingInvitation).not.toBeNull();
    });

    it('updates member status to ACTIVE, SUSPENDED, DEACTIVATED', async () => {
      // Activate
      const actRes = await request(app)
        .patch(`/api/teams/members/${testCompanyUserId}/status`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({ status: 'ACTIVE' });

      expect(actRes.status).toBe(200);
      expect(actRes.body.data.status).toBe('ACTIVE');

      // Suspend
      const suspRes = await request(app)
        .patch(`/api/teams/members/${testCompanyUserId}/status`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({ status: 'SUSPENDED' });

      expect(suspRes.status).toBe(200);
      expect(suspRes.body.data.status).toBe('SUSPENDED');
    });

    it('prohibits self-deactivation or self-suspension to prevent accidental lockout', async () => {
      const res = await request(app)
        .patch(`/api/teams/members/${adminId}/status`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true')
        .send({ status: 'DEACTIVATED' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/cannot deactivate or suspend your own account/i);
    });

    it('removes member from team', async () => {
      // Find team member record
      const tm = await prisma.teamMember.findFirst({
        where: { teamId: testTeamId, companyUserId: testCompanyUserId },
      });
      expect(tm).not.toBeNull();

      const res = await request(app)
        .delete(`/api/teams/${testTeamId}/members/${tm.id}`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const check = await prisma.teamMember.findUnique({ where: { id: tm.id } });
      expect(check).toBeNull();
    });

    it('soft deletes team', async () => {
      const res = await request(app)
        .delete(`/api/teams/${testTeamId}`)
        .set('Cookie', adminCookie)
        .set('x-test-bypass-csrf', 'true');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const check = await prisma.team.findUnique({ where: { id: testTeamId } });
      expect(check.deletedAt).not.toBeNull();
    });
  });

  describe('4. Company Isolation & Privilege Escalation Protection', () => {
    let companyA;
    let companyB;
    let teamA;

    beforeAll(async () => {
      companyA = await prisma.company.create({
        data: { name: 'Isolation Company A', status: 'ACTIVE' },
      });
      companyB = await prisma.company.create({
        data: { name: 'Isolation Company B', status: 'ACTIVE' },
      });
      cleanupCompanyIds.push(companyA.id, companyB.id);

      teamA = await prisma.team.create({
        data: { name: 'Company A Secret Team', companyId: companyA.id },
      });
      cleanupTeamIds.push(teamA.id);
    });

    it('blocks company user from accessing another company team', async () => {
      // Mock actor belonging to companyB
      const companyBActor = {
        id: 'mock-user-b',
        role: 'COMPANY_ADMIN',
        companyId: companyB.id,
      };

      await expect(TeamService.getTeamById(teamA.id, companyBActor)).rejects.toThrow(
        /Access denied: You are not authorized to view this team/i
      );
    });

    it('blocks assigning higher privileges than own (privilege escalation guard)', async () => {
      const recruiterActor = {
        id: 'mock-recruiter',
        role: 'RECRUITER',
        companyId: companyA.id,
      };

      // Non-super-admin trying to assign SUPER_ADMIN role
      await expect(TeamService.addMember(teamA.id, { companyUserId: 'dummy', roleId: 'SUPER_ADMIN' }, recruiterActor)).rejects.toThrow(
        /Only Super Administrators can assign or create Super Admin roles/i
      );
    });
  });
});
