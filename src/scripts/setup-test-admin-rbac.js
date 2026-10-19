import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '../lib/prisma.js';
import { TeamService } from '../modules/teams/team.service.js';
import { getEffectivePermissions } from '../middleware/rbac.js';
import { MODULES, ACTIONS } from '../modules/teams/roleBootstrap.js';
import { extractDatabaseName, sanitizeDatabaseUrl } from '../config/dbSafetyGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TARGET_EMAIL = 'testadmin@recruitrain.test';
const EXPECTED_ADMIN_ID = 'd10b4e83-2238-40e0-b3b8-d52848be1545';
const EXPECTED_ROLE_ID = '21540e5c-95a7-45c2-95a4-287ff634affa';
const EXPECTED_ROLE_CODE = 'READ_ONLY';
const DESIRED_TEAM_NAME = 'Platform Governance';

async function setupTestAdminRbac() {
  console.log('====================================================');
  console.log(' RecruiTrain RBAC Setup: Restricted Platform Admin');
  console.log('====================================================');

  // 1. Database Safety Check
  const rawDbUrl = process.env.DATABASE_URL || '';
  const dbName = extractDatabaseName(rawDbUrl);
  console.log(`[Safety Guard] Target Database: "${dbName}" (${sanitizeDatabaseUrl(rawDbUrl)})`);

  if (process.env.NODE_ENV === 'production') {
    throw new Error('ABORT: setup-test-admin-rbac must NOT be executed in a production environment.');
  }

  // 2. Super Admin Actor Resolution for Audited Service Calls
  const superAdmin = await prisma.admin.findFirst({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
    select: { id: true, email: true, role: true, name: true },
  });

  if (!superAdmin) {
    throw new Error('ABORT: An active Super Administrator record is required to perform authorized team assignment.');
  }
  const actor = {
    id: superAdmin.id,
    email: superAdmin.email,
    role: 'SUPER_ADMIN',
  };

  // 3. Verify Target Test Admin
  console.log(`[1/5] Verifying Target Admin account "${TARGET_EMAIL}"...`);
  const admin = await prisma.admin.findUnique({
    where: { email: TARGET_EMAIL },
    select: { id: true, email: true, name: true, role: true, status: true },
  });

  if (!admin) {
    throw new Error(`ABORT: Target admin account "${TARGET_EMAIL}" does not exist in the database.`);
  }

  if (admin.id !== EXPECTED_ADMIN_ID) {
    console.warn(`[Warning] Admin ID mismatch: expected ${EXPECTED_ADMIN_ID}, found ${admin.id}. Proceeding with found account ID.`);
  }

  if (admin.role !== 'ADMIN') {
    throw new Error(`ABORT: Target admin role is "${admin.role}". Expected strictly "ADMIN". Never downgrade Super Admin or promote to Super Admin.`);
  }

  if (admin.status !== 'ACTIVE') {
    throw new Error(`ABORT: Target admin status is "${admin.status}". Account must be "ACTIVE".`);
  }
  console.log(`  ✓ Found Admin: ${admin.name} (ID: ${admin.id}, Role: ${admin.role}, Status: ${admin.status})`);

  // 4. Verify Target Role
  console.log(`[2/5] Verifying Global READ_ONLY role...`);
  const targetRole = await prisma.role.findFirst({
    where: {
      code: EXPECTED_ROLE_CODE,
      isSystem: true,
      companyId: null,
    },
    include: {
      permissions: true,
    },
  });

  if (!targetRole) {
    throw new Error(`ABORT: Global system role "${EXPECTED_ROLE_CODE}" was not found.`);
  }

  if (targetRole.id !== EXPECTED_ROLE_ID) {
    console.warn(`[Warning] Role ID mismatch: expected ${EXPECTED_ROLE_ID}, found ${targetRole.id}. Proceeding with found role ID.`);
  }

  // Validate exact permission matrix
  const permissionsMap = {};
  for (const p of targetRole.permissions) {
    if (!permissionsMap[p.module]) permissionsMap[p.module] = {};
    permissionsMap[p.module][p.action] = p.allowed;
  }

  for (const mod of MODULES) {
    if (!permissionsMap[mod] || permissionsMap[mod].READ !== true) {
      throw new Error(`ABORT: Role "${EXPECTED_ROLE_CODE}" does not have READ permission enabled for module "${mod}".`);
    }
    for (const act of ACTIONS) {
      if (act !== 'READ' && permissionsMap[mod][act] === true) {
        throw new Error(`ABORT: Role "${EXPECTED_ROLE_CODE}" unexpectedly has "${act}" permission enabled for module "${mod}".`);
      }
    }
  }
  console.log(`  ✓ Role "${targetRole.name}" (${targetRole.id}) verified: READ=true, CREATE/EDIT/DELETE/EXPORT=false across all 7 modules.`);

  // 5. Check Existing Memberships & Detect Conflicts
  console.log(`[3/5] Checking existing team memberships for conflict detection...`);
  const existingMemberships = await prisma.teamMember.findMany({
    where: { adminId: admin.id },
    include: {
      team: true,
      role: true,
    },
  });

  let team = null;

  if (existingMemberships.length > 0) {
    const matchingMembership = existingMemberships.find(
      (m) =>
        m.team?.name === DESIRED_TEAM_NAME &&
        m.team?.companyId === null &&
        m.roleId === targetRole.id
    );

    if (matchingMembership && existingMemberships.length === 1) {
      console.log(`  ✓ Idempotency check: Account is already assigned to "${DESIRED_TEAM_NAME}" with role "${targetRole.name}".`);
      team = matchingMembership.team;
    } else {
      console.error('  ✗ CONFLICT DETECTED: Admin already has conflicting team memberships:');
      for (const m of existingMemberships) {
        console.error(`    - Team: "${m.team?.name}" (Company ID: ${m.team?.companyId || 'Platform'}), Role: "${m.role?.name || m.roleId}"`);
      }
      throw new Error('ABORT: Conflicting team membership exists. Resolve manually to avoid unexpected state mutations.');
    }
  }

  // 6. Find or Create the Platform Team
  if (!team) {
    console.log(`[4/5] Resolving platform-level team "${DESIRED_TEAM_NAME}"...`);
    team = await prisma.team.findFirst({
      where: {
        name: DESIRED_TEAM_NAME,
        companyId: null,
        deletedAt: null,
      },
    });

    if (team) {
      console.log(`  ✓ Reusing existing platform team "${team.name}" (ID: ${team.id})`);
    } else {
      team = await TeamService.createTeam(
        {
          name: DESIRED_TEAM_NAME,
          description: 'Platform Governance & Auditing Team (Global Platform Scope)',
          companyId: null,
        },
        actor
      );
      console.log(`  ✓ Created new platform team "${team.name}" (ID: ${team.id}, Scope: Platform/Global)`);
    }

    // 7. Assign Admin to Team via Supported Service Method
    console.log(`[5/5] Assigning admin "${admin.email}" to team "${team.name}" with role "${targetRole.name}"...`);
    const newMember = await TeamService.addMember(
      team.id,
      {
        adminId: admin.id,
        roleId: targetRole.id,
      },
      actor
    );
    console.log(`  ✓ Membership created successfully (TeamMember ID: ${newMember.id})`);
  }

  // 8. Verification of Effective Permissions
  console.log('\n--- VERIFICATION: Evaluating Effective Permissions ---');
  const freshAdmin = await prisma.admin.findUnique({
    where: { id: admin.id },
  });
  const effective = await getEffectivePermissions(freshAdmin);

  console.log(`  isSuperAdmin : ${effective.isSuperAdmin} (Must be false)`);
  console.log(`  roleCode     : ${effective.roleCode} (Must be READ_ONLY)`);
  console.log(`  roleName     : ${effective.roleName}`);
  console.log(`  companyId    : ${effective.companyId} (Must be null - Platform Scope)`);

  if (effective.isSuperAdmin !== false) {
    throw new Error('VERIFICATION FAILED: isSuperAdmin is not false!');
  }
  if (effective.roleCode !== EXPECTED_ROLE_CODE) {
    throw new Error(`VERIFICATION FAILED: roleCode is "${effective.roleCode}", expected "${EXPECTED_ROLE_CODE}"!`);
  }

  // Check all permissions
  for (const mod of MODULES) {
    const modPerms = effective.permissions?.[mod] || {};
    if (modPerms.READ !== true) {
      throw new Error(`VERIFICATION FAILED: Module "${mod}" READ is not true!`);
    }
    for (const act of ACTIONS) {
      if (act !== 'READ' && modPerms[act] === true) {
        throw new Error(`VERIFICATION FAILED: Module "${mod}" action "${act}" is unexpectedly true!`);
      }
    }
  }

  console.log('  ✓ All 7 modules confirmed: READ=true, CREATE=false, EDIT=false, DELETE=false, EXPORT=false.');
  console.log('\n====================================================');
  console.log(' Setup completed successfully!                      ');
  console.log(` Test account: ${admin.email}                       `);
  console.log(` Team:         ${team.name}                        `);
  console.log(` Role:         ${targetRole.name} (${targetRole.code})`);
  console.log('====================================================');
}

setupTestAdminRbac()
  .catch((err) => {
    console.error('\nSetup Failed:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
