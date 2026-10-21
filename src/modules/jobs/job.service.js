import { prisma } from '../../lib/prisma.js';
import { EntitlementService } from '../billing/entitlement.service.js';
import { evaluateJobApprovalStatus } from '../configuration/jobApprovalPolicy.js';
import {
  validateResumeFile,
  enforceEmployerContactVisibility,
} from '../configuration/candidateVisibilityPolicy.js';
import { inspectFileSignature } from '../../lib/fileValidation.js';
import { logCompanyAction } from '../companies/companyAudit.service.js';
import { logger } from '../../lib/logger.js';
import { BusinessEventNotificationService } from '../notifications/businessEvent.service.js';

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.status = statusCode;
  error.statusCode = statusCode;
  return error;
}

/**
 * Deterministically maps a RecruitmentStage to its corresponding ApplicationStatus enum value.
 */
export function mapStageToApplicationStatus(stage) {
  if (!stage) return 'IN_REVIEW';

  const category = stage.category;
  switch (category) {
    case 'HIRED':
      return 'HIRED';
    case 'REJECTED':
      return 'REJECTED';
    case 'OFFER':
      return 'OFFER';
    case 'INTERVIEW':
      return 'INTERVIEW';
    case 'EVALUATION':
      return 'SHORTLISTED';
    case 'SCREENING':
      return 'IN_REVIEW';
    case 'SOURCING':
      return 'SUBMITTED';
    default:
      break;
  }

  const upperName = (stage.name || '').toUpperCase().trim();
  if (upperName.includes('HIRED') || upperName.includes('HIRE')) return 'HIRED';
  if (upperName.includes('REJECT')) return 'REJECTED';
  if (upperName.includes('OFFER')) return 'OFFER';
  if (upperName.includes('INTERVIEW')) return 'INTERVIEW';
  if (upperName.includes('SHORTLIST') || upperName.includes('EVALUAT')) return 'SHORTLISTED';
  if (upperName.includes('SCREEN') || upperName.includes('REVIEW')) return 'IN_REVIEW';
  if (upperName.includes('SOURC') || upperName.includes('APPLI') || upperName.includes('SUBMIT')) return 'SUBMITTED';

  return 'IN_REVIEW';
}

export class JobService {
  /**
   * List jobs for Admin Directory across all companies.
   * Supports filtering by search, status, hiringScope, employmentType, workArrangement, workArrangements, companyId.
   */
  static async listAdminJobs({
    page = 1,
    limit = 10,
    search,
    status,
    hiringScope,
    employmentType,
    workArrangement,
    workArrangements,
    companyId,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    trashed = false,
  }) {
    const skip = (page - 1) * limit;
    const isTrashed = trashed === true || trashed === 'true';

    const arrangementFilter = workArrangements || workArrangement;
    const arrangementList = Array.isArray(arrangementFilter)
      ? arrangementFilter
      : (arrangementFilter ? [arrangementFilter] : []);

    const andConditions = [
      { deletedAt: isTrashed ? { not: null } : null },
    ];

    if (status) {
      andConditions.push({ status });
    }

    if (hiringScope) {
      andConditions.push({
        OR: [{ hiringScope }, { hiringScopes: { has: hiringScope } }],
      });
    }

    if (employmentType) {
      andConditions.push({ employmentType });
    }

    if (arrangementList.length > 0) {
      andConditions.push({
        OR: [
          { workArrangement: { in: arrangementList } },
          { workArrangements: { hasSome: arrangementList } },
        ],
      });
    }

    if (companyId) {
      andConditions.push({ companyId });
    }

    if (search) {
      andConditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { jobCode: { contains: search, mode: 'insensitive' } },
          { department: { contains: search, mode: 'insensitive' } },
          { city: { contains: search, mode: 'insensitive' } },
          { company: { name: { contains: search, mode: 'insensitive' } } },
          { company: { companyCode: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }

    const where = { AND: andConditions };

    const orderBy = {};
    if (sortBy === 'title') {
      orderBy.title = sortOrder;
    } else if (sortBy === 'publishedAt') {
      orderBy.publishedAt = sortOrder;
    } else if (sortBy === 'status') {
      orderBy.status = sortOrder;
    } else if (sortBy === 'openings') {
      orderBy.openings = sortOrder;
    } else if (sortBy === 'deletedAt' || (isTrashed && sortBy === 'createdAt')) {
      orderBy.deletedAt = sortOrder;
    } else {
      orderBy.createdAt = sortOrder;
    }

    const [total, items, statusCounts, trashedCount] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          company: {
            select: {
              id: true,
              name: true,
              companyCode: true,
              status: true,
              country: true,
              city: true,
              hiringDomestic: true,
              hiringEu: true,
              hiringInternational: true,
            },
          },
          industry: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          _count: {
            select: { applications: true },
          },
        },
      }),
      prisma.job.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      prisma.job.count({
        where: { deletedAt: { not: null } },
      }),
    ]);

    const counts = {
      ALL: 0,
      DRAFT: 0,
      PENDING_APPROVAL: 0,
      PUBLISHED: 0,
      CLOSED: 0,
      ARCHIVED: 0,
      TRASH: trashedCount,
    };
    for (const group of statusCounts) {
      if (counts[group.status] !== undefined) {
        counts[group.status] = group._count._all;
      }
      counts.ALL += group._count._all;
    }

    return {
      items,
      counts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Create a new job posting for a company.
   * Gated by company active state, company hiring preference capability,
   * subscription quotas, and platform auto-approval policy.
   */
  static async createJob(jobData, actorContext = {}) {
    const { companyId, status = 'DRAFT' } = jobData;

    // 1. Validate company exists, is not in trash, and is eligible
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        status: true,
        deletedAt: true,
        hiringDomestic: true,
        hiringEu: true,
        hiringInternational: true,
      },
    });

    if (!company) {
      throw createHttpError('Target company does not exist.', 404);
    }

    if (company.deletedAt !== null) {
      throw createHttpError('Cannot post jobs for a company currently in trash.', 400);
    }

    // 2. Resolve and Validate Job Hiring Scope(s) against Company hiring capabilities
    let rawScopes = jobData.hiringScopes !== undefined ? jobData.hiringScopes : jobData.hiringScope;
    let scopes = [];
    if (Array.isArray(rawScopes)) {
      scopes = [...new Set(rawScopes.filter(Boolean))];
    } else if (rawScopes) {
      scopes = [rawScopes];
    } else {
      scopes = ['DOMESTIC'];
    }

    if (scopes.length === 0) {
      throw createHttpError('At least one valid hiring scope must be selected.', 400);
    }

    // Check if company has no scopes permitted at all
    if (!company.hiringDomestic && !company.hiringEu && !company.hiringInternational) {
      throw createHttpError(
        'Selected company has no active hiring scopes permitted. Update company configuration before posting jobs.',
        400
      );
    }

    if (scopes.includes('DOMESTIC') && !company.hiringDomestic) {
      throw createHttpError(
        'Company is not configured for domestic hiring. Update company preferences before posting domestic roles.',
        400
      );
    }
    if (scopes.includes('EU') && !company.hiringEu) {
      throw createHttpError(
        'Company is not configured for EU hiring. Update company preferences before posting EU roles.',
        400
      );
    }
    if (scopes.includes('INTERNATIONAL') && !company.hiringInternational) {
      throw createHttpError(
        'Company is not configured for international hiring. Update company preferences before posting international roles.',
        400
      );
    }

    // 2b. Resolve and Validate Job Workplace Arrangement(s)
    let rawArrangements = jobData.workArrangements !== undefined ? jobData.workArrangements : jobData.workArrangement;
    let arrangements = [];
    if (Array.isArray(rawArrangements)) {
      arrangements = [...new Set(rawArrangements.filter(Boolean))];
    } else if (rawArrangements) {
      arrangements = [rawArrangements];
    } else {
      arrangements = ['ON_SITE'];
    }

    const validArrangements = ['ON_SITE', 'HYBRID', 'REMOTE'];
    const invalidArrangements = arrangements.filter((a) => !validArrangements.includes(a));
    if (invalidArrangements.length > 0 || arrangements.length === 0) {
      throw createHttpError(
        'At least one valid workplace arrangement (ON_SITE, HYBRID, REMOTE) must be selected.',
        400
      );
    }

    // 3. For published or pending approval jobs, enforce active company status and required publication fields
    if (['PUBLISHED', 'PENDING_APPROVAL'].includes(status)) {
      if (company.status !== 'ACTIVE') {
        throw createHttpError(
          `Company status is "${company.status}". Companies must be ACTIVE to publish or submit jobs for approval.`,
          400
        );
      }
    }

    const createdJob = await prisma.$transaction(async (tx) => {
      // 4. Enforce subscription quota when creating directly in active publishing status
      if (['PUBLISHED', 'PENDING_APPROVAL'].includes(status)) {
        await tx.$executeRaw`SELECT 1 FROM companies WHERE id = ${companyId} FOR UPDATE`;

        await EntitlementService.checkEntitlement({
          companyId,
          resourceType: 'jobPosting',
          requestedCount: 1,
          tx,
        });
      }

      // 5. Evaluate platform job approval policy
      let effectiveStatus = status;
      let approvedAt = null;
      let approvedBy = null;

      if (status === 'PUBLISHED') {
        const platformSettings = await tx.platformSetting.findUnique({
          where: { id: 'global' },
        });
        const policyDecision = evaluateJobApprovalStatus({
          jobData,
          settings: platformSettings,
          creatorContext: actorContext,
        });

        if (policyDecision.status === 'APPROVED') {
          effectiveStatus = 'PUBLISHED';
          approvedAt = new Date();
          approvedBy = actorContext.adminId || actorContext.id || 'PLATFORM_POLICY';
        } else {
          effectiveStatus = 'PENDING_APPROVAL';
        }
      }

      const job = await tx.job.create({
        data: {
          ...jobData,
          workArrangement: arrangements[0] || 'ON_SITE',
          workArrangements: arrangements,
          hiringScope: scopes[0] || 'DOMESTIC',
          hiringScopes: scopes,
          germanLevel: jobData.germanLevel || null,
          englishLevel: jobData.englishLevel || null,
          status: effectiveStatus,
          publishedAt: effectiveStatus === 'PUBLISHED' ? new Date() : null,
          approvedAt,
          approvedBy,
          createdById: actorContext.adminId || actorContext.id || null,
        },
        include: {
          company: {
            select: {
              id: true,
              name: true,
              companyCode: true,
              status: true,
              hiringDomestic: true,
              hiringEu: true,
              hiringInternational: true,
            },
          },
          industry: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
        },
      });

      return job;
    });

    // Emit centralized business event notification
    if (createdJob.status === 'PUBLISHED') {
      BusinessEventNotificationService.notifyJobPublished({
        job: createdJob,
        company: createdJob.company,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: createdJob.id }, 'Failed to emit job published notification');
      });
    } else if (createdJob.status === 'PENDING_APPROVAL') {
      BusinessEventNotificationService.notifyJobPendingApproval({
        job: createdJob,
        company: createdJob.company,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: createdJob.id }, 'Failed to emit job pending approval notification');
      });
    } else if (createdJob.status === 'DRAFT') {
      BusinessEventNotificationService.notifyJobCreated({
        job: createdJob,
        company: createdJob.company,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: createdJob.id }, 'Failed to emit job draft notification');
      });
    }

    return createdJob;
  }

  /**
   * Get single job by ID (Admin or internal viewer)
   */
  static async getJobById(id) {
    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            legalName: true,
            companyCode: true,
            status: true,
            country: true,
            city: true,
            hiringDomestic: true,
            hiringEu: true,
            hiringInternational: true,
            users: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                role: true,
              },
            },
          },
        },
        industry: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        _count: {
          select: {
            applications: true,
          },
        },
      },
    });

    if (!job) {
      throw createHttpError('Job posting not found.', 404);
    }

    return job;
  }

  /**
   * List applicants for a specific job posting
   */
  static async getJobApplicants(jobId, { page = 1, limit = 10, search, status, stageId }) {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, title: true, companyId: true, status: true },
    });
    if (!job) {
      throw createHttpError('Job posting not found.', 404);
    }

    const skip = (page - 1) * limit;
    const where = {
      jobId,
      ...(status ? { status } : {}),
      ...(stageId ? { currentStageId: stageId } : {}),
      ...(search
        ? {
            OR: [
              { candidate: { firstName: { contains: search, mode: 'insensitive' } } },
              { candidate: { lastName: { contains: search, mode: 'insensitive' } } },
              { candidate: { email: { contains: search, mode: 'insensitive' } } },
              { candidate: { currentLocation: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      prisma.jobApplication.count({ where }),
      prisma.jobApplication.findMany({
        where,
        skip,
        take: limit,
        orderBy: { appliedAt: 'desc' },
        include: {
          candidate: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              headline: true,
              summary: true,
              country: true,
              city: true,
              currentLocation: true,
              willingToRelocate: true,
              resumeUrl: true,
              resumeFileName: true,
              createdAt: true,
            },
          },
          currentStage: {
            select: {
              id: true,
              name: true,
              category: true,
              order: true,
            },
          },
        },
      }),
    ]);

    return {
      job,
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Update an existing job posting
   */
  static async updateJob(id, updateData, actorContext = {}) {
    const existingJob = await prisma.job.findUnique({
      where: { id },
      include: { company: true },
    });

    if (!existingJob || existingJob.deletedAt !== null) {
      throw createHttpError('Job posting not found.', 404);
    }

    const company = existingJob.company;
    if (company.deletedAt !== null) {
      throw createHttpError('Target company is currently in trash.', 400);
    }

    // Verify hiring scope updates against company capabilities
    let updatedScopes = existingJob.hiringScopes && existingJob.hiringScopes.length > 0
      ? existingJob.hiringScopes
      : (existingJob.hiringScope ? [existingJob.hiringScope] : ['DOMESTIC']);

    if (updateData.hiringScopes !== undefined || updateData.hiringScope !== undefined) {
      const rawScopes = updateData.hiringScopes !== undefined ? updateData.hiringScopes : updateData.hiringScope;
      if (Array.isArray(rawScopes)) {
        updatedScopes = [...new Set(rawScopes.filter(Boolean))];
      } else if (rawScopes) {
        updatedScopes = [rawScopes];
      }
    }

    if (updatedScopes.length === 0) {
      throw createHttpError('At least one valid hiring scope must be selected.', 400);
    }

    if (updatedScopes.includes('DOMESTIC') && !company.hiringDomestic) {
      throw createHttpError('Company is not configured for domestic hiring.', 400);
    }
    if (updatedScopes.includes('EU') && !company.hiringEu) {
      throw createHttpError('Company is not configured for EU hiring.', 400);
    }
    if (updatedScopes.includes('INTERNATIONAL') && !company.hiringInternational) {
      throw createHttpError('Company is not configured for international hiring.', 400);
    }

    // Verify workplace arrangements
    let updatedArrangements = existingJob.workArrangements && existingJob.workArrangements.length > 0
      ? existingJob.workArrangements
      : (existingJob.workArrangement ? [existingJob.workArrangement] : ['ON_SITE']);

    if (updateData.workArrangements !== undefined || updateData.workArrangement !== undefined) {
      const rawArrangements = updateData.workArrangements !== undefined ? updateData.workArrangements : updateData.workArrangement;
      if (Array.isArray(rawArrangements)) {
        updatedArrangements = [...new Set(rawArrangements.filter(Boolean))];
      } else if (rawArrangements) {
        updatedArrangements = [rawArrangements];
      }
      const validArrangements = ['ON_SITE', 'HYBRID', 'REMOTE'];
      const invalidArrangements = updatedArrangements.filter((a) => !validArrangements.includes(a));
      if (invalidArrangements.length > 0 || updatedArrangements.length === 0) {
        throw createHttpError('At least one valid workplace arrangement (ON_SITE, HYBRID, REMOTE) must be selected.', 400);
      }
    }

    // Verify quota if transitioning to PUBLISHED or PENDING_APPROVAL from DRAFT/CLOSED/ARCHIVED
    const isActivating =
      ['PUBLISHED', 'PENDING_APPROVAL'].includes(updateData.status) &&
      !['PUBLISHED', 'PENDING_APPROVAL'].includes(existingJob.status);

    if (isActivating && company.status !== 'ACTIVE') {
      throw createHttpError('Cannot publish jobs while company is not in ACTIVE status.', 400);
    }

    let statusToSet = updateData.status;
    let approvedAt = existingJob.approvedAt;
    let approvedBy = existingJob.approvedBy;

    if (updateData.status === 'PUBLISHED' && existingJob.status !== 'PUBLISHED') {
      const platformSettings = await prisma.platformSetting.findUnique({
        where: { id: 'global' },
      });
      const policyDecision = evaluateJobApprovalStatus({
        jobData: { ...existingJob, ...updateData },
        settings: platformSettings,
        creatorContext: actorContext,
      });

      if (policyDecision.status === 'APPROVED') {
        statusToSet = 'PUBLISHED';
        approvedAt = new Date();
        approvedBy = actorContext.adminId || actorContext.id || 'PLATFORM_POLICY';
      } else {
        statusToSet = 'PENDING_APPROVAL';
      }
    }

    const updatedJob = await prisma.$transaction(async (tx) => {
      if (isActivating) {
        await tx.$executeRaw`SELECT 1 FROM companies WHERE id = ${company.id} FOR UPDATE`;
        await EntitlementService.checkEntitlement({
          companyId: company.id,
          resourceType: 'jobPosting',
          requestedCount: 1,
          tx,
        });
      }

      const updated = await tx.job.update({
        where: { id },
        data: {
          ...updateData,
          workArrangement: updatedArrangements[0] || 'ON_SITE',
          workArrangements: updatedArrangements,
          hiringScope: updatedScopes[0] || 'DOMESTIC',
          hiringScopes: updatedScopes,
          ...(updateData.germanLevel !== undefined ? { germanLevel: updateData.germanLevel || null } : {}),
          ...(updateData.englishLevel !== undefined ? { englishLevel: updateData.englishLevel || null } : {}),
          ...(statusToSet ? { status: statusToSet } : {}),
          ...(statusToSet === 'PUBLISHED' && !existingJob.publishedAt ? { publishedAt: new Date() } : {}),
          approvedAt,
          approvedBy,
        },
        include: {
          company: {
            select: { id: true, name: true, companyCode: true, status: true },
          },
          industry: {
            select: { id: true, name: true, code: true },
          },
        },
      });

      return updated;
    });

    // Emit centralized business event notification for job update/publish
    if (updatedJob.status === 'PUBLISHED' && existingJob.status !== 'PUBLISHED') {
      BusinessEventNotificationService.notifyJobPublished({
        job: updatedJob,
        company: updatedJob.company,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: updatedJob.id }, 'Failed to emit job published notification');
      });
    } else if (updatedJob.status === 'PENDING_APPROVAL' && existingJob.status !== 'PENDING_APPROVAL') {
      BusinessEventNotificationService.notifyJobPendingApproval({
        job: updatedJob,
        company: updatedJob.company,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: updatedJob.id }, 'Failed to emit job pending approval notification');
      });
    } else if (updatedJob.status !== existingJob.status) {
      BusinessEventNotificationService.notifyJobStatusChanged({
        job: updatedJob,
        status: updatedJob.status,
        previousStatus: existingJob.status,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: updatedJob.id }, 'Failed to emit job status changed notification');
      });
    }

    return updatedJob;
  }

  /**
   * Update Job Status (Suspend, Inactive/Close, Reactivate)
   */
  static async updateJobStatus(id, { status, reason }, actorContext = {}) {
    const existingJob = await prisma.job.findUnique({
      where: { id },
      include: { company: true },
    });

    if (!existingJob || existingJob.deletedAt !== null) {
      throw createHttpError('Job posting not found.', 404);
    }

    const company = existingJob.company;
    if (company.deletedAt !== null) {
      throw createHttpError('Target company is currently in trash.', 400);
    }

    const isActivating =
      ['PUBLISHED', 'PENDING_APPROVAL'].includes(status) &&
      !['PUBLISHED', 'PENDING_APPROVAL'].includes(existingJob.status);

    if (['PUBLISHED', 'PENDING_APPROVAL'].includes(status)) {
      if (company.status !== 'ACTIVE') {
        throw createHttpError(
          `Company status is "${company.status}". Companies must be ACTIVE to publish jobs.`,
          400
        );
      }

      if (existingJob.hiringScope === 'DOMESTIC' && !company.hiringDomestic) {
        throw createHttpError('Company is not configured for domestic hiring.', 400);
      }
      if (existingJob.hiringScope === 'EU' && !company.hiringEu) {
        throw createHttpError('Company is not configured for EU hiring.', 400);
      }
      if (existingJob.hiringScope === 'INTERNATIONAL' && !company.hiringInternational) {
        throw createHttpError('Company is not configured for international hiring.', 400);
      }
    }

    const updatedJob = await prisma.$transaction(async (tx) => {
      if (isActivating) {
        await tx.$executeRaw`SELECT 1 FROM companies WHERE id = ${company.id} FOR UPDATE`;
        await EntitlementService.checkEntitlement({
          companyId: company.id,
          resourceType: 'jobPosting',
          requestedCount: 1,
          tx,
        });
      }

      const updated = await tx.job.update({
        where: { id },
        data: {
          status,
          ...(status === 'PUBLISHED' && !existingJob.publishedAt ? { publishedAt: new Date() } : {}),
          rejectionReason: reason || existingJob.rejectionReason,
        },
        include: {
          company: {
            select: { id: true, name: true, companyCode: true, status: true },
          },
        },
      });

      return updated;
    });

    // Emit centralized business event notification
    if (status === 'PUBLISHED') {
      BusinessEventNotificationService.notifyJobPublished({
        job: updatedJob,
        company: updatedJob.company,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: id }, 'Failed to emit job published notification');
      });
    } else if (status === 'PENDING_APPROVAL') {
      BusinessEventNotificationService.notifyJobPendingApproval({
        job: updatedJob,
        company: updatedJob.company,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: id }, 'Failed to emit job pending approval notification');
      });
    } else if (['CLOSED', 'SUSPENDED', 'ARCHIVED'].includes(status) || status !== existingJob.status) {
      BusinessEventNotificationService.notifyJobStatusChanged({
        job: updatedJob,
        status,
        previousStatus: existingJob.status,
        reason,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => {
        logger.warn({ error: err.message, jobId: id }, 'Failed to emit job status notification');
      });
    }

    return updatedJob;
  }

  /**
   * Parse plain-text (.txt) file for job description upload.
   * Strictly enforces .txt extension, validates encoding and size, rejects binary and HTML.
   */
  static parseDescriptionFile(file) {
    if (!file) {
      throw createHttpError('No file uploaded.', 400);
    }

    const originalName = file.originalname || '';
    if (!originalName.toLowerCase().endsWith('.txt')) {
      throw createHttpError('Invalid file type. Only plain-text (.txt) files are accepted.', 400);
    }

    // Size limit: 500 KB max
    if (file.size > 500 * 1024) {
      throw createHttpError('File size exceeds 500 KB limit for plain-text descriptions.', 400);
    }

    const buffer = file.buffer;
    const sig = inspectFileSignature(buffer);
    if (sig.isExecutable || sig.detectedType === 'application/pdf') {
      throw createHttpError('Invalid file format. Uploaded file is not valid plain text.', 400);
    }

    // Reject null bytes to guard against binary executables masquerading as text
    for (let i = 0; i < Math.min(buffer.length, 1024); i++) {
      if (buffer[i] === 0) {
        throw createHttpError('Binary content detected. Only plain-text (.txt) files are accepted.', 400);
      }
    }

    let text;
    try {
      text = buffer.toString('utf-8');
    } catch {
      throw createHttpError('Unable to decode file as UTF-8 plain text.', 400);
    }

    // Strip HTML markup so content cannot be executed or rendered as markup
    const sanitized = text
      .replace(/<[^>]*>?/gm, '')
      .replace(/\r\n/g, '\n')
      .trim();

    if (!sanitized) {
      throw createHttpError('Uploaded text file is empty.', 400);
    }

    return {
      success: true,
      text: sanitized,
      fileName: originalName,
      fileSize: file.size,
    };
  }

  /**
   * Delete job posting (MOVE_TO_TRASH or DELETE_PERMANENTLY)
   */
  static async deleteJob(id, mode = 'MOVE_TO_TRASH', actorContext = {}) {
    const existingJob = await prisma.job.findUnique({
      where: { id },
      include: {
        _count: {
          select: { applications: true },
        },
      },
    });

    if (!existingJob) {
      throw createHttpError('Job posting not found.', 404);
    }

    if (mode === 'DELETE_PERMANENTLY') {
      if (actorContext?.role !== 'SUPER_ADMIN') {
        throw createHttpError('Only Super Administrators are authorized to permanently delete job postings.', 403);
      }

      if (existingJob._count.applications > 0) {
        throw createHttpError(
          `Cannot permanently delete job "${existingJob.title}" because it contains ${existingJob._count.applications} active candidate application(s). Soft delete (Move to Trash) to preserve candidate submission history.`,
          400
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM jobs WHERE id = ${id} FOR UPDATE`;
        await tx.job.delete({ where: { id } });
      });

      return {
        success: true,
        message: `Job posting "${existingJob.title}" was permanently deleted.`,
        data: { id, mode: 'DELETE_PERMANENTLY' },
      };
    }

    // Default: Soft delete (MOVE_TO_TRASH)
    if (existingJob.deletedAt !== null) {
      throw createHttpError(`Job posting "${existingJob.title}" is already in trash.`, 400);
    }

    const updated = await prisma.job.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'ARCHIVED',
      },
    });

    return {
      success: true,
      message: `Job posting "${existingJob.title}" moved to Trash.`,
      data: { ...updated, mode: 'MOVE_TO_TRASH' },
    };
  }

  /**
   * Restore a job posting from Trash
   */
  static async restoreJob(id, actorContext = {}) {
    const restoredResult = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM jobs WHERE id = ${id} FOR UPDATE`;
      const existingJob = await tx.job.findUnique({
        where: { id },
        include: {
          company: {
            select: {
              id: true,
              name: true,
              status: true,
              deletedAt: true,
            },
          },
        },
      });

      if (!existingJob) {
        throw createHttpError('Job posting not found.', 404);
      }

      if (existingJob.deletedAt === null) {
        throw createHttpError(`Job posting "${existingJob.title}" is not in trash.`, 400);
      }

      const deletedTime = new Date(existingJob.deletedAt).getTime();
      const daysSinceDeleted = (Date.now() - deletedTime) / (1000 * 3600 * 24);
      if (daysSinceDeleted > 30 && actorContext?.role !== 'SUPER_ADMIN') {
        throw createHttpError(
          `Cannot restore job "${existingJob.title}" because the 30-day retention period has expired. Only Super Administrators can override.`,
          403
        );
      }

      if (!existingJob.company) {
        throw createHttpError('Cannot restore job because its parent company no longer exists.', 400);
      }
      if (existingJob.company.deletedAt !== null) {
        throw createHttpError(
          `Cannot restore job "${existingJob.title}" because parent company "${existingJob.company.name}" is currently in trash. Restore the company first.`,
          400
        );
      }

      const targetStatus = actorContext?.status || 'DRAFT';
      if (['PUBLISHED', 'PENDING_APPROVAL'].includes(targetStatus)) {
        if (existingJob.company.status !== 'ACTIVE') {
          throw createHttpError(
            `Company status is "${existingJob.company.status}". Companies must be ACTIVE to publish jobs.`,
            400
          );
        }
        await tx.$executeRaw`SELECT 1 FROM companies WHERE id = ${existingJob.company.id} FOR UPDATE`;
        await EntitlementService.checkEntitlement({
          companyId: existingJob.company.id,
          resourceType: 'jobPosting',
          requestedCount: 1,
          tx,
        });
      }

      const updated = await tx.job.update({
        where: { id },
        data: {
          deletedAt: null,
          status: targetStatus,
        },
        include: {
          company: {
            select: { id: true, name: true, companyCode: true, status: true },
          },
          industry: {
            select: { id: true, name: true, code: true },
          },
        },
      });

      return {
        success: true,
        message: `Job posting "${existingJob.title}" was successfully restored from Trash.`,
        data: updated,
      };
    });

    // Emit centralized business event notification
    BusinessEventNotificationService.notifyJobRestored({
      job: restoredResult.data,
      actorAdminId: actorContext?.adminId || actorContext?.id,
    }).catch((err) => {
      logger.warn({ error: err.message, jobId: id }, 'Failed to emit job restored notification');
    });

    return restoredResult;
  }

  /**
   * List jobs for a specific company (employer/admin view)
   */
  static async listCompanyJobs(companyId, { page = 1, limit = 10, status, search, hiringScope, workArrangement, workArrangements }) {
    const skip = (page - 1) * limit;
    const arrangementFilter = workArrangements || workArrangement;
    const arrangementList = Array.isArray(arrangementFilter)
      ? arrangementFilter
      : (arrangementFilter ? [arrangementFilter] : []);

    const andConditions = [
      { companyId },
      { deletedAt: null },
    ];
    if (status) andConditions.push({ status });
    if (hiringScope) {
      andConditions.push({
        OR: [{ hiringScope }, { hiringScopes: { has: hiringScope } }],
      });
    }
    if (arrangementList.length > 0) {
      andConditions.push({
        OR: [
          { workArrangement: { in: arrangementList } },
          { workArrangements: { hasSome: arrangementList } },
        ],
      });
    }
    if (search) {
      andConditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { department: { contains: search, mode: 'insensitive' } },
          { city: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    const where = { AND: andConditions };

    const [total, items] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { applications: true },
          },
        },
      }),
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Public Candidate Discovery API
   * Strictly filters out unpublished jobs, expired jobs, and jobs from deleted/inactive companies.
   * Sanitizes employer contact details according to platform privacy policy.
   */
  static async listPublicJobs({
    page = 1,
    limit = 10,
    country,
    city,
    workArrangement,
    workArrangements,
    employmentType,
    hiringScope,
    search,
  }) {
    const skip = (page - 1) * limit;
    const now = new Date();

    const platformSettings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    const arrangementFilter = workArrangements || workArrangement;
    const arrangementList = Array.isArray(arrangementFilter)
      ? arrangementFilter
      : (arrangementFilter ? [arrangementFilter] : []);

    const andConditions = [
      { status: 'PUBLISHED' },
      { deletedAt: null },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      {
        company: {
          deletedAt: null,
          status: 'ACTIVE',
        },
      },
    ];

    if (country) {
      andConditions.push({ country: country.toUpperCase() });
    }
    if (city) {
      andConditions.push({ city: { contains: city, mode: 'insensitive' } });
    }
    if (arrangementList.length > 0) {
      andConditions.push({
        OR: [
          { workArrangement: { in: arrangementList } },
          { workArrangements: { hasSome: arrangementList } },
        ],
      });
    }
    if (employmentType) {
      andConditions.push({ employmentType });
    }
    if (hiringScope) {
      const scopeCond = {
        OR: [{ hiringScope }, { hiringScopes: { has: hiringScope } }],
      };
      if (hiringScope === 'DOMESTIC') scopeCond.company = { hiringDomestic: true };
      if (hiringScope === 'EU') scopeCond.company = { hiringEu: true };
      if (hiringScope === 'INTERNATIONAL') scopeCond.company = { hiringInternational: true };
      andConditions.push(scopeCond);
    }
    if (search) {
      andConditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { department: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const where = { AND: andConditions };

    const [total, rawJobs] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where,
        skip,
        take: limit,
        orderBy: { publishedAt: 'desc' },
        select: {
          id: true,
          title: true,
          slug: true,
          description: true,
          requirements: true,
          benefits: true,
          department: true,
          location: true,
          country: true,
          city: true,
          workArrangement: true,
          workArrangements: true,
          employmentType: true,
          hiringScope: true,
          hiringScopes: true,
          germanLevel: true,
          englishLevel: true,
          currency: true,
          minSalary: true,
          maxSalary: true,
          publishedAt: true,
          expiresAt: true,
          company: {
            select: {
              id: true,
              name: true,
              companySize: true,
              website: true,
              logoUrl: true,
              bannerUrl: true,
              country: true,
              city: true,
              email: true,
              phone: true,
              billingEmail: true,
              billingAddress: true,
              hiringDomestic: true,
              hiringEu: true,
              hiringInternational: true,
            },
          },
        },
      }),
    ]);

    // Sanitize employer contact information per platform visibility policy
    // and ensure visible job scopes respect current company permissions
    const items = rawJobs.map((job) => {
      const allowedScopes = (job.hiringScopes && job.hiringScopes.length > 0 ? job.hiringScopes : [job.hiringScope]).filter((scope) => {
        if (scope === 'DOMESTIC') return job.company.hiringDomestic;
        if (scope === 'EU') return job.company.hiringEu;
        if (scope === 'INTERNATIONAL') return job.company.hiringInternational;
        return true;
      });
      const resolvedArrangements = job.workArrangements && job.workArrangements.length > 0
        ? job.workArrangements
        : (job.workArrangement ? [job.workArrangement] : ['ON_SITE']);

      return {
        ...job,
        workArrangements: resolvedArrangements,
        workArrangement: resolvedArrangements[0] || job.workArrangement,
        hiringScopes: allowedScopes,
        hiringScope: allowedScopes[0] || job.hiringScope,
        company: enforceEmployerContactVisibility(job.company, platformSettings),
      };
    });

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Public Candidate Job Detail API
   */
  static async getPublicJobById(id) {
    const now = new Date();
    const platformSettings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    const job = await prisma.job.findFirst({
      where: {
        id,
        status: 'PUBLISHED',
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        company: {
          deletedAt: null,
          status: 'ACTIVE',
        },
      },
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        requirements: true,
        benefits: true,
        department: true,
        location: true,
        country: true,
        city: true,
        workArrangement: true,
        workArrangements: true,
        employmentType: true,
        hiringScope: true,
        hiringScopes: true,
        germanLevel: true,
        englishLevel: true,
        currency: true,
        minSalary: true,
        maxSalary: true,
        publishedAt: true,
        expiresAt: true,
        company: {
          select: {
            id: true,
            name: true,
            description: true,
            companySize: true,
            website: true,
            logoUrl: true,
            bannerUrl: true,
            country: true,
            city: true,
            email: true,
            phone: true,
            billingEmail: true,
            billingAddress: true,
            hiringDomestic: true,
            hiringEu: true,
            hiringInternational: true,
          },
        },
      },
    });

    if (!job) {
      throw createHttpError('Job posting not found, expired, or unavailable.', 404);
    }

    const allowedScopes = (job.hiringScopes && job.hiringScopes.length > 0 ? job.hiringScopes : [job.hiringScope]).filter((scope) => {
      if (scope === 'DOMESTIC') return job.company.hiringDomestic;
      if (scope === 'EU') return job.company.hiringEu;
      if (scope === 'INTERNATIONAL') return job.company.hiringInternational;
      return true;
    });

    const resolvedArrangements = job.workArrangements && job.workArrangements.length > 0
      ? job.workArrangements
      : (job.workArrangement ? [job.workArrangement] : ['ON_SITE']);

    return {
      ...job,
      workArrangements: resolvedArrangements,
      workArrangement: resolvedArrangements[0] || job.workArrangement,
      hiringScopes: allowedScopes,
      hiringScope: allowedScopes[0] || job.hiringScope,
      company: enforceEmployerContactVisibility(job.company, platformSettings),
    };
  }

  /**
   * Apply for a Job posting
   * Enforces:
   * - Job is active, published, and not expired
   * - Applicant limit enforcement with race condition handling
   * - Duplicate application check (409 Conflict)
   * - Resume format and MIME verification against platform settings
   * - Automatic initial recruitment stage assignment
   */
  static async applyForJob(jobId, applicationData) {
    const now = new Date();
    const platformSettings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        status: true,
        deletedAt: true,
        expiresAt: true,
        companyId: true,
        maxApplicantsLimit: true,
        autoCloseOnLimit: true,
        company: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!job || job.deletedAt !== null || job.company?.deletedAt !== null) {
      throw createHttpError('Job posting not found.', 404);
    }

    if (
      job.status === 'CLOSED' &&
      job.maxApplicantsLimit &&
      job.autoCloseOnLimit
    ) {
      throw createHttpError(
        'This job posting has reached its maximum application limit and is no longer accepting submissions.',
        400
      );
    }

    if (job.status !== 'PUBLISHED' || job.company?.status !== 'ACTIVE' || (job.expiresAt && job.expiresAt <= now)) {
      throw createHttpError('Job posting is not open for applications.', 400);
    }

    const email = applicationData.email.toLowerCase().trim();

    // 1. Resume validation against binary content, size, and platform policies
    if (applicationData.resumeBuffer) {
      if (applicationData.resumeSize && applicationData.resumeSize > 10 * 1024 * 1024) {
        throw createHttpError('Resume file size exceeds maximum limit of 10 MB.', 400);
      }
      const sig = inspectFileSignature(applicationData.resumeBuffer);
      if (sig.isExecutable) {
        throw createHttpError('Binary content inspection detected an executable payload. Upload rejected.', 400);
      }
      if (
        applicationData.resumeFileName?.toLowerCase().endsWith('.pdf') &&
        sig.detectedType !== 'application/pdf' &&
        sig.detectedType !== 'unknown'
      ) {
        throw createHttpError('File extension is .pdf but binary content signature is not a valid PDF document.', 400);
      }
    }

    if (applicationData.resumeFileName) {
      const resumeValidation = validateResumeFile(
        applicationData.resumeFileName,
        applicationData.resumeMimeType,
        platformSettings?.acceptedResumeFileTypes
      );

      if (!resumeValidation.valid) {
        throw createHttpError(resumeValidation.error, 400);
      }
    }

    // 2. Duplicate Application Check
    const existingApplication = await prisma.jobApplication.findFirst({
      where: {
        jobId,
        candidate: {
          email,
        },
      },
    });

    if (existingApplication) {
      throw createHttpError('Candidate has already submitted an application for this job posting.', 409);
    }

    // 3. Resolve initial active recruitment stage
    const initialStage = await prisma.recruitmentStage.findFirst({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
      },
      orderBy: { order: 'asc' },
    });

    // 4. Atomic applicant limit check, candidate upsert & application creation
    const result = await prisma.$transaction(async (tx) => {
      // Row lock job to serialize applications and prevent concurrent applicant-limit bypasses
      await tx.$executeRaw`SELECT 1 FROM jobs WHERE id = ${jobId} FOR UPDATE`;

      if (job.maxApplicantsLimit && job.maxApplicantsLimit > 0) {
        const currentCount = await tx.jobApplication.count({
          where: { jobId },
        });

        if (currentCount >= job.maxApplicantsLimit) {
          if (job.autoCloseOnLimit) {
            await tx.job.update({
              where: { id: jobId },
              data: { status: 'CLOSED' },
            });
          }
          throw createHttpError(
            'This job posting has reached its maximum application limit and is no longer accepting submissions.',
            400
          );
        }
      }

      const candidate = await tx.candidate.upsert({
        where: { email },
        update: {
          firstName: applicationData.firstName,
          lastName: applicationData.lastName,
          ...(applicationData.phone ? { phone: applicationData.phone } : {}),
          ...(applicationData.headline ? { headline: applicationData.headline } : {}),
          ...(applicationData.summary ? { summary: applicationData.summary } : {}),
          ...(applicationData.currentLocation ? { currentLocation: applicationData.currentLocation } : {}),
          ...(applicationData.country ? { country: applicationData.country } : {}),
          ...(applicationData.city ? { city: applicationData.city } : {}),
          willingToRelocate: applicationData.willingToRelocate ?? false,
          ...(applicationData.resumeUrl ? { resumeUrl: applicationData.resumeUrl } : {}),
          ...(applicationData.resumeFileName ? { resumeFileName: applicationData.resumeFileName } : {}),
          ...(applicationData.resumeMimeType ? { resumeMimeType: applicationData.resumeMimeType } : {}),
        },
        create: {
          email,
          firstName: applicationData.firstName,
          lastName: applicationData.lastName,
          phone: applicationData.phone || null,
          headline: applicationData.headline || null,
          summary: applicationData.summary || null,
          currentLocation: applicationData.currentLocation || null,
          country: applicationData.country || 'DE',
          city: applicationData.city || null,
          willingToRelocate: applicationData.willingToRelocate ?? false,
          resumeUrl: applicationData.resumeUrl || null,
          resumeFileName: applicationData.resumeFileName || null,
          resumeMimeType: applicationData.resumeMimeType || null,
          status: 'ACTIVE',
        },
      });

      const app = await tx.jobApplication.create({
        data: {
          jobId,
          candidateId: candidate.id,
          currentStageId: initialStage?.id || null,
          status: 'SUBMITTED',
          coverLetter: applicationData.coverLetter || null,
          resumeUrl: applicationData.resumeUrl || candidate.resumeUrl || null,
        },
        include: {
          job: {
            select: { id: true, title: true, companyId: true },
          },
          candidate: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          currentStage: {
            select: { id: true, name: true, category: true },
          },
        },
      });

      if (initialStage) {
        await tx.applicationStageHistory.create({
          data: {
            applicationId: app.id,
            previousStageId: null,
            destinationStageId: initialStage.id,
            actorId: null,
            notes: 'Initial application submission',
            reviewerNotes: null,
            rejectionReason: null,
          },
        });
      }

      // If auto-close enabled and this application reached the limit, close now
      let autoClosed = false;
      if (job.maxApplicantsLimit && job.autoCloseOnLimit) {
        const newCount = await tx.jobApplication.count({ where: { jobId } });
        if (newCount >= job.maxApplicantsLimit) {
          await tx.job.update({
            where: { id: jobId },
            data: { status: 'CLOSED' },
          });
          autoClosed = true;
        }
      }

      return { app, autoClosed, job };
    });

    const application = result.app;

    // Send notifications outside the transaction boundary
    try {
      const candidateName =
        `${application.candidate?.firstName || ''} ${application.candidate?.lastName || ''}`.trim() ||
        application.candidate?.email ||
        'Candidate';

      BusinessEventNotificationService.notifyApplicationReceived({
        application: {
          id: application.id,
          jobId: application.jobId,
          companyId: result.job?.companyId,
        },
        job: result.job,
        candidateName,
      }).catch((err) => logger.warn(`[Jobs] Failed to send application received notification: ${err.message}`));

      if (result.autoClosed) {
        BusinessEventNotificationService.notifyJobStatusChanged({
          job: result.job,
          previousStatus: 'ACTIVE',
          newStatus: 'CLOSED',
          reason: 'Applicant limit reached',
        }).catch((err) => logger.warn(`[Jobs] Failed to send auto-close notification: ${err.message}`));
      }
    } catch (notifErr) {
      logger.warn(`[Jobs] Error dispatching application notification: ${notifErr.message}`);
    }

    return {
      success: true,
      applicationId: application.id,
      jobId: application.jobId,
      status: application.status,
      currentStage: application.currentStage?.name || 'Screening',
      appliedAt: application.appliedAt,
    };
  }

  /**
   * GET /api/jobs/:jobId/pipeline
   * Active recruitment-stage columns and paginated applicants grouped by their current stage.
   */
  static async getJobPipeline(jobId, query = {}, actorContext = {}) {
    // 1. Verify job exists and not deleted
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        companyId: true,
        status: true,
        deletedAt: true,
        company: {
          select: {
            id: true,
            name: true,
            companyCode: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!job || job.deletedAt !== null) {
      throw createHttpError('Job posting not found.', 404);
    }

    // 2. Tenant isolation check: if actor has companyId, ensure match
    if (actorContext?.companyId && actorContext.companyId !== job.companyId) {
      throw createHttpError('Access denied: You are not authorized to view resources of another company.', 403);
    }

    // 3. Fetch all active recruitment stages ordered by order asc
    const stages = await prisma.recruitmentStage.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
      },
      orderBy: { order: 'asc' },
    });

    // 4. Build application query
    const { page = 1, limit = 50, search } = query;
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const appWhere = {
      jobId,
      ...(search
        ? {
            OR: [
              { candidate: { firstName: { contains: search, mode: 'insensitive' } } },
              { candidate: { lastName: { contains: search, mode: 'insensitive' } } },
              { candidate: { email: { contains: search, mode: 'insensitive' } } },
              { candidate: { headline: { contains: search, mode: 'insensitive' } } },
              { candidate: { currentLocation: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    // Fetch applications for this job
    const applications = await prisma.jobApplication.findMany({
      where: appWhere,
      orderBy: { appliedAt: 'desc' },
      include: {
        candidate: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            fullName: true,
            email: true,
            phone: true,
            headline: true,
            summary: true,
            country: true,
            city: true,
            currentLocation: true,
            willingToRelocate: true,
            resumeUrl: true,
            resumeFileName: true,
            createdAt: true,
          },
        },
        currentStage: {
          select: {
            id: true,
            name: true,
            category: true,
            order: true,
          },
        },
        stageHistories: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            actor: {
              select: { id: true, name: true, email: true },
            },
          },
        },
      },
    });

    // Group applications by stage
    const stageMap = new Map();
    for (const st of stages) {
      stageMap.set(st.id, []);
    }
    const unassigned = [];

    for (const app of applications) {
      const formattedApp = {
        ...app,
        stageHistory: app.stageHistories,
        lastTransition: app.stageHistories?.[0] || null,
      };
      if (app.currentStageId && stageMap.has(app.currentStageId)) {
        stageMap.get(app.currentStageId).push(formattedApp);
      } else {
        unassigned.push(formattedApp);
      }
    }

    // Format stage columns with paginated applicants
    const columns = stages.map((st) => {
      const stageApps = stageMap.get(st.id) || [];
      const totalInStage = stageApps.length;
      const paginatedApps = stageApps.slice(skip, skip + limitNum);
      return {
        id: st.id,
        name: st.name,
        category: st.category,
        order: st.order,
        description: st.description,
        status: st.status,
        totalApplicants: totalInStage,
        applicantCount: totalInStage,
        applications: paginatedApps,
        applicants: paginatedApps,
        pagination: {
          total: totalInStage,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(totalInStage / limitNum) || 1,
        },
      };
    });

    return {
      job: {
        id: job.id,
        title: job.title,
        companyId: job.companyId,
        status: job.status,
        company: job.company,
      },
      stages: columns,
      columns,
      unassigned: {
        totalApplicants: unassigned.length,
        applicantCount: unassigned.length,
        applications: unassigned.slice(skip, skip + limitNum),
        applicants: unassigned.slice(skip, skip + limitNum),
      },
      totalApplications: applications.length,
      totalApplicants: applications.length,
      pagination: {
        total: applications.length,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(applications.length / limitNum) || 1,
      },
    };
  }

  /**
   * PATCH /api/jobs/:jobId/applications/:applicationId/stage
   * Atomically move one application to a new stage with terminal state, conflict, and audit protection.
   */
  static async updateApplicationStage(jobId, applicationId, payload, actorContext = {}) {
    const targetStageId = payload.destinationStageId || payload.stageId;
    const expectedPreviousStageId = payload.expectedPreviousStageId || payload.previousStageId;
    const notes = payload.notes || payload.reviewerNotes || null;
    const reviewerNotes = payload.reviewerNotes || payload.notes || null;
    const rejectionReason = payload.rejectionReason?.trim() || null;

    if (!targetStageId) {
      throw createHttpError('Destination stage ID is required.', 400);
    }

    // 1. Validate destination stage outside tx first
    const destinationStage = await prisma.recruitmentStage.findUnique({
      where: { id: targetStageId },
    });

    if (!destinationStage || destinationStage.deletedAt !== null || destinationStage.status !== 'ACTIVE') {
      throw createHttpError('Destination recruitment stage is invalid, inactive, or archived.', 400);
    }

    const mappedStatus = mapStageToApplicationStatus(destinationStage);

    // 2. Validate rejection reason if moving to REJECTED
    if (mappedStatus === 'REJECTED' || destinationStage.category === 'REJECTED') {
      if (!rejectionReason) {
        throw createHttpError('A rejection reason is required when rejecting an application.', 400);
      }
    }

    // 3. Perform atomic transition with row locking
    const result = await prisma.$transaction(async (tx) => {
      // Check job exists and verify company scope
      const job = await tx.job.findUnique({
        where: { id: jobId },
        select: { id: true, title: true, companyId: true, deletedAt: true },
      });

      if (!job || job.deletedAt !== null) {
        throw createHttpError('Job posting not found.', 404);
      }

      if (actorContext?.companyId && actorContext.companyId !== job.companyId) {
        throw createHttpError('Access denied: You are not authorized to manage resources of another company.', 403);
      }

      // Row lock the application to prevent lost updates and race conditions
      await tx.$executeRaw`SELECT 1 FROM job_applications WHERE id = ${applicationId} FOR UPDATE`;

      const application = await tx.jobApplication.findUnique({
        where: { id: applicationId },
        include: {
          currentStage: true,
        },
      });

      if (!application) {
        throw createHttpError('Job application not found.', 404);
      }

      // Cross-job application ID mismatch check
      if (application.jobId !== jobId) {
        throw createHttpError('Application does not belong to the specified job.', 400);
      }

      // Terminal state protection: HIRED and REJECTED cannot be moved
      if (
        application.status === 'HIRED' ||
        application.status === 'REJECTED' ||
        application.currentStage?.category === 'HIRED' ||
        application.currentStage?.category === 'REJECTED'
      ) {
        throw createHttpError(
          `Cannot transition application from terminal state '${application.status}'. Reopening terminal applications is not supported.`,
          400
        );
      }

      // Concurrency conflict check: expectedPreviousStageId
      if (expectedPreviousStageId && application.currentStageId !== expectedPreviousStageId) {
        throw createHttpError(
          `Stage conflict detected: application is currently in stage '${application.currentStage?.name || application.currentStageId}', not expected stage '${expectedPreviousStageId}'.`,
          409
        );
      }

      // Duplicate stage transition check: already in destination stage
      if (application.currentStageId === targetStageId) {
        throw createHttpError('Application is already in the requested destination stage.', 409);
      }

      const previousStageId = application.currentStageId;
      const previousStageName = application.currentStage?.name || null;

      // Atomically update application status and stage
      const updatedApplication = await tx.jobApplication.update({
        where: { id: applicationId },
        data: {
          currentStageId: targetStageId,
          status: mappedStatus,
        },
        include: {
          job: { select: { id: true, title: true, companyId: true } },
          candidate: { select: { id: true, firstName: true, lastName: true, email: true } },
          currentStage: { select: { id: true, name: true, category: true, order: true } },
        },
      });

      // Insert history entry
      const historyEntry = await tx.applicationStageHistory.create({
        data: {
          applicationId,
          previousStageId,
          destinationStageId: targetStageId,
          actorId: actorContext?.adminId || actorContext?.id || null,
          notes,
          reviewerNotes,
          rejectionReason,
        },
      });

      // Record audit log entry in transaction
      await logCompanyAction({
        companyId: job.companyId,
        adminId: actorContext?.adminId || actorContext?.id || null,
        action: 'APPLICATION_STAGE_CHANGED',
        actor: actorContext?.name || actorContext?.email || 'ADMIN',
        details: {
          applicationId,
          jobId,
          candidateId: application.candidateId,
          previousStageId,
          previousStageName,
          destinationStageId: targetStageId,
          destinationStageName: destinationStage.name,
          previousStatus: application.status,
          newStatus: mappedStatus,
          notes,
          rejectionReason,
        },
        tx,
      });

      return {
        application: {
          ...updatedApplication,
          stageHistory: [historyEntry],
          stageHistories: [historyEntry],
        },
        history: historyEntry,
        previousStage: { id: previousStageId, name: previousStageName },
        destinationStage: { id: destinationStage.id, name: destinationStage.name, category: destinationStage.category },
      };
    });

    if (!actorContext?.suppressIndividualNotification) {
      try {
        const candidateName =
          `${result.application.candidate?.firstName || ''} ${result.application.candidate?.lastName || ''}`.trim() ||
          result.application.candidate?.email ||
          'Candidate';

        BusinessEventNotificationService.notifyPipelineStageChanged({
          application: result.application,
          job,
          candidateName,
          previousStageName: result.previousStage.name,
          newStageName: result.destinationStage.name,
          newStageCategory: result.destinationStage.category,
        }).catch((err) => logger.warn(`[Jobs] Failed to send pipeline stage change notification: ${err.message}`));
      } catch (notifErr) {
        logger.warn(`[Jobs] Error dispatching pipeline stage change notification: ${notifErr.message}`);
      }
    }

    return {
      success: true,
      message: `Application successfully moved to stage "${destinationStage.name}".`,
      data: result.application,
      application: result.application,
      history: result.history,
    };
  }

  /**
   * PATCH /api/jobs/:jobId/applications/batch-stage
   * Move multiple applications with clear per-item success/failure results.
   */
  static async batchUpdateApplicationStage(jobId, payload, actorContext = {}) {
    let items = [];
    if (Array.isArray(payload.applications) && payload.applications.length > 0) {
      items = payload.applications.map((app) => ({
        applicationId: app.applicationId || app.id,
        destinationStageId: app.destinationStageId || app.stageId || payload.destinationStageId || payload.stageId,
        expectedPreviousStageId:
          app.expectedPreviousStageId ||
          app.previousStageId ||
          payload.expectedPreviousStageId ||
          payload.previousStageId,
        notes: app.notes || app.reviewerNotes || payload.notes || payload.reviewerNotes || null,
        reviewerNotes: app.reviewerNotes || app.notes || payload.reviewerNotes || payload.notes || null,
        rejectionReason: app.rejectionReason || payload.rejectionReason || null,
      }));
    } else if (Array.isArray(payload.applicationIds) && payload.applicationIds.length > 0) {
      const commonStageId = payload.destinationStageId || payload.stageId;
      items = payload.applicationIds.map((id) => ({
        applicationId: id,
        destinationStageId: commonStageId,
        expectedPreviousStageId: payload.expectedPreviousStageId || payload.previousStageId,
        notes: payload.notes || payload.reviewerNotes || null,
        reviewerNotes: payload.reviewerNotes || payload.notes || null,
        rejectionReason: payload.rejectionReason || null,
      }));
    }

    if (items.length === 0) {
      throw createHttpError('No applications provided for batch transition.', 400);
    }

    const results = [];
    let succeededCount = 0;
    let failedCount = 0;

    for (const item of items) {
      try {
        if (!item.destinationStageId) {
          throw createHttpError('Destination stage ID is required for each application item.', 400);
        }
        const transitionResult = await JobService.updateApplicationStage(
          jobId,
          item.applicationId,
          item,
          { ...actorContext, suppressIndividualNotification: true }
        );
        succeededCount++;
        results.push({
          applicationId: item.applicationId,
          success: true,
          currentStageId: item.destinationStageId,
          status: transitionResult.application.status,
          message: 'Successfully transitioned stage.',
        });
      } catch (err) {
        failedCount++;
        results.push({
          applicationId: item.applicationId,
          success: false,
          error: err.message,
          statusCode: err.status || err.statusCode || 400,
        });
      }
    }

    if (succeededCount > 0) {
      try {
        const job = await prisma.job.findFirst({
          where: { id: jobId },
          select: { id: true, title: true, companyId: true },
        });

        const targetStage = items[0]?.destinationStageId
          ? await prisma.recruitmentStage.findUnique({
              where: { id: items[0].destinationStageId },
              select: { name: true },
            })
          : null;

        if (job) {
          BusinessEventNotificationService.notifyBulkPipelineStagesChanged({
            job,
            count: succeededCount,
            newStageName: targetStage?.name || 'New Stage',
          }).catch((err) => logger.warn(`[Jobs] Failed to send bulk pipeline notification: ${err.message}`));
        }
      } catch (bulkErr) {
        logger.warn(`[Jobs] Error dispatching bulk pipeline notification: ${bulkErr.message}`);
      }
    }

    return {
      success: true,
      summary: {
        total: items.length,
        succeeded: succeededCount,
        failed: failedCount,
      },
      results,
    };
  }
}
