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
   * Create a new job posting for a company.
   * Gated by company active state, company hiring preference capability,
   * subscription quotas, and platform auto-approval policy.
   */
  static async createJob(jobData, actorContext = {}) {
    const { companyId, hiringScope = 'DOMESTIC', status = 'DRAFT' } = jobData;

    // 1. Validate company exists, is not in trash, and is active
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

    // 2. Validate Job Hiring Scope against Company hiring capabilities
    if (hiringScope === 'DOMESTIC' && !company.hiringDomestic) {
      throw createHttpError(
        'Company is not configured for domestic hiring. Update company preferences before posting domestic roles.',
        400
      );
    }
    if (hiringScope === 'EU' && !company.hiringEu) {
      throw createHttpError(
        'Company is not configured for EU hiring. Update company preferences before posting EU roles.',
        400
      );
    }
    if (hiringScope === 'INTERNATIONAL' && !company.hiringInternational) {
      throw createHttpError(
        'Company is not configured for international hiring. Update company preferences before posting international roles.',
        400
      );
    }

    // 3. For published or pending approval jobs, enforce active company status
    if (['PUBLISHED', 'PENDING_APPROVAL'].includes(status) && company.status !== 'ACTIVE') {
      throw createHttpError(
        `Company status is "${company.status}". Companies must be ACTIVE to publish or submit jobs for approval.`,
        400
      );
    }

    return await prisma.$transaction(async (tx) => {
      // 4. Enforce subscription quota when creating directly in active publishing status
      if (['PUBLISHED', 'PENDING_APPROVAL'].includes(status)) {
        // Row-level lock company to prevent race conditions during concurrent job publishing
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
            companyCode: true,
            status: true,
            hiringDomestic: true,
            hiringEu: true,
            hiringInternational: true,
          },
        },
        _count: {
          select: {
            applications: true,
          },
        },
      },
    });

    if (!job || job.deletedAt !== null) {
      throw createHttpError('Job posting not found.', 404);
    }

    return job;
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
    const newScope = updateData.hiringScope || existingJob.hiringScope;
    if (newScope === 'DOMESTIC' && !company.hiringDomestic) {
      throw createHttpError('Company is not configured for domestic hiring.', 400);
    }
    if (newScope === 'EU' && !company.hiringEu) {
      throw createHttpError('Company is not configured for EU hiring.', 400);
    }
    if (newScope === 'INTERNATIONAL' && !company.hiringInternational) {
      throw createHttpError('Company is not configured for international hiring.', 400);
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
        ...(statusToSet ? { status: statusToSet } : {}),
        ...(statusToSet === 'PUBLISHED' && !existingJob.publishedAt ? { publishedAt: new Date() } : {}),
        approvedAt,
        approvedBy,
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
   * Soft delete a job posting
   */
  static async deleteJob(id) {
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job || job.deletedAt !== null) {
      throw createHttpError('Job posting not found.', 404);
    }

    await prisma.job.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'ARCHIVED',
      },
    });

    return { success: true, message: 'Job posting deleted successfully.' };
  }

  /**
   * List jobs for a specific company (employer/admin view)
   */
  static async listCompanyJobs(companyId, { page = 1, limit = 10, status, search, hiringScope }) {
    const skip = (page - 1) * limit;
    const where = {
      companyId,
      deletedAt: null,
      ...(status ? { status } : {}),
      ...(hiringScope ? { hiringScope } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { department: { contains: search, mode: 'insensitive' } },
              { city: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

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
    employmentType,
    hiringScope,
    search,
  }) {
    const skip = (page - 1) * limit;
    const now = new Date();

    const platformSettings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    const where = {
      status: 'PUBLISHED',
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      company: {
        deletedAt: null,
        status: 'ACTIVE',
      },
      ...(country ? { country: country.toUpperCase() } : {}),
      ...(city ? { city: { contains: city, mode: 'insensitive' } } : {}),
      ...(workArrangement ? { workArrangement } : {}),
      ...(employmentType ? { employmentType } : {}),
      ...(hiringScope ? { hiringScope } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { department: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

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
          employmentType: true,
          hiringScope: true,
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
            },
          },
        },
      }),
    ]);

    // Sanitize employer contact information per platform visibility policy
    const items = rawJobs.map((job) => ({
      ...job,
      company: enforceEmployerContactVisibility(job.company, platformSettings),
    }));

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
        employmentType: true,
        hiringScope: true,
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
          },
        },
      },
    });

    if (!job) {
      throw createHttpError('Job posting not found, expired, or unavailable.', 404);
    }

    return {
      ...job,
      company: enforceEmployerContactVisibility(job.company, platformSettings),
    };
  }

  /**
   * Apply for a Job posting
   * Enforces:
   * - Job is active, published, and not expired
   * - Duplicate application check (409 Conflict)
   * - Resume format and MIME verification against platform settings
   * - Automatic initial recruitment stage assignment
   */
  static async applyForJob(jobId, applicationData) {
    const now = new Date();
    const platformSettings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
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
        companyId: true,
      },
    });

    if (!job) {
      throw createHttpError('Job posting is not open for applications.', 404);
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
      if (applicationData.resumeFileName?.toLowerCase().endsWith('.pdf') && sig.detectedType !== 'application/pdf' && sig.detectedType !== 'unknown') {
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

    // 4. Atomic candidate upsert & application creation
    const application = await prisma.$transaction(async (tx) => {
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
