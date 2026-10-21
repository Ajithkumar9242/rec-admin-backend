import { prisma } from '../../lib/prisma.js';
import { env, buildEmployerActivationUrl } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { generateSecureToken, hashToken } from '../../lib/crypto.js';
import {
  isCloudinaryConfigured,
  getPrivateDownloadUrl,
  fetchPrivateAssetBuffer,
  deleteCloudinaryAsset,
  CLOUDINARY_NAMESPACES,
  uploadBuffer,
} from '../../lib/cloudinary.js';
import { validateUploadedFile } from '../../lib/fileValidation.js';
import {
  sendCompanyAdminInvitationEmail,
  sendCompanySubmissionAckEmail,
  sendCompanyApprovalEmail,
  sendCompanyRejectionEmail,
  sendCompanySuspensionEmail,
} from '../../lib/mailer.js';
import { logCompanyAction } from './companyAudit.service.js';
import { prepareSoftDeletePayload, activeRecordsFilter } from '../../lib/softDelete.js';
import { BusinessEventNotificationService } from '../notifications/businessEvent.service.js';

export class CompanyService {
  /**
   * List companies with filtering, sorting, and pagination
   */
  static async listCompanies({
    page = 1,
    limit = 10,
    search,
    status,
    industryId,
    country,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    trashed = false,
  }) {
    const skip = (page - 1) * limit;

    const isTrashed = trashed === true || trashed === 'true';
    const where = {
      deletedAt: isTrashed ? { not: null } : null,
    };

    if (status) {
      where.status = status;
    }

    if (industryId) {
      where.industryId = industryId;
    }

    if (country) {
      where.country = country;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { legalName: { contains: search, mode: 'insensitive' } },
        { companyCode: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { registrationNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    const validSortFields = ['name', 'createdAt', 'status', 'companyCode', 'country', 'updatedAt', 'deletedAt'];
    const defaultSort = isTrashed ? 'deletedAt' : 'createdAt';
    const orderField = validSortFields.includes(sortBy) ? sortBy : defaultSort;
    const orderDirection = sortOrder.toLowerCase() === 'asc' ? 'asc' : 'desc';

    const [total, items] = await Promise.all([
      prisma.company.count({ where }),
      prisma.company.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [orderField]: orderDirection },
        include: {
          industry: {
            select: { id: true, name: true, code: true },
          },
          _count: {
            select: {
              documents: true,
              users: true,
              subscriptions: true,
            },
          },
          subscriptions: {
            where: { status: 'ACTIVE' },
            take: 1,
            select: {
              id: true,
              status: true,
              plan: { select: { id: true, name: true } },
            },
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
   * Get single company by ID with full relations
   */
  static async getCompanyById(id) {
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        industry: {
          select: { id: true, name: true, code: true, parentId: true },
        },
        documents: {
          include: {
            documentDefinition: {
              select: { id: true, name: true, isRequired: true, acceptedFileTypes: true, maxFileSizeMb: true },
            },
          },
          orderBy: { uploadedAt: 'desc' },
        },
        users: {
          orderBy: { createdAt: 'desc' },
        },
        invitations: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            email: true,
            role: true,
            expiresAt: true,
            acceptedAt: true,
            sentAt: true,
            createdAt: true,
          },
        },
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            admin: {
              select: { id: true, name: true, email: true },
            },
          },
        },
        subscriptions: {
          include: {
            plan: { select: { id: true, name: true, price: true, currency: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        invoices: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    return company;
  }

  /**
   * Helper to generate a unique Company Code
   */
  static async generateCompanyCode(prefix = 'COMP') {
    let attempts = 0;
    while (attempts < 5) {
      const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
      const code = `${prefix}-${randomSuffix}`;
      const existing = await prisma.company.findUnique({ where: { companyCode: code } });
      if (!existing) return code;
      attempts++;
    }
    return `COMP-${Date.now().toString(36).toUpperCase()}`;
  }

  /**
   * Create a new company via onboarding wizard
   */
  static async createCompany(data, actorAdmin = null) {
    const {
      name,
      legalName,
      taxId,
      companyCode,
      registrationNumber,
      industryId,
      subIndustryId,
      companySize,
      foundedYear,
      description,
      hiringDomestic = true,
      hiringInternational = false,
      hiringEu = false,
      email,
      hrEmail,
      supportEmail,
      phone,
      alternatePhone,
      website,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country = 'DE',
      billingEmail,
      billingAddress,
      logoUrl,
      logoPublicId,
      bannerUrl,
      bannerPublicId,
      promoVideoUrl,
      promoVideoPublicId,
      initialAdminEmail,
      initialAdminFirstName,
      initialAdminLastName,
      documents = [],
    } = data;

    // Ensure name is clean and falls back to legalName if needed
    const finalName = (name || legalName || '').trim();
    if (!finalName) {
      const error = new Error('Company name is required');
      error.status = 400;
      throw error;
    }

    // Determine or generate unique company code
    let finalCode = companyCode ? companyCode.trim().toUpperCase() : null;
    if (finalCode) {
      const existing = await prisma.company.findUnique({ where: { companyCode: finalCode } });
      if (existing) {
        const error = new Error(`Company code "${finalCode}" is already in use`);
        error.status = 400;
        error.code = 'DUPLICATE_COMPANY_CODE';
        error.field = 'companyCode';
        throw error;
      }
    } else {
      finalCode = await this.generateCompanyCode();
    }

    // Validate industry if provided
    if (industryId) {
      const industry = await prisma.industry.findUnique({ where: { id: industryId } });
      if (!industry) {
        const error = new Error('Selected industry does not exist');
        error.status = 400;
        throw error;
      }
    }

    // Execute in transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create company
      const company = await tx.company.create({
        data: {
          name: finalName,
          legalName: legalName || null,
          taxId: taxId || null,
          companyCode: finalCode,
          registrationNumber: registrationNumber || null,
          industryId: industryId || null,
          subIndustryId: subIndustryId || null,
          companySize: companySize || null,
          foundedYear: foundedYear || null,
          description: description || null,
          hiringDomestic,
          hiringInternational,
          hiringEu,
          email: email || null,
          hrEmail: hrEmail || null,
          supportEmail: supportEmail || null,
          phone: phone || null,
          alternatePhone: alternatePhone || null,
          website: website || null,
          addressLine1: addressLine1 || null,
          addressLine2: addressLine2 || null,
          city: city || null,
          state: state || null,
          postalCode: postalCode || null,
          country: country || 'DE',
          billingEmail: billingEmail || email || null,
          billingAddress: billingAddress || (addressLine1 ? `${addressLine1}, ${city || ''} ${postalCode || ''} ${country || ''}`.trim() : null),
          logoUrl: logoUrl || null,
          logoPublicId: logoPublicId || null,
          bannerUrl: bannerUrl || null,
          bannerPublicId: bannerPublicId || null,
          promoVideoUrl: promoVideoUrl || null,
          promoVideoPublicId: promoVideoPublicId || null,
          status: 'IN_REVIEW',
        },
      });

      // 2. Attach initial documents
      if (documents.length > 0) {
        await tx.companyDocument.createMany({
          data: documents.map((doc) => ({
            companyId: company.id,
            documentDefinitionId: doc.documentDefinitionId || null,
            name: doc.name,
            fileUrl: doc.fileUrl,
            publicId: doc.publicId || null,
            fileSizeBytes: doc.fileSizeBytes || null,
            mimeType: doc.mimeType || null,
            isPrivate: doc.isPrivate !== undefined ? doc.isPrivate : true,
            reviewStatus: 'PENDING',
          })),
        });
      }

      // 3. Create initial company administrator if email provided
      let createdUser = null;
      let invitationToken = null;
      let invitationRecord = null;

      if (initialAdminEmail) {
        createdUser = await tx.companyUser.create({
          data: {
            companyId: company.id,
            email: initialAdminEmail.toLowerCase().trim(),
            firstName: initialAdminFirstName || null,
            lastName: initialAdminLastName || null,
            role: 'ADMIN',
            status: 'INVITED',
          },
        });

        const rawToken = generateSecureToken(32);
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + (env.COMPANY_INVITATION_EXPIRES_HOURS || 48) * 3600 * 1000);

        invitationRecord = await tx.companyInvitation.create({
          data: {
            companyId: company.id,
            userId: createdUser.id,
            email: createdUser.email,
            role: 'ADMIN',
            tokenHash,
            expiresAt,
          },
        });

        invitationToken = rawToken;
      }

      // 4. Log audit action
      await logCompanyAction({
        companyId: company.id,
        adminId: actorAdmin?.id || null,
        action: 'COMPANY_CREATED',
        actor: actorAdmin?.email || 'SYSTEM',
        details: {
          name: company.name,
          companyCode: company.companyCode,
          status: company.status,
          initialAdminEmail: initialAdminEmail || null,
          documentCount: documents.length,
        },
        tx,
      });

      return { company, user: createdUser, invitationToken, invitationRecord };
    });

    // 5. Asynchronous transactional notifications after transaction commit
    const company = result.company;

    // Send invitation email
    let invitationSent = false;
    let activationUrl = null;
    let invitationError = null;
    if (result.invitationToken && initialAdminEmail) {
      activationUrl = buildEmployerActivationUrl(result.invitationToken);
      try {
        const mailRes = await sendCompanyAdminInvitationEmail({
          to: initialAdminEmail,
          recipientName: initialAdminFirstName || initialAdminEmail,
          companyName: company.name,
          invitationUrl: activationUrl,
          expiresHours: env.COMPANY_INVITATION_EXPIRES_HOURS || 48,
        });
        invitationSent = Boolean(mailRes && mailRes.success && mailRes.delivered);
        if (!invitationSent) {
          invitationError = mailRes?.error || 'Failed to deliver invitation email via SMTP';
        }
      } catch (err) {
        logger.error({ error: err.message, companyId: company.id }, 'Unexpected error dispatching invitation email');
        invitationSent = false;
        invitationError = err.message;
      }
    }

    // Send onboarding acknowledgment email
    const notifyEmail = company.email || initialAdminEmail;
    if (notifyEmail) {
      try {
        await sendCompanySubmissionAckEmail({
          to: notifyEmail,
          recipientName: initialAdminFirstName || company.name,
          companyName: company.name,
        });
      } catch (err) {
        logger.warn({ error: err.message, companyId: company.id }, 'Failed to send company submission acknowledgment email');
      }
    }

    // Emit centralized business event notification
    BusinessEventNotificationService.notifyCompanyCreated({
      company,
      actorAdminId: actorAdmin?.id,
    }).catch((err) => {
      logger.warn({ error: err.message, companyId: company.id }, 'Failed to emit company created notification');
    });

    return {
      company,
      invitationSent,
      invitationStatus: result.invitationRecord
        ? (invitationSent ? 'SENT' : 'PENDING_RETRY')
        : null,
      invitationError: !invitationSent ? invitationError : null,
      invitation: result.invitationRecord ? {
        id: result.invitationRecord.id,
        email: result.invitationRecord.email,
        role: result.invitationRecord.role,
        expiresAt: result.invitationRecord.expiresAt,
        delivered: invitationSent,
      } : null,
      // Provide activationUrl in response if email delivery failed or unconfigured
      activationUrl: !invitationSent ? activationUrl : undefined,
    };
  }

  /**
   * Update company details
   */
  static async updateCompany(id, data, actorAdmin = null) {
    const existing = await prisma.company.findUnique({ where: { id } });
    if (!existing) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    if (existing.deletedAt !== null) {
      const error = new Error('Company has been moved to trash');
      error.status = 404;
      throw error;
    }

    if (data.companyCode && data.companyCode !== existing.companyCode) {
      const codeInUse = await prisma.company.findFirst({
        where: {
          companyCode: data.companyCode.trim().toUpperCase(),
          id: { not: id },
        },
      });
      if (codeInUse) {
        const error = new Error(`Company code "${data.companyCode}" is already in use`);
        error.status = 400;
        throw error;
      }
    }

    const updated = await prisma.company.update({
      where: { id },
      data: {
        ...data,
        companyCode: data.companyCode ? data.companyCode.trim().toUpperCase() : undefined,
      },
      include: {
        industry: {
          select: { id: true, name: true, code: true },
        },
      },
    });

    await logCompanyAction({
      companyId: id,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_UPDATED',
      actor: actorAdmin?.email || 'SYSTEM',
      details: { changedFields: Object.keys(data) },
    });

    return updated;
  }

  /**
   * Delete company (Soft delete to Trash with 30-day retention or permanent delete if eligible)
   */
  static async deleteCompany(id, mode = 'MOVE_TO_TRASH', actorAdmin = null) {
    if (!id) {
      const error = new Error('Company ID is required');
      error.status = 400;
      throw error;
    }

    const existing = await prisma.company.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            subscriptions: true,
            invoices: true,
            documents: true,
            users: true,
            candidateAccessLogs: true,
            jobs: true,
          },
        },
      },
    });

    if (!existing) {
      const error = new Error(`Company with ID "${id}" was not found.`);
      error.status = 404;
      throw error;
    }

    if (mode === 'DELETE_PERMANENTLY') {
      // 1. Enforce Super Admin authorization on the server
      if (actorAdmin && actorAdmin.role !== 'SUPER_ADMIN') {
        const error = new Error('Only Super Administrators are authorized to permanently delete companies.');
        error.status = 403;
        throw error;
      }

      // 2. Data integrity & dependency check: never cascade delete active business records
      const counts = existing._count;
      const blockingReasons = [];
      if (counts.subscriptions > 0) blockingReasons.push(`${counts.subscriptions} subscription(s)`);
      if (counts.invoices > 0) blockingReasons.push(`${counts.invoices} invoice(s)`);
      if (counts.documents > 0) blockingReasons.push(`${counts.documents} compliance document(s)`);
      if (counts.users > 0) blockingReasons.push(`${counts.users} user account(s)`);
      if (counts.candidateAccessLogs > 0) blockingReasons.push(`${counts.candidateAccessLogs} candidate access log(s)`);
      if (counts.jobs > 0) blockingReasons.push(`${counts.jobs} job posting(s)`);

      if (blockingReasons.length > 0) {
        const error = new Error(
          `Cannot permanently delete company "${existing.name}" because it contains active business records (${blockingReasons.join(', ')}). To preserve financial, compliance, and audit records, please use "Move to Trash" (30-day retention) instead.`
        );
        error.status = 400;
        throw error;
      }

      // 3. Transaction-safe atomic deletion with row lock
      await prisma.$transaction(async (tx) => {
        // Prevent concurrent deletion/restore race conditions
        await tx.$executeRaw`SELECT 1 FROM companies WHERE id = ${id} FOR UPDATE`;

        // Clean up pending invitations if any
        await tx.companyInvitation.deleteMany({ where: { companyId: id } });

        // Clean up company audit logs
        await tx.companyAuditLog.deleteMany({ where: { companyId: id } });

        // Delete the company record
        await tx.company.delete({ where: { id } });
      });

      return {
        success: true,
        message: `Company "${existing.name}" was permanently deleted.`,
        data: {
          id,
          mode: 'DELETE_PERMANENTLY',
        },
      };
    }

    // Default: Soft delete (MOVE_TO_TRASH) with 30-day retention
    if (existing.deletedAt !== null) {
      const error = new Error(`Company "${existing.name}" is already in trash.`);
      error.status = 400;
      throw error;
    }

    const softPayload = prepareSoftDeletePayload(actorAdmin?.id);
    const updated = await prisma.company.update({
      where: { id },
      data: {
        deletedAt: softPayload.deletedAt,
        status: 'INACTIVE',
      },
    });

    await logCompanyAction({
      companyId: id,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_MOVED_TO_TRASH',
      actor: actorAdmin?.email || 'SYSTEM',
      details: {
        companyName: existing.name,
        companyCode: existing.companyCode,
        retentionDays: 30,
      },
    });

    // Emit centralized business event notification
    BusinessEventNotificationService.notifyCompanyStatusChanged({
      company: updated,
      status: 'INACTIVE',
      previousStatus: existing.status,
      reason: 'Company moved to Trash (30-day retention)',
      actorAdminId: actorAdmin?.id,
    }).catch((err) => {
      logger.warn({ error: err.message, companyId: id }, 'Failed to emit company moved to trash notification');
    });

    return {
      success: true,
      message: `Company "${existing.name}" moved to Trash with 30-day retention.`,
      data: {
        ...updated,
        mode: 'MOVE_TO_TRASH',
        retentionDays: 30,
      },
    };
  }

  /**
   * Restore company from Trash
   */
  static async restoreCompany(id, actorAdmin = null) {
    if (!id) {
      const error = new Error('Company ID is required');
      error.status = 400;
      throw error;
    }

    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM companies WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.company.findUnique({
        where: { id },
      });

      if (!existing) {
        const error = new Error(`Company with ID "${id}" was not found.`);
        error.status = 404;
        throw error;
      }

      if (existing.deletedAt === null) {
        const error = new Error(`Company "${existing.name}" is not in trash.`);
        error.status = 400;
        throw error;
      }

      // Verify 30-day retention window
      const deletedTime = new Date(existing.deletedAt).getTime();
      const daysSinceDeleted = (Date.now() - deletedTime) / (1000 * 3600 * 24);
      if (daysSinceDeleted > 30 && actorAdmin?.role !== 'SUPER_ADMIN') {
        const error = new Error(
          `Cannot restore company "${existing.name}" because the 30-day retention period has expired. Only Super Administrators can override.`
        );
        error.status = 403;
        throw error;
      }

      const updated = await tx.company.update({
        where: { id },
        data: {
          deletedAt: null,
          status: 'IN_REVIEW',
        },
        include: {
          industry: {
            select: { id: true, name: true, code: true },
          },
        },
      });

      await logCompanyAction({
        companyId: id,
        adminId: actorAdmin?.id || null,
        action: 'COMPANY_RESTORED',
        actor: actorAdmin?.email || 'SYSTEM',
        details: {
          companyName: existing.name,
          companyCode: existing.companyCode,
          daysInTrash: Math.round(daysSinceDeleted),
        },
        tx,
      });

      return {
        success: true,
        message: `Company "${existing.name}" was successfully restored from Trash.`,
        data: updated,
      };
    });

    // Emit centralized business event notification
    BusinessEventNotificationService.notifyCompanyRestored({
      company: result.data,
      actorAdminId: actorAdmin?.id,
    }).catch((err) => {
      logger.warn({ error: err.message, companyId: id }, 'Failed to emit company restored notification');
    });

    return result;
  }

  /**
   * Update company status with lifecycle safety checks
   */
  static async updateCompanyStatus(id, { status, reason }, actorAdmin = null) {
    const company = await prisma.company.findUnique({ where: { id } });
    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    const previousStatus = company.status;
    if (previousStatus === status) {
      return company;
    }

    // Disallow invalid lifecycle jumps
    if (status === 'SUSPENDED' && !reason) {
      const error = new Error('A reason is mandatory when suspending a company');
      error.status = 400;
      throw error;
    }

    const updateData = { status };

    if (status === 'SUSPENDED') {
      updateData.suspensionReason = reason;
    } else if (previousStatus === 'SUSPENDED' && status === 'ACTIVE') {
      updateData.suspensionReason = null;
    }

    if (status === 'ACTIVE' && !company.reviewedAt) {
      updateData.reviewedAt = new Date();
      updateData.reviewedBy = actorAdmin?.email || 'SYSTEM';
    }

    const updated = await prisma.company.update({
      where: { id },
      data: updateData,
    });

    await logCompanyAction({
      companyId: id,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_STATUS_UPDATED',
      actor: actorAdmin?.email || 'SYSTEM',
      details: {
        from: previousStatus,
        to: status,
        reason: reason || null,
      },
    });

    // Transactional notifications
    if (status === 'ACTIVE' && company.email) {
      await sendCompanyApprovalEmail({
        to: company.email,
        recipientName: company.name,
        companyName: company.name,
      });
    } else if (status === 'SUSPENDED' && company.email) {
      await sendCompanySuspensionEmail({
        to: company.email,
        recipientName: company.name,
        reason,
      });
    }

    // Emit centralized business event notification
    BusinessEventNotificationService.notifyCompanyStatusChanged({
      company: updated,
      status,
      reason,
      actorAdminId: actorAdmin?.id,
    }).catch((err) => {
      logger.warn({ error: err.message, companyId: id }, 'Failed to emit company status notification');
    });

    return updated;
  }

  /**
   * Formal admin review decision (Approve or Reject onboarding)
   */
  static async reviewCompany(id, { decision, notes, rejectionReason }, actorAdmin = null) {
    const company = await prisma.company.findUnique({ where: { id } });
    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    const isApproval = decision === 'APPROVE';

    if (!isApproval && !rejectionReason) {
      const error = new Error('A rejection reason is required when rejecting a company onboarding application');
      error.status = 400;
      throw error;
    }

    const newStatus = isApproval ? 'ACTIVE' : 'INACTIVE';

    const updated = await prisma.company.update({
      where: { id },
      data: {
        status: newStatus,
        reviewedAt: new Date(),
        reviewedBy: actorAdmin?.email || 'SYSTEM',
        reviewNotes: notes || null,
        rejectionReason: !isApproval ? rejectionReason : null,
      },
    });

    await logCompanyAction({
      companyId: id,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_REVIEWED',
      actor: actorAdmin?.email || 'SYSTEM',
      details: {
        decision,
        newStatus,
        notes: notes || null,
        rejectionReason: rejectionReason || null,
      },
    });

    // Dispatch appropriate notification email
    if (company.email) {
      if (isApproval) {
        await sendCompanyApprovalEmail({
          to: company.email,
          recipientName: company.name,
          companyName: company.name,
        });
      } else {
        await sendCompanyRejectionEmail({
          to: company.email,
          recipientName: company.name,
          companyName: company.name,
          reason: rejectionReason,
        });
      }
    }

    // Emit centralized business event notification
    BusinessEventNotificationService.notifyCompanyStatusChanged({
      company: updated,
      status: newStatus,
      decision,
      reason: rejectionReason,
      actorAdminId: actorAdmin?.id,
    }).catch((err) => {
      logger.warn({ error: err.message, companyId: id }, 'Failed to emit company review notification');
    });

    return updated;
  }

  /**
   * Upload and validate a file asset (compliance document, logo, or banner)
   */
  static async uploadCompanyAsset({
    file,
    type = 'document',
    companyId = null,
    documentDefinitionId = null,
    name = null,
    isPrivate: requestedPrivate = undefined,
  }, actorAdmin = null) {
    if (!file) {
      const error = new Error('No file provided for upload');
      error.status = 400;
      throw error;
    }

    const docName = name && typeof name === 'string' && name.trim() ? name.trim() : file.originalname;
    const isDocPrivate = requestedPrivate !== undefined
      ? (requestedPrivate === true || requestedPrivate === 'true')
      : true;

    let definition = null;
    if (documentDefinitionId) {
      definition = await prisma.documentDefinition.findUnique({
        where: { id: documentDefinitionId },
      });
      if (!definition || definition.targetType !== 'COMPANY') {
        const error = new Error('Invalid company document definition category');
        error.status = 400;
        throw error;
      }
    }

    // Enforce file signature inspection, dangerous extension blocking, and definition constraints
    validateUploadedFile(file, { definition });

    // Enforce Cloudinary configuration check (no faking or simulating!)
    if (!isCloudinaryConfigured()) {
      const error = new Error(
        'Cloudinary storage service is not configured in this environment. Please configure Cloudinary credentials or provide a direct asset URL.'
      );
      error.status = 503;
      throw error;
    }

    // Determine target folder & privacy
    let folder;
    let isPrivate = false;
    let resourceType = 'auto';

    if (type === 'logo') {
      folder = CLOUDINARY_NAMESPACES.LOGOS;
      resourceType = 'image';
      isPrivate = false;
    } else if (type === 'banner') {
      folder = CLOUDINARY_NAMESPACES.BANNERS;
      resourceType = 'image';
      isPrivate = false;
    } else {
      // Compliance Document: Private, authenticated access only by default
      folder = CLOUDINARY_NAMESPACES.DOCUMENTS;
      isPrivate = isDocPrivate;
      resourceType = file.mimetype?.includes('pdf') || file.originalname?.toLowerCase().endsWith('.pdf') ? 'raw' : 'auto';
    }

    const uploadRes = await uploadBuffer(file.buffer, {
      folder,
      resourceType,
      isPrivate,
      mimeType: file.mimetype,
    });

    // If companyId is supplied, attach directly to the company record
    if (companyId) {
      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) {
        const error = new Error('Company not found');
        error.status = 404;
        throw error;
      }

      if (company.deletedAt !== null) {
        const error = new Error('Company has been moved to trash');
        error.status = 404;
        throw error;
      }

      if (company.status === 'INACTIVE' && actorAdmin?.role !== 'SUPER_ADMIN') {
        const error = new Error('Access denied: Company is inactive and asset upload is restricted');
        error.status = 403;
        throw error;
      }

      if (type === 'logo') {
        const updated = await prisma.company.update({
          where: { id: companyId },
          data: { logoUrl: uploadRes.secureUrl, logoPublicId: uploadRes.publicId },
        });
        await logCompanyAction({
          companyId,
          adminId: actorAdmin?.id || null,
          action: 'COMPANY_LOGO_UPDATED',
          actor: actorAdmin?.email || 'SYSTEM',
          details: { publicId: uploadRes.publicId },
        });
        return {
          fileUrl: uploadRes.secureUrl,
          publicId: uploadRes.publicId,
          type: 'logo',
          company: updated,
        };
      }

      if (type === 'banner') {
        const updated = await prisma.company.update({
          where: { id: companyId },
          data: { bannerUrl: uploadRes.secureUrl, bannerPublicId: uploadRes.publicId },
        });
        await logCompanyAction({
          companyId,
          adminId: actorAdmin?.id || null,
          action: 'COMPANY_BANNER_UPDATED',
          actor: actorAdmin?.email || 'SYSTEM',
          details: { publicId: uploadRes.publicId },
        });
        return {
          fileUrl: uploadRes.secureUrl,
          publicId: uploadRes.publicId,
          type: 'banner',
          company: updated,
        };
      }

      // Document attachment
      const document = await prisma.companyDocument.create({
        data: {
          companyId,
          documentDefinitionId: documentDefinitionId || null,
          name: docName,
          fileUrl: uploadRes.secureUrl,
          publicId: uploadRes.publicId,
          fileSizeBytes: file.size,
          mimeType: file.mimetype,
          isPrivate: isDocPrivate,
          reviewStatus: 'PENDING',
        },
        include: {
          documentDefinition: true,
        },
      });

      await logCompanyAction({
        companyId,
        adminId: actorAdmin?.id || null,
        action: 'COMPANY_DOCUMENT_UPLOADED',
        actor: actorAdmin?.email || 'SYSTEM',
        details: {
          documentId: document.id,
          name: document.name,
          publicId: uploadRes.publicId,
          fileSizeBytes: file.size,
        },
      });

      return document;
    }

    // Staging mode (e.g. within the onboarding wizard prior to company record creation)
    return {
      fileUrl: uploadRes.secureUrl,
      publicId: uploadRes.publicId,
      fileSizeBytes: file.size,
      mimeType: file.mimetype,
      name: docName,
      documentDefinitionId: documentDefinitionId || null,
      isPrivate: isDocPrivate,
    };
  }

  /**
   * Add document to company
   */
  static async addCompanyDocument(companyId, docData, actorAdmin = null) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    if (company.deletedAt !== null) {
      const error = new Error('Company has been moved to trash');
      error.status = 404;
      throw error;
    }

    if (company.status === 'INACTIVE' && actorAdmin?.role !== 'SUPER_ADMIN') {
      const error = new Error('Access denied: Company is inactive and document attachments are restricted');
      error.status = 403;
      throw error;
    }

    if (docData.documentDefinitionId) {
      const def = await prisma.documentDefinition.findUnique({
        where: { id: docData.documentDefinitionId },
      });
      if (!def || def.targetType !== 'COMPANY') {
        const error = new Error('Invalid company document definition ID');
        error.status = 400;
        throw error;
      }
    }

    const document = await prisma.companyDocument.create({
      data: {
        companyId,
        documentDefinitionId: docData.documentDefinitionId || null,
        name: docData.name,
        fileUrl: docData.fileUrl,
        publicId: docData.publicId || null,
        fileSizeBytes: docData.fileSizeBytes || null,
        mimeType: docData.mimeType || null,
        isPrivate: docData.isPrivate !== undefined ? Boolean(docData.isPrivate) : true,
        reviewStatus: 'PENDING',
      },
      include: {
        documentDefinition: true,
      },
    });

    await logCompanyAction({
      companyId,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_DOCUMENT_ADDED',
      actor: actorAdmin?.email || 'SYSTEM',
      details: {
        documentId: document.id,
        name: document.name,
        isPrivate: document.isPrivate,
      },
    });

    return document;
  }

  /**
   * Review a company document
   */
  static async reviewCompanyDocument(companyId, documentId, { decision, rejectionReason }, actorAdmin = null) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    if (company.deletedAt !== null) {
      const error = new Error('Company has been moved to trash');
      error.status = 404;
      throw error;
    }

    const document = await prisma.companyDocument.findFirst({
      where: { id: documentId, companyId },
    });

    if (!document) {
      const error = new Error('Document not found for this company');
      error.status = 404;
      throw error;
    }

    const reviewStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

    const updated = await prisma.companyDocument.update({
      where: { id: documentId },
      data: {
        reviewStatus,
        reviewedAt: new Date(),
        reviewedBy: actorAdmin?.email || 'SYSTEM',
        rejectionReason: decision === 'REJECT' ? rejectionReason || null : null,
      },
      include: {
        documentDefinition: true,
      },
    });

    await logCompanyAction({
      companyId,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_DOCUMENT_REVIEWED',
      actor: actorAdmin?.email || 'SYSTEM',
      details: {
        documentId,
        decision,
        reviewStatus,
        rejectionReason: rejectionReason || null,
      },
    });

    return updated;
  }

  /**
   * Delete a company document
   */
  static async deleteCompanyDocument(companyId, documentId, actorAdmin = null) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    if (company.deletedAt !== null) {
      const error = new Error('Company has been moved to trash');
      error.status = 404;
      throw error;
    }

    const document = await prisma.companyDocument.findFirst({
      where: { id: documentId, companyId },
    });

    if (!document) {
      const error = new Error('Document not found for this company');
      error.status = 404;
      throw error;
    }

    // Try deleting remote Cloudinary asset if publicId exists
    if (document.publicId && isCloudinaryConfigured()) {
      try {
        await deleteCloudinaryAsset(document.publicId, {
          resourceType: document.mimeType?.includes('pdf') || document.mimeType?.includes('word') ? 'raw' : 'image',
          isPrivate: document.isPrivate,
        });
      } catch (err) {
        logger.warn({ error: err.message, publicId: document.publicId }, 'Cloudinary asset deletion skipped/failed');
      }
    }

    await prisma.companyDocument.delete({ where: { id: documentId } });

    await logCompanyAction({
      companyId,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_DOCUMENT_DELETED',
      actor: actorAdmin?.email || 'SYSTEM',
      details: { documentId, name: document.name },
    });

    return { success: true };
  }

  /**
   * Stream company document binary content for authorized preview or download
   */
  static async streamCompanyDocument(companyId, documentId, actorAdmin = null) {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, status: true, deletedAt: true },
    });

    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    if (company.deletedAt !== null) {
      const error = new Error('Company has been moved to trash');
      error.status = 404;
      throw error;
    }

    if (company.status === 'INACTIVE' && actorAdmin?.role !== 'SUPER_ADMIN') {
      const error = new Error('Access denied: Company is inactive and document access is restricted');
      error.status = 403;
      throw error;
    }

    const document = await prisma.companyDocument.findFirst({
      where: { id: documentId, companyId },
    });

    if (!document) {
      const error = new Error('Document not found for this company');
      error.status = 404;
      throw error;
    }

    let buffer = null;
    let mimeType = document.mimeType || 'application/pdf';

    if (document.publicId && isCloudinaryConfigured()) {
      const isRawType =
        document.mimeType?.includes('pdf') ||
        document.mimeType?.includes('word') ||
        document.name?.toLowerCase().endsWith('.pdf');

      const asset = await fetchPrivateAssetBuffer(document.publicId, {
        resourceType: isRawType ? 'raw' : 'image',
      });
      buffer = asset.buffer;
      if (asset.contentType && asset.contentType !== 'application/octet-stream') {
        mimeType = asset.contentType;
      }
    } else if (document.fileUrl) {
      if (document.fileUrl.startsWith('http://') || document.fileUrl.startsWith('https://')) {
        const resp = await fetch(document.fileUrl);
        if (!resp.ok) {
          const error = new Error(`Failed to retrieve document from storage provider (HTTP ${resp.status})`);
          error.status = resp.status === 404 ? 404 : 502;
          throw error;
        }
        const ab = await resp.arrayBuffer();
        buffer = Buffer.from(ab);
        const ct = resp.headers.get('content-type');
        if (ct) mimeType = ct;
      } else {
        const error = new Error('Document storage identifier or URL is invalid');
        error.status = 404;
        throw error;
      }
    } else {
      const error = new Error('No storage reference found for document');
      error.status = 404;
      throw error;
    }

    if (!buffer || buffer.length === 0) {
      const error = new Error('Storage provider returned an empty document file');
      error.status = 502;
      throw error;
    }

    // Binary inspection: confirm valid PDF header if document is expected to be a PDF
    const isPdf =
      mimeType.toLowerCase().includes('pdf') ||
      (document.name && document.name.toLowerCase().endsWith('.pdf'));

    if (isPdf) {
      if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== '%PDF-') {
        logger.error(
          {
            documentId,
            companyId,
            byteLength: buffer.length,
            prefixSnippet: buffer.subarray(0, 20).toString(),
          },
          'Corrupted document payload: failed PDF magic number validation'
        );
        const error = new Error('Document payload is corrupted or not a valid PDF file');
        error.status = 502;
        throw error;
      }
      mimeType = 'application/pdf';
    }

    await logCompanyAction({
      companyId,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_DOCUMENT_STREAMED',
      actor: actorAdmin?.email || 'SYSTEM',
      details: {
        documentId: document.id,
        name: document.name,
        bytes: buffer.length,
      },
    });

    return {
      buffer,
      mimeType,
      filename: document.name || 'document.pdf',
      length: buffer.length,
    };
  }

  /**
   * Generate signed download and preview URLs for private documents
   */
  static async getPrivateDocumentSignedUrl(companyId, documentId, actorAdmin = null) {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, status: true, deletedAt: true },
    });

    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    if (company.deletedAt !== null) {
      const error = new Error('Company has been moved to trash');
      error.status = 404;
      throw error;
    }

    if (company.status === 'INACTIVE' && actorAdmin?.role !== 'SUPER_ADMIN') {
      const error = new Error('Access denied: Company is inactive and document access is restricted');
      error.status = 403;
      throw error;
    }

    const document = await prisma.companyDocument.findFirst({
      where: { id: documentId, companyId },
    });

    if (!document) {
      const error = new Error('Document not found for this company');
      error.status = 404;
      throw error;
    }

    // Public document handling: deliberate public delivery allowed by admin
    if (!document.isPrivate) {
      return {
        url: document.fileUrl,
        downloadUrl: document.fileUrl,
        previewUrl: document.fileUrl,
        directSignedUrl: document.fileUrl,
        isPrivate: false,
        isSigned: false,
      };
    }

    // Backend proxy URLs ensuring strict session authentication, PDF integrity, and proper headers
    const streamDownloadUrl = `/api/companies/${companyId}/documents/${documentId}/file?disposition=attachment`;
    const streamPreviewUrl = `/api/companies/${companyId}/documents/${documentId}/file?disposition=inline`;

    let directSignedUrl = null;
    if (document.publicId && isCloudinaryConfigured()) {
      try {
        directSignedUrl = getPrivateDownloadUrl(document.publicId, {
          resourceType:
            document.mimeType?.includes('pdf') ||
            document.mimeType?.includes('word') ||
            document.name?.toLowerCase().endsWith('.pdf')
              ? 'raw'
              : 'image',
          expiresInSeconds: 3600,
        });
      } catch (err) {
        logger.warn({ error: err.message }, 'Failed to generate direct signed download URL');
      }
    }

    return {
      url: streamDownloadUrl,
      downloadUrl: streamDownloadUrl,
      previewUrl: streamPreviewUrl,
      directSignedUrl: directSignedUrl || document.fileUrl,
      isSigned: true,
    };
  }

  /**
   * Send an invitation to a company administrator/team member
   */
  static async sendCompanyInvitation(companyId, { email, role = 'ADMIN', firstName, lastName }, actorAdmin = null) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    const cleanEmail = email.toLowerCase().trim();

    // Find or create CompanyUser
    let user = await prisma.companyUser.findUnique({
      where: {
        companyId_email: {
          companyId,
          email: cleanEmail,
        },
      },
    });

    if (!user) {
      user = await prisma.companyUser.create({
        data: {
          companyId,
          email: cleanEmail,
          firstName: firstName || null,
          lastName: lastName || null,
          role,
          status: 'INVITED',
        },
      });
    }

    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + (env.COMPANY_INVITATION_EXPIRES_HOURS || 48) * 3600 * 1000);

    const invitation = await prisma.companyInvitation.create({
      data: {
        companyId,
        userId: user.id,
        email: cleanEmail,
        role,
        tokenHash,
        expiresAt,
      },
    });

    const activationUrl = buildEmployerActivationUrl(rawToken);
    const mailRes = await sendCompanyAdminInvitationEmail({
      to: cleanEmail,
      recipientName: firstName || cleanEmail,
      companyName: company.name,
      invitationUrl: activationUrl,
      expiresHours: env.COMPANY_INVITATION_EXPIRES_HOURS || 48,
    });

    await logCompanyAction({
      companyId,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_INVITATION_SENT',
      actor: actorAdmin?.email || 'SYSTEM',
      details: {
        invitationId: invitation.id,
        email: cleanEmail,
        role,
        delivered: mailRes.delivered,
      },
    });

    return {
      success: true,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        sentAt: invitation.sentAt,
      },
      delivered: mailRes.delivered,
      // Include activation link for manual delivery if SMTP is unconfigured
      activationUrl: !mailRes.delivered ? activationUrl : undefined,
    };
  }

  /**
   * Resend / retry an existing company invitation
   */
  static async resendCompanyInvitation(companyId, invitationId, actorAdmin = null) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      const error = new Error('Company not found');
      error.status = 404;
      throw error;
    }

    const invitation = await prisma.companyInvitation.findFirst({
      where: { id: invitationId, companyId },
      include: { user: true },
    });

    if (!invitation) {
      const error = new Error('Invitation not found for this company');
      error.status = 404;
      throw error;
    }

    if (invitation.acceptedAt) {
      const error = new Error('Invitation has already been accepted');
      error.status = 400;
      throw error;
    }

    // Generate fresh cryptographic token & update record
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + (env.COMPANY_INVITATION_EXPIRES_HOURS || 48) * 3600 * 1000);

    const updatedInvitation = await prisma.companyInvitation.update({
      where: { id: invitationId },
      data: {
        tokenHash,
        expiresAt,
        sentAt: new Date(),
      },
    });

    const activationUrl = buildEmployerActivationUrl(rawToken);
    let mailRes;
    try {
      mailRes = await sendCompanyAdminInvitationEmail({
        to: invitation.email,
        recipientName: invitation.user?.firstName || invitation.email,
        companyName: company.name,
        invitationUrl: activationUrl,
        expiresHours: env.COMPANY_INVITATION_EXPIRES_HOURS || 48,
      });
    } catch (mailErr) {
      mailRes = { success: false, delivered: false, error: mailErr.message };
    }

    await logCompanyAction({
      companyId,
      adminId: actorAdmin?.id || null,
      action: 'COMPANY_INVITATION_RESENT',
      actor: actorAdmin?.email || 'SYSTEM',
      details: {
        invitationId: updatedInvitation.id,
        email: updatedInvitation.email,
        role: updatedInvitation.role,
        delivered: Boolean(mailRes?.delivered),
      },
    });

    return {
      success: true,
      invitation: {
        id: updatedInvitation.id,
        email: updatedInvitation.email,
        role: updatedInvitation.role,
        expiresAt: updatedInvitation.expiresAt,
        sentAt: updatedInvitation.sentAt,
      },
      delivered: Boolean(mailRes?.delivered),
      activationUrl: !mailRes?.delivered ? activationUrl : undefined,
    };
  }

  /**
   * Public verification of an invitation token (called by Employer frontend when activation page loads)
   */
  static async verifyInvitationToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      const error = new Error('Invitation token is required');
      error.status = 400;
      throw error;
    }

    const tokenHash = hashToken(rawToken.trim());
    const invitation = await prisma.companyInvitation.findUnique({
      where: { tokenHash },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            legalName: true,
            companyCode: true,
            status: true,
            deletedAt: true,
            logoUrl: true,
          },
        },
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            status: true,
          },
        },
      },
    });

    if (!invitation) {
      const error = new Error('Invalid or unrecognised invitation token');
      error.status = 404;
      error.code = 'INVITATION_NOT_FOUND';
      throw error;
    }

    if (invitation.acceptedAt !== null) {
      const error = new Error('This invitation has already been accepted and can only be used once.');
      error.status = 400;
      error.code = 'INVITATION_ALREADY_ACCEPTED';
      throw error;
    }

    if (new Date() > new Date(invitation.expiresAt)) {
      const error = new Error(
        'This invitation has expired. Please contact your company administrator or request a new invitation.'
      );
      error.status = 400;
      error.code = 'INVITATION_EXPIRED';
      throw error;
    }

    if (invitation.company?.deletedAt !== null) {
      const error = new Error('The inviting company account has been moved to trash or deleted.');
      error.status = 404;
      error.code = 'COMPANY_NOT_FOUND';
      throw error;
    }

    if (invitation.company?.status === 'INACTIVE' || invitation.company?.status === 'SUSPENDED') {
      const error = new Error('The inviting company account is currently inactive or suspended.');
      error.status = 403;
      error.code = 'COMPANY_INACTIVE';
      throw error;
    }

    return {
      valid: true,
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      company: {
        id: invitation.company.id,
        name: invitation.company.name,
        legalName: invitation.company.legalName,
        logoUrl: invitation.company.logoUrl,
      },
      user: {
        firstName: invitation.user?.firstName || null,
        lastName: invitation.user?.lastName || null,
      },
    };
  }

  /**
   * Public acceptance/activation of an invitation token (called by Employer frontend to activate account)
   */
  static async activateInvitation({ token, firstName, lastName }) {
    if (!token || typeof token !== 'string') {
      const error = new Error('Invitation token is required');
      error.status = 400;
      throw error;
    }

    // Validate token and state rules
    const verification = await this.verifyInvitationToken(token);
    const tokenHash = hashToken(token.trim());

    return await prisma.$transaction(async (tx) => {
      // Mark invitation accepted
      const updatedInvitation = await tx.companyInvitation.update({
        where: { tokenHash },
        data: {
          acceptedAt: new Date(),
        },
      });

      // Update company user status to ACTIVE
      const updatedUser = await tx.companyUser.update({
        where: { id: updatedInvitation.userId },
        data: {
          status: 'ACTIVE',
          firstName: firstName ? firstName.trim() : undefined,
          lastName: lastName ? lastName.trim() : undefined,
        },
      });

      // Log company audit record
      await logCompanyAction({
        companyId: updatedInvitation.companyId,
        adminId: null,
        action: 'COMPANY_INVITATION_ACCEPTED',
        actor: updatedUser.email,
        details: {
          invitationId: updatedInvitation.id,
          userEmail: updatedUser.email,
          role: updatedUser.role,
        },
        tx,
      });

      return {
        success: true,
        message: 'Account successfully activated! You may now sign in to the employer portal.',
        data: {
          userId: updatedUser.id,
          email: updatedUser.email,
          role: updatedUser.role,
          companyId: updatedInvitation.companyId,
          activatedAt: updatedInvitation.acceptedAt,
        },
      };
    });

    // Emit centralized business event notification
    BusinessEventNotificationService.notifyCompanyInvitationAccepted({
      companyId: result.data.companyId,
      userEmail: result.data.email,
      userName: `${firstName || ''} ${lastName || ''}`.trim() || result.data.email,
    }).catch((err) => {
      logger.warn({ error: err.message, companyId: result.data.companyId }, 'Failed to emit company invitation accepted notification');
    });

    return result;
  }
}
