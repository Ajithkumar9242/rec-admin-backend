import { prisma } from '../../lib/prisma.js';
import { EntitlementService } from '../billing/entitlement.service.js';
import { evaluateJobApprovalStatus } from '../configuration/jobApprovalPolicy.js';
import {
  validateResumeFile,
  enforceEmployerContactVisibility,
} from '../configuration/candidateVisibilityPolicy.js';
import { inspectFileSignature } from '../../lib/fileValidation.js';

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.status = statusCode;
  error.statusCode = statusCode;
  return error;
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

    return await prisma.$transaction(async (tx) => {
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

    if (isActivating) {
      if (company.status !== 'ACTIVE') {
        throw createHttpError('Cannot publish jobs while company is not in ACTIVE status.', 400);
      }
      await EntitlementService.checkEntitlement({
        companyId: company.id,
        resourceType: 'jobPosting',
        requestedCount: 1,
      });
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

    const updated = await prisma.job.update({
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

      if (!['PUBLISHED', 'PENDING_APPROVAL'].includes(existingJob.status)) {
        await EntitlementService.checkEntitlement({
          companyId: company.id,
          resourceType: 'jobPosting',
          requestedCount: 1,
        });
      }
    }

    const updated = await prisma.job.update({
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
    return await prisma.$transaction(async (tx) => {
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

      const updated = await tx.job.update({
        where: { id },
        data: {
          deletedAt: null,
          status: 'DRAFT',
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
    const application = await prisma.$transaction(async (tx) => {
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
          currentStage: {
            select: { id: true, name: true, category: true },
          },
        },
      });

      // If auto-close enabled and this application reached the limit, close now
      if (job.maxApplicantsLimit && job.autoCloseOnLimit) {
        const newCount = await tx.jobApplication.count({ where: { jobId } });
        if (newCount >= job.maxApplicantsLimit) {
          await tx.job.update({
            where: { id: jobId },
            data: { status: 'CLOSED' },
          });
        }
      }

      return app;
    });

    return {
      success: true,
      applicationId: application.id,
      jobId: application.jobId,
      status: application.status,
      currentStage: application.currentStage?.name || 'Screening',
      appliedAt: application.appliedAt,
    };
  }
}
