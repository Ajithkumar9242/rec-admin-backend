import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export const MODULES = [
  'DASHBOARD',
  'COMPANIES',
  'CANDIDATES',
  'JOBS',
  'APPLICATIONS',
  'TEAMS',
  'BILLING',
];

export const ACTIONS = [
  'READ',
  'CREATE',
  'EDIT',
  'DELETE',
  'EXPORT',
];

export const MODULE_DEFINITIONS = [
  { key: 'DASHBOARD', label: 'Dashboard & Analytics', description: 'Overview metrics, activity charts, and system reports' },
  { key: 'COMPANIES', label: 'Companies', description: 'Company profiles, business details, verification and settings' },
  { key: 'CANDIDATES', label: 'Candidates', description: 'Candidate profiles, resumes, evaluations and talent pool' },
  { key: 'JOBS', label: 'Jobs', description: 'Job openings, job descriptions, publication status and requirements' },
  { key: 'APPLICATIONS', label: 'Applications & Pipeline', description: 'Candidate job applications, stage progression, and hiring decisions' },
  { key: 'TEAMS', label: 'Teams & Permissions', description: 'Team management, member invitations, and role-based permissions' },
  { key: 'BILLING', label: 'Billing & Subscriptions', description: 'Subscriptions, invoices, payment history and credit packages' },
];

export const ACTION_DEFINITIONS = [
  { key: 'READ', label: 'Read / View', description: 'View data and reports in this module' },
  { key: 'CREATE', label: 'Create', description: 'Create new records and items in this module' },
  { key: 'EDIT', label: 'Edit', description: 'Modify and update existing records' },
  { key: 'DELETE', label: 'Delete', description: 'Remove or archive records' },
  { key: 'EXPORT', label: 'Export', description: 'Export records to CSV, PDF or external files' },
];

export const SYSTEM_ROLE_DEFINITIONS = {
  SUPER_ADMIN: {
    name: 'Super Admin',
    code: 'SUPER_ADMIN',
    description: 'Complete platform-wide administrative control across all modules and settings.',
    permissions: MODULES.reduce((acc, mod) => {
      acc[mod] = ACTIONS.reduce((a, act) => { a[act] = true; return a; }, {});
      return acc;
    }, {}),
  },
  COMPANY_ADMIN: {
    name: 'Company Admin',
    code: 'COMPANY_ADMIN',
    description: 'Full administrative control over company team members, jobs, candidates, and applications.',
    permissions: {
      DASHBOARD: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: true },
      COMPANIES: { READ: true, CREATE: false, EDIT: true, DELETE: false, EXPORT: false },
      CANDIDATES: { READ: true, CREATE: true, EDIT: true, DELETE: true, EXPORT: true },
      JOBS: { READ: true, CREATE: true, EDIT: true, DELETE: true, EXPORT: true },
      APPLICATIONS: { READ: true, CREATE: true, EDIT: true, DELETE: true, EXPORT: true },
      TEAMS: { READ: true, CREATE: true, EDIT: true, DELETE: true, EXPORT: true },
      BILLING: { READ: true, CREATE: false, EDIT: true, DELETE: false, EXPORT: true },
    },
  },
  RECRUITER: {
    name: 'Recruiter',
    code: 'RECRUITER',
    description: 'Can manage candidates, create and edit jobs, and review candidate applications.',
    permissions: {
      DASHBOARD: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      COMPANIES: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      CANDIDATES: { READ: true, CREATE: true, EDIT: true, DELETE: false, EXPORT: true },
      JOBS: { READ: true, CREATE: true, EDIT: true, DELETE: false, EXPORT: false },
      APPLICATIONS: { READ: true, CREATE: true, EDIT: true, DELETE: false, EXPORT: true },
      TEAMS: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      BILLING: { READ: false, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
    },
  },
  HIRING_MANAGER: {
    name: 'Hiring Manager',
    code: 'HIRING_MANAGER',
    description: 'Can view candidates and jobs, advance application stages, and leave candidate feedback.',
    permissions: {
      DASHBOARD: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      COMPANIES: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      CANDIDATES: { READ: true, CREATE: false, EDIT: true, DELETE: false, EXPORT: false },
      JOBS: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      APPLICATIONS: { READ: true, CREATE: false, EDIT: true, DELETE: false, EXPORT: false },
      TEAMS: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      BILLING: { READ: false, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
    },
  },
  READ_ONLY: {
    name: 'Read Only',
    code: 'READ_ONLY',
    description: 'Can view data across modules without the ability to modify, create, or delete.',
    permissions: {
      DASHBOARD: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      COMPANIES: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      CANDIDATES: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      JOBS: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      APPLICATIONS: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      TEAMS: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
      BILLING: { READ: true, CREATE: false, EDIT: false, DELETE: false, EXPORT: false },
    },
  },
};

/**
 * Ensures system roles exist in the database with their designated permissions.
 * Safe to run repeatedly (idempotent).
 */
export async function ensureSystemRoles(client = prisma) {
  const seeded = [];

  for (const [code, def] of Object.entries(SYSTEM_ROLE_DEFINITIONS)) {
    // Check if role exists
    let role = await client.role.findFirst({
      where: { code, isSystem: true, companyId: null },
      include: { permissions: true },
    });

    if (!role) {
      role = await client.role.create({
        data: {
          code,
          name: def.name,
          description: def.description,
          isSystem: true,
          companyId: null,
        },
        include: { permissions: true },
      });
    }

    // Ensure permissions are up to date
    const existingPerms = new Map(
      role.permissions.map((p) => [`${p.module}:${p.action}`, p])
    );

    const permOps = [];
    for (const mod of MODULES) {
      for (const act of ACTIONS) {
        const allowed = Boolean(def.permissions[mod]?.[act]);
        const key = `${mod}:${act}`;
        const existing = existingPerms.get(key);

        if (!existing) {
          permOps.push(
            client.rolePermission.create({
              data: {
                roleId: role.id,
                module: mod,
                action: act,
                allowed,
              },
            })
          );
        }
      }
    }

    if (permOps.length > 0) {
      await Promise.all(permOps);
    }

    seeded.push(role);
  }

  return seeded;
}
