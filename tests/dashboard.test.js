import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, encryptTotpSecret } from '../src/lib/crypto.js';
import { generateTotpSecret } from '../src/lib/totp.js';
import { authenticator } from 'otplib';
import { assertConnectedDatabase } from '../src/config/dbSafetyGuard.js';
import {
  isTrashExpired,
  getTrashRetentionCutoff,
  prepareSoftDeletePayload,
  prepareRestorePayload,
  SOFT_DELETE_RETENTION_DAYS,
} from '../src/lib/softDelete.js';

const TEST_ADMIN_EMAIL = 'dashboard_suite_admin@recruitrain.test';
const TEST_ADMIN_PASSWORD = 'DashboardPassword123!@#';

describe('Dashboard Telemetry, Date Filtering & Export Suite', () => {
  let app;
  let testAdminId;
  let testCompanyId;
  let authCookie;
  let totpSecret;

  const TEST_CANDIDATE_EMAILS = [
    'dashboard_cand1@recruitrain.test',
    'dashboard_cand2@recruitrain.test',
  ];

  beforeAll(async () => {
    await assertConnectedDatabase(prisma);
    app = createApp();

    // Clean prior test fixtures
    const existing = await prisma.admin.findUnique({
      where: { email: TEST_ADMIN_EMAIL },
      select: { id: true },
    });
    if (existing) {
      await prisma.authAuditLog.deleteMany({ where: { adminId: existing.id } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: existing.id } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: existing.id } });
      await prisma.admin.delete({ where: { id: existing.id } });
    }

    await prisma.candidate.deleteMany({
      where: { email: { in: TEST_CANDIDATE_EMAILS } },
    });

    const company = await prisma.company.create({
      data: {
        name: 'Dashboard Analytics Test Corp',
        status: 'ACTIVE',
      },
    });
    testCompanyId = company.id;

    await prisma.job.createMany({
      data: [
        {
          companyId: testCompanyId,
          title: 'Senior Full Stack Engineer',
          description: 'Build robust enterprise apps',
          status: 'PUBLISHED',
          createdAt: new Date(),
        },
        {
          companyId: testCompanyId,
          title: 'Junior Product Designer',
          description: 'Design intuitive interfaces',
          status: 'DRAFT',
          createdAt: new Date(),
        },
        {
          companyId: testCompanyId,
          title: 'Archived Soft-deleted Role',
          description: 'Should be excluded from active analytics',
          status: 'ARCHIVED',
          deletedAt: new Date(),
          createdAt: new Date(),
        },
      ],
    });

    await prisma.candidate.createMany({
      data: [
        {
          email: TEST_CANDIDATE_EMAILS[0],
          firstName: 'Alice',
          lastName: 'Candidate',
          status: 'ACTIVE',
          createdAt: new Date(),
        },
        {
          email: TEST_CANDIDATE_EMAILS[1],
          firstName: 'Bob',
          lastName: 'Applicant',
          status: 'PENDING_APPROVAL',
          createdAt: new Date(),
        },
      ],
    });

    const passwordHash = await hashPassword(TEST_ADMIN_PASSWORD);
    const totpGen = generateTotpSecret(TEST_ADMIN_EMAIL);
    totpSecret = totpGen.secret;
    const encryptedSecret = encryptTotpSecret(totpSecret);

    const admin = await prisma.admin.create({
      data: {
        email: TEST_ADMIN_EMAIL,
        name: 'Dashboard Test Admin',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: true,
        totpSecret: encryptedSecret,
      },
    });
    testAdminId = admin.id;

    // Login and authenticate with 2FA to establish session
    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('x-test-bypass-csrf', 'true')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });

    const code = authenticator.generate(totpSecret);
    const verifyRes = await request(app)
      .post('/api/auth/verify-2fa')
      .set('x-test-bypass-csrf', 'true')
      .set('Cookie', loginRes.headers['set-cookie'])
      .send({ adminId: testAdminId, code });

    authCookie = verifyRes.headers['set-cookie'];
  });

  afterAll(async () => {
    if (testAdminId) {
      await prisma.authAuditLog.deleteMany({ where: { adminId: testAdminId } });
      await prisma.adminBackupCode.deleteMany({ where: { adminId: testAdminId } });
      await prisma.passwordResetToken.deleteMany({ where: { adminId: testAdminId } });
      await prisma.admin.deleteMany({ where: { id: testAdminId } });
    }
    if (testCompanyId) {
      await prisma.job.deleteMany({ where: { companyId: testCompanyId } });
      await prisma.company.deleteMany({ where: { id: testCompanyId } });
    }
    await prisma.candidate.deleteMany({
      where: { email: { in: TEST_CANDIDATE_EMAILS } },
    });
  });

  describe('1. Authentication & Route Protection', () => {
    it('denies access to /api/admin/dashboard when unauthenticated', async () => {
      const res = await request(app).get('/api/admin/dashboard');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('denies access to /api/admin/audit-logs/export when unauthenticated', async () => {
      const res = await request(app).get('/api/admin/audit-logs/export');
      expect(res.status).toBe(401);
    });

    it('returns genuine 404 for nonexistent API routes', async () => {
      const res = await request(app).get('/api/admin/nonexistent-route').set('Cookie', authCookie);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Route not found');
    });
  });

  describe('2. Dashboard Telemetry & KPI Aggregation', () => {
    it('returns 200 with complete KPI summaries and connected job & candidate analytics', async () => {
      const res = await request(app)
        .get('/api/admin/dashboard')
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { kpis, charts, recentNotifications } = res.body;

      // Real live metrics
      expect(kpis.totalAdmins.connected).toBe(true);
      expect(kpis.totalAdmins.count).toBeGreaterThanOrEqual(1);
      expect(kpis.activeAdmins.connected).toBe(true);
      expect(kpis.mfaAdoption.connected).toBe(true);
      expect(kpis.totalAuditEvents.connected).toBe(true);

      // Connected live jobs & candidates KPIs
      expect(kpis.activeJobs.connected).toBe(true);
      expect(kpis.activeJobs.count).toBeGreaterThanOrEqual(1);
      expect(kpis.inactiveJobs.connected).toBe(true);
      expect(kpis.inactiveJobs.count).toBeGreaterThanOrEqual(1);
      expect(kpis.totalCandidates.connected).toBe(true);
      expect(kpis.totalCandidates.count).toBeGreaterThanOrEqual(2);

      // Pending modules: verified honest not-connected states
      expect(kpis.totalCompanies.connected).toBe(false);

      // Charts
      expect(charts.auditActivity.connected).toBe(true);
      expect(Array.isArray(charts.auditActivity.series)).toBe(true);

      // Job Postings Chart
      expect(charts.jobPostings.connected).toBe(true);
      expect(Array.isArray(charts.jobPostings.series)).toBe(true);
      expect(charts.jobPostings.series.length).toBeGreaterThanOrEqual(1);
      expect(charts.jobPostings.total).toBeGreaterThanOrEqual(2);
      expect(charts.jobPostings.active).toBeGreaterThanOrEqual(1);
      expect(charts.jobPostings.counts.PUBLISHED).toBeGreaterThanOrEqual(1);
      expect(charts.jobPostings.counts.DRAFT).toBeGreaterThanOrEqual(1);

      // Candidate Registrations Chart
      expect(charts.candidateRegistrations.connected).toBe(true);
      expect(Array.isArray(charts.candidateRegistrations.series)).toBe(true);
      expect(charts.candidateRegistrations.series.length).toBeGreaterThanOrEqual(1);
      expect(charts.candidateRegistrations.total).toBeGreaterThanOrEqual(2);
      expect(charts.candidateRegistrations.active).toBeGreaterThanOrEqual(1);
      expect(charts.candidateRegistrations.pending).toBeGreaterThanOrEqual(1);

      // Employer registrations
      expect(charts.employerRegistrations.connected).toBe(false);

      // Notifications
      expect(recentNotifications.connected).toBe(false);
      expect(recentNotifications.unreadCount).toBe(0);
    });
  });

  describe('3. Date Range Filtering & Boundary Validation', () => {
    it('accepts valid date range filter with day grouping', async () => {
      const from = '2026-01-01';
      const to = '2026-12-31';

      const res = await request(app)
        .get('/api/admin/dashboard')
        .query({ from, to, groupBy: 'month' })
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.dateRange.groupBy).toBe('month');
      expect(res.body.charts.auditActivity.groupBy).toBe('month');
      expect(res.body.charts.jobPostings.groupBy).toBe('month');
      expect(res.body.charts.candidateRegistrations.groupBy).toBe('month');
    });

    it('accepts valid date range filter with year grouping', async () => {
      const from = '2024-01-01';
      const to = '2026-12-31';

      const res = await request(app)
        .get('/api/admin/dashboard')
        .query({ from, to, groupBy: 'year' })
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.dateRange.groupBy).toBe('year');
      expect(res.body.charts.auditActivity.groupBy).toBe('year');
      expect(res.body.charts.jobPostings.groupBy).toBe('year');
      expect(res.body.charts.candidateRegistrations.groupBy).toBe('year');
    });

    it('successfully processes exact frontend request: GET /api/admin/dashboard?from=2026-09-14&to=2026-10-14&groupBy=day', async () => {
      const res = await request(app)
        .get('/api/admin/dashboard?from=2026-09-14&to=2026-10-14&groupBy=day')
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.dateRange.groupBy).toBe('day');
      expect(res.body.kpis.activeJobs.connected).toBe(true);
      expect(res.body.kpis.totalCompanies.connected).toBe(false);
      expect(res.body.kpis.totalCandidates.connected).toBe(true);
      expect(res.body.charts.jobPostings.connected).toBe(true);
      expect(res.body.charts.candidateRegistrations.connected).toBe(true);
      expect(res.body.recentNotifications.connected).toBe(false);
      expect(res.body.recentActivity).toBeInstanceOf(Array);
    });

    it('rejects invalid range where start date is after end date with 400 Bad Request', async () => {
      const from = '2026-12-31';
      const to = '2026-01-01';

      const res = await request(app)
        .get('/api/admin/dashboard')
        .query({ from, to })
        .set('Cookie', authCookie);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.issues?.[0]?.message || res.body.error).toMatch(/Start date cannot be after end date/i);
    });

    it('returns empty series array when date range has no recorded activity', async () => {
      const from = '1999-01-01';
      const to = '1999-01-02';

      const res = await request(app)
        .get('/api/admin/dashboard')
        .query({ from, to })
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.charts.auditActivity.series).toHaveLength(0);
      expect(res.body.charts.jobPostings.series).toHaveLength(0);
      expect(res.body.charts.candidateRegistrations.series).toHaveLength(0);
      expect(res.body.kpis.totalAuditEvents.count).toBe(0);
    });
  });

  describe('4. Secure CSV Audit Export & Formula Injection Defense', () => {
    it('exports audit logs as CSV with proper headers and UTF-8 BOM', async () => {
      const res = await request(app)
        .get('/api/admin/audit-logs/export')
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment; filename=');

      // Verify UTF-8 BOM prefix (\uFEFF)
      expect(res.text.charCodeAt(0)).toBe(0xFEFF);
      expect(res.text).toContain('"Timestamp","Event Type"');
    });

    it('sanitizes formula triggers (=, +, -, @) to defend against CSV injection', async () => {
      // Record a test event with simulated formula input in IP address or user agent
      await prisma.authAuditLog.create({
        data: {
          adminId: testAdminId,
          eventType: 'LOGIN_FAILURE',
          ipAddress: '=1+1',
          userAgent: '@test-agent',
          details: { note: '+cmd|' },
        },
      });

      const res = await request(app)
        .get('/api/admin/audit-logs/export')
        .query({ search: '=1+1' })
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      // The formula triggers must be escaped with a leading single quote
      expect(res.text).toContain("'=1+1");
      expect(res.text).not.toMatch(/"=1\+1"/);
    });
  });

  describe('5. Soft Deletion & Trash Lifecycle Standards', () => {
    it('calculates 30-day retention cutoff correctly', () => {
      const cutoff = getTrashRetentionCutoff(SOFT_DELETE_RETENTION_DAYS);
      const expectedDays = Math.round((Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000));
      expect(expectedDays).toBe(30);
    });

    it('identifies expired trash records (>= 30 days) for purge', () => {
      const recentDeleted = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
      const expiredDeleted = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000); // 35 days ago

      expect(isTrashExpired(recentDeleted)).toBe(false);
      expect(isTrashExpired(expiredDeleted)).toBe(true);
      expect(isTrashExpired(null)).toBe(false);
    });

    it('prepares valid soft-delete and restore payloads', () => {
      const softPayload = prepareSoftDeletePayload('mock-admin-id');
      expect(softPayload.deletedAt).toBeInstanceOf(Date);
      expect(softPayload.deletedBy).toBe('mock-admin-id');

      const restorePayload = prepareRestorePayload();
      expect(restorePayload.deletedAt).toBeNull();
      expect(restorePayload.deletedBy).toBeNull();
    });
  });
});
