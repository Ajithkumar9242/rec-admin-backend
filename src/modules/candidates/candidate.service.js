import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { BusinessEventNotificationService } from '../notifications/businessEvent.service.js';
import { env, buildCandidateActivationUrl } from '../../config/env.js';
import {
  hashPassword,
  verifyPassword,
  generateSecureToken,
  hashToken,
} from '../../lib/crypto.js';
import {
  sendCandidatePasswordResetEmail,
  sendCandidateVerificationEmail,
  sendCandidateAccountActivationEmail,
} from '../../lib/mailer.js';
import {
  validateResumeFile,
  enforceCandidateVisibility,
} from '../configuration/candidateVisibilityPolicy.js';
import { inspectFileSignature } from '../../lib/fileValidation.js';
import {
  isCloudinaryConfigured,
  uploadBuffer,
  deleteCloudinaryAsset,
  fetchPrivateAssetBuffer,
  getPrivateDownloadUrl,
  CLOUDINARY_NAMESPACES,
} from '../../lib/cloudinary.js';

function createHttpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$6+4jK82WcE0mOqj7Tf1L4XwN4x8aA9m1K1b4C3d2E5g';

export class CandidateService {
  /**
   * Derive candidate full name: [firstName, middleName, lastName].filter(Boolean).join(' ')
   */
  static deriveFullName(firstName, middleName, lastName) {
    return [firstName, middleName, lastName]
      .map((part) => (part || '').trim())
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Deterministic server-side profile completion percentage calculation (0-100%)
   */
  static computeProfileCompletion(candidate) {
    if (!candidate) return 0;
    let score = 0;

    // 1. Personal Details (25 points total)
    if (candidate.firstName && candidate.lastName) score += 5;
    if (candidate.phone) score += 5;
    if (candidate.dateOfBirth) score += 5;
    if (candidate.gender || candidate.maritalStatus) score += 5;
    if (candidate.nationality) score += 5;

    // 2. Address Details (15 points total)
    if (candidate.addressLine1) score += 5;
    if (candidate.city) score += 5;
    if (candidate.postalCode || candidate.country) score += 5;

    // 3. Professional Background (30 points total)
    if (candidate.currentJobTitle || candidate.profession) score += 10;
    if (candidate.yearsOfExperience !== null && candidate.yearsOfExperience !== undefined) score += 5;
    if (candidate.currentCompany || candidate.employmentType) score += 5;
    if (candidate.headline || candidate.summary) score += 5;
    if (candidate.noticePeriodDays !== null && candidate.noticePeriodDays !== undefined || candidate.expectedSalary) score += 5;

    // 4. Work Authorization & Mobility & Online (15 points total)
    if (candidate.workPermitAuthorized || candidate.visaStatus || candidate.passportNumber) score += 5;
    if (candidate.linkedinUrl || candidate.githubUrl || candidate.portfolioUrl) score += 5;
    if (candidate.preferredLocation || candidate.willingToRelocate) score += 5;

    // 5. Resume Uploaded (15 points total)
    if (candidate.resumeUrl) score += 15;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Candidate self-registration
   */
  static async register({ email, password, firstName, middleName, lastName, phone, currentLocation, country = 'DE' }) {
    const canonicalEmail = email.trim().toLowerCase();
    const fullName = this.deriveFullName(firstName, middleName, lastName);

    const existingCandidate = await prisma.candidate.findUnique({
      where: { email: canonicalEmail },
    });

    if (existingCandidate) {
      if (existingCandidate.passwordHash) {
        throw createHttpError('An account with this email address already exists. Please sign in or use password recovery.', 409);
      }

      // Candidate was created previously by Admin/Employer without password - claim/activate account
      const passwordHash = await hashPassword(password);
      const updated = await prisma.candidate.update({
        where: { id: existingCandidate.id },
        data: {
          passwordHash,
          firstName: firstName || existingCandidate.firstName,
          middleName: middleName !== undefined ? middleName : existingCandidate.middleName,
          lastName: lastName || existingCandidate.lastName,
          fullName: fullName || existingCandidate.fullName,
          phone: phone || existingCandidate.phone,
          currentLocation: currentLocation || existingCandidate.currentLocation,
          country: country || existingCandidate.country,
          emailVerified: true,
          status: existingCandidate.status === 'PENDING_APPROVAL' ? 'ACTIVE' : existingCandidate.status,
        },
      });

      const profileCompletion = this.computeProfileCompletion(updated);
      const finalCandidate = await prisma.candidate.update({
        where: { id: updated.id },
        data: { profileCompletion },
      });

      const { passwordHash: _p, passwordResetTokenHash: _rt, verificationTokenHash: _vt, ...safeCandidate } = finalCandidate;
      return safeCandidate;
    }

    const platformSettings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    const autoApprove = platformSettings?.autoApproveCandidateProfiles ?? true;
    const initialStatus = autoApprove ? 'ACTIVE' : 'PENDING_APPROVAL';
    const passwordHash = await hashPassword(password);

    const tempCandidate = {
      email: canonicalEmail,
      firstName,
      middleName: middleName || null,
      lastName,
      fullName,
      phone: phone || null,
      currentLocation: currentLocation || null,
      country,
      status: initialStatus,
      source: 'CAREER_PORTAL',
    };
    const profileCompletion = this.computeProfileCompletion(tempCandidate);

    const candidate = await prisma.candidate.create({
      data: {
        ...tempCandidate,
        passwordHash,
        emailVerified: true,
        profileCompletion,
      },
    });

    const { passwordHash: _p, passwordResetTokenHash: _rt, verificationTokenHash: _vt, ...safeCandidate } = candidate;

    BusinessEventNotificationService.notifyCandidateRegistered({
      candidate: safeCandidate,
    }).catch((err) => logger.warn(`[Candidates] Failed to send registration notification: ${err.message}`));

    return safeCandidate;
  }

  /**
   * Candidate sign in
   */
  static async login({ email, password }) {
    const canonicalEmail = email.trim().toLowerCase();
    const candidate = await prisma.candidate.findUnique({
      where: { email: canonicalEmail },
    });

    const now = new Date();

    if (candidate && candidate.lockedUntil && candidate.lockedUntil > now) {
      const waitMinutes = Math.ceil((candidate.lockedUntil.getTime() - now.getTime()) / 60000);
      throw createHttpError(`Account is temporarily locked due to excessive failed sign-in attempts. Please try again in ${waitMinutes} minute(s).`, 403);
    }

    if (!candidate || !candidate.passwordHash || candidate.deletedAt !== null) {
      await verifyPassword(DUMMY_HASH, password);
      throw createHttpError('Invalid email address or password.', 401);
    }

    const isValidPassword = await verifyPassword(candidate.passwordHash, password);

    if (!isValidPassword) {
      const failedAttempts = (candidate.failedLoginAttempts || 0) + 1;
      let lockedUntil = null;
      if (failedAttempts >= 5) {
        lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minute lockout
      }

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          failedLoginAttempts: failedAttempts,
          lockedUntil,
        },
      });

      if (lockedUntil) {
        throw createHttpError('Account has been locked for 15 minutes due to multiple failed sign-in attempts.', 403);
      }
      throw createHttpError('Invalid email address or password.', 401);
    }

    if (candidate.status === 'SUSPENDED') {
      throw createHttpError('Your candidate account has been suspended. Please contact platform support.', 403);
    }

    // Success - reset failed attempts, update lastLoginAt
    const updated = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: now,
      },
    });

    const { passwordHash: _p, passwordResetTokenHash: _rt, verificationTokenHash: _vt, ...safeCandidate } = updated;
    return safeCandidate;
  }

  /**
   * Password recovery initiation (non-enumerating)
   */
  static async forgotPassword(email) {
    const canonicalEmail = email.trim().toLowerCase();
    const candidate = await prisma.candidate.findUnique({
      where: { email: canonicalEmail },
    });

    if (candidate && candidate.deletedAt === null) {
      const rawToken = generateSecureToken(32);
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: expiresAt,
        },
      });

      const resetUrl = `${env.CANDIDATE_APP_URL || 'http://localhost:5173'}/reset-password?token=${rawToken}`;
      try {
        await sendCandidatePasswordResetEmail({
          to: candidate.email,
          resetUrl,
          recipientName: candidate.firstName,
        });
      } catch (err) {
        logger.warn({ error: err.message, email: candidate.email }, 'Failed to dispatch candidate password reset email');
      }
    }

    // Always generic message to prevent account enumeration
    return {
      success: true,
      message: 'If an account exists with that email address, password reset instructions have been dispatched.',
    };
  }

  /**
   * Password reset completion
   */
  static async resetPassword({ token, password }) {
    const tokenHash = hashToken(token);
    const now = new Date();

    const candidate = await prisma.candidate.findFirst({
      where: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { gt: now },
        deletedAt: null,
      },
    });

    if (!candidate) {
      throw createHttpError('Invalid or expired password reset token.', 400);
    }

    const passwordHash = await hashPassword(password);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    return {
      success: true,
      message: 'Password reset successfully. You can now sign in with your new credentials.',
    };
  }

  /**
   * Get candidate self profile
   */
  static async getCandidateProfile(candidateId) {
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      include: {
        _count: {
          select: {
            applications: true,
            savedJobs: true,
          },
        },
      },
    });

    if (!candidate || candidate.deletedAt !== null) {
      throw createHttpError('Candidate profile not found.', 404);
    }

    const { passwordHash, passwordResetTokenHash, verificationTokenHash, ...safeProfile } = candidate;
    return safeProfile;
  }

  /**
   * Update candidate self profile
   */
  /**
   * Helper to persist uploaded resume buffer to local filesystem storage as fallback
   */
  static async saveLocalResumeFile(file, candidateId = null) {
    const uploadDir = path.resolve(process.cwd(), 'uploads', 'resumes');
    await fs.promises.mkdir(uploadDir, { recursive: true });
    const safeOriginalName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniquePrefix = candidateId || crypto.randomUUID();
    const filename = `${uniquePrefix}_${safeOriginalName}`;
    const filePath = path.join(uploadDir, filename);
    await fs.promises.writeFile(filePath, file.buffer);
    return filename;
  }

  /**
   * Update candidate profile with authorization enforcement
   */
  static async updateCandidateProfile(candidateId, updateData, actorContext = {}) {
    const existing = await prisma.candidate.findUnique({
      where: { id: candidateId },
    });

    if (!existing || existing.deletedAt !== null) {
      throw createHttpError('Candidate not found.', 404);
    }

    let verifiedCompanyId = undefined;
    if (updateData.companyId !== undefined) {
      if (actorContext.isEmployer && actorContext.companyId) {
        if (updateData.companyId && updateData.companyId !== actorContext.companyId) {
          throw createHttpError('Employer users can only associate candidates with their own company.', 403);
        }
        verifiedCompanyId = actorContext.companyId;
      } else if (updateData.companyId && updateData.companyId.trim()) {
        const company = await prisma.company.findUnique({
          where: { id: updateData.companyId.trim() },
          select: { id: true, status: true, deletedAt: true },
        });
        if (!company || company.deletedAt !== null) {
          throw createHttpError('Selected company was not found or has been deactivated.', 400);
        }
        verifiedCompanyId = company.id;
      } else {
        verifiedCompanyId = null;
      }
    }

    const firstName = updateData.firstName !== undefined ? updateData.firstName : existing.firstName;
    const middleName = updateData.middleName !== undefined ? updateData.middleName : existing.middleName;
    const lastName = updateData.lastName !== undefined ? updateData.lastName : existing.lastName;
    const fullName = this.deriveFullName(firstName, middleName, lastName);

    const mergedData = {
      ...existing,
      ...updateData,
      firstName,
      middleName,
      lastName,
      fullName,
      ...(updateData.dateOfBirth ? { dateOfBirth: new Date(updateData.dateOfBirth) } : {}),
      ...(updateData.passportExpiryDate ? { passportExpiryDate: new Date(updateData.passportExpiryDate) } : {}),
      ...(verifiedCompanyId !== undefined ? { companyId: verifiedCompanyId } : {}),
    };

    const profileCompletion = this.computeProfileCompletion(mergedData);

    const updated = await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        ...updateData,
        fullName,
        profileCompletion,
        ...(updateData.dateOfBirth ? { dateOfBirth: new Date(updateData.dateOfBirth) } : {}),
        ...(updateData.passportExpiryDate ? { passportExpiryDate: new Date(updateData.passportExpiryDate) } : {}),
        ...(verifiedCompanyId !== undefined ? { companyId: verifiedCompanyId } : {}),
      },
      include: {
        company: { select: { id: true, name: true, logoUrl: true } },
      },
    });

    const { passwordHash, passwordResetTokenHash, verificationTokenHash, invitationTokenHash, ...safeProfile } = updated;
    return safeProfile;
  }

  /**
   * Upload and validate candidate resume
   */
  static async uploadResume(candidateId, file) {
    if (!file) {
      throw createHttpError('Resume file is required.', 400);
    }

    const platformSettings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    // 1. File size check (10MB max)
    if (file.size > 10 * 1024 * 1024) {
      throw createHttpError('Resume file exceeds maximum limit of 10 MB.', 400);
    }

    // 2. Binary signature inspection
    if (file.buffer) {
      const sig = inspectFileSignature(file.buffer);
      if (sig.isExecutable) {
        throw createHttpError('Binary content inspection detected an executable payload. Upload rejected.', 400);
      }
      if (
        file.originalname.toLowerCase().endsWith('.pdf') &&
        sig.detectedType !== 'application/pdf' &&
        sig.detectedType !== 'unknown'
      ) {
        throw createHttpError('File extension is .pdf but binary content signature is not a valid PDF document.', 400);
      }
    }

    // 3. Platform policy extension & MIME type check
    const resumeValidation = validateResumeFile(
      file.originalname,
      file.mimetype,
      platformSettings?.acceptedResumeFileTypes
    );

    if (!resumeValidation.valid) {
      throw createHttpError(resumeValidation.error, 400);
    }

    let resumeUrl = `/api/candidates/me/resume`;
    let resumePublicId = null;
    const resumeFileName = file.originalname;
    const resumeMimeType = file.mimetype;

    if (isCloudinaryConfigured()) {
      try {
        const uploaded = await uploadBuffer(file.buffer, {
          folder: CLOUDINARY_NAMESPACES.DOCUMENTS,
          isPrivate: true,
          resourceType: 'raw',
        });
        resumeUrl = uploaded.secureUrl;
        resumePublicId = uploaded.publicId;
      } catch (uploadErr) {
        logger.error({ error: uploadErr.message }, 'Failed to upload resume to private storage');
        throw createHttpError(`Failed to securely store resume document: ${uploadErr.message}`, 500);
      }
    } else {
      const localFileName = await CandidateService.saveLocalResumeFile(file, candidateId);
      resumePublicId = localFileName;
      resumeUrl = `/api/candidates/me/resume`;
    }

    const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) {
      throw createHttpError('Candidate not found.', 404);
    }

    const merged = {
      ...candidate,
      resumeUrl,
      resumePublicId,
      resumeFileName,
      resumeMimeType,
    };
    const profileCompletion = this.computeProfileCompletion(merged);

    const updated = await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        resumeUrl,
        resumePublicId,
        resumeFileName,
        resumeMimeType,
        profileCompletion,
      },
    });

    const { passwordHash, passwordResetTokenHash, verificationTokenHash, ...safeProfile } = updated;
    return safeProfile;
  }

  /**
   * Stream authenticated resume binary for preview (inline) or download (attachment)
   */
  static async streamCandidateResume(candidateId, disposition = 'inline', actorContext = {}) {
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      include: {
        company: { select: { id: true, name: true } },
      },
    });

    if (!candidate || candidate.deletedAt !== null) {
      throw createHttpError('Candidate not found.', 404);
    }

    // Authorization check
    if (actorContext.isCandidate) {
      if (candidate.id !== actorContext.candidateId) {
        throw createHttpError('Unauthorized access to candidate resume.', 403);
      }
    } else if (actorContext.isEmployer && actorContext.companyId) {
      const isAssociated = candidate.companyId === actorContext.companyId;
      if (!isAssociated) {
        const applicationCount = await prisma.jobApplication.count({
          where: {
            candidateId: candidate.id,
            job: { companyId: actorContext.companyId, deletedAt: null },
          },
        });
        if (applicationCount === 0) {
          throw createHttpError('Unauthorized access: candidate is not associated with your company.', 403);
        }
      }
    } else if (!actorContext.isAdmin && !actorContext.adminId) {
      throw createHttpError('Authentication required to access confidential resume document.', 401);
    }

    // Document check
    if (!candidate.resumeFileName && !candidate.resumePublicId && !candidate.resumeUrl) {
      throw createHttpError('Resume document not found for this candidate.', 404);
    }

    const filename = candidate.resumeFileName || 'Resume.pdf';
    const mimeType = candidate.resumeMimeType || 'application/pdf';

    // Retrieve buffer from Cloudinary or local disk
    let fileBuffer = null;

    if (candidate.resumePublicId && isCloudinaryConfigured()) {
      try {
        const asset = await fetchPrivateAssetBuffer(candidate.resumePublicId, { resourceType: 'raw' });
        fileBuffer = asset.buffer;
      } catch (cloudErr) {
        logger.warn(
          { error: cloudErr.message, candidateId, publicId: candidate.resumePublicId },
          'Cloudinary fetch failed, checking local storage fallback'
        );
      }
    }

    if (!fileBuffer) {
      const uploadDir = path.resolve(process.cwd(), 'uploads', 'resumes');
      const possibleFilenames = [
        candidate.resumePublicId,
        `${candidate.id}_${filename}`,
      ].filter(Boolean);

      for (const fname of possibleFilenames) {
        const fullPath = path.join(uploadDir, path.basename(fname));
        try {
          if (fs.existsSync(fullPath)) {
            fileBuffer = await fs.promises.readFile(fullPath);
            break;
          }
        } catch {
          // continue
        }
      }

      if (!fileBuffer && fs.existsSync(uploadDir)) {
        try {
          const files = await fs.promises.readdir(uploadDir);
          const matched = files.find((f) => f.startsWith(`${candidate.id}_`));
          if (matched) {
            fileBuffer = await fs.promises.readFile(path.join(uploadDir, matched));
          }
        } catch {
          // ignore
        }
      }
    }

    if (!fileBuffer) {
      throw createHttpError('Resume file could not be found or retrieved from secure storage.', 404);
    }

    return {
      buffer: fileBuffer,
      mimeType,
      filename,
      length: fileBuffer.length,
    };
  }

  /**
   * Saved Jobs: Save a job
   */
  static async saveJob(candidateId, jobId) {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, title: true, status: true, expiresAt: true, deletedAt: true },
    });

    if (!job || job.deletedAt !== null) {
      throw createHttpError('Job opening not found.', 404);
    }

    const savedJob = await prisma.savedJob.upsert({
      where: {
        candidateId_jobId: {
          candidateId,
          jobId,
        },
      },
      update: {
        expiresAt: job.expiresAt,
        savedAt: new Date(),
      },
      create: {
        candidateId,
        jobId,
        expiresAt: job.expiresAt,
      },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            status: true,
            expiresAt: true,
            city: true,
            country: true,
            workArrangements: true,
            hiringScopes: true,
            company: {
              select: { id: true, name: true, logoUrl: true },
            },
          },
        },
      },
    });

    return savedJob;
  }

  /**
   * Saved Jobs: Remove a saved job
   */
  static async removeSavedJob(candidateId, jobId) {
    try {
      await prisma.savedJob.delete({
        where: {
          candidateId_jobId: {
            candidateId,
            jobId,
          },
        },
      });
      return { success: true, message: 'Job removed from saved jobs.' };
    } catch {
      return { success: true, message: 'Job was not in saved jobs.' };
    }
  }

  /**
   * Saved Jobs: List saved jobs for candidate with expiration indicators
   */
  static async getSavedJobs(candidateId) {
    const now = new Date();
    const savedJobs = await prisma.savedJob.findMany({
      where: { candidateId },
      orderBy: { savedAt: 'desc' },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            status: true,
            expiresAt: true,
            city: true,
            country: true,
            workArrangement: true,
            workArrangements: true,
            employmentType: true,
            hiringScopes: true,
            minSalary: true,
            maxSalary: true,
            currency: true,
            company: {
              select: { id: true, name: true, logoUrl: true },
            },
          },
        },
      },
    });

    return savedJobs.map((item) => {
      const isExpired = Boolean(
        item.job.status === 'CLOSED' ||
        item.job.status === 'ARCHIVED' ||
        (item.job.expiresAt && new Date(item.job.expiresAt) <= now)
      );

      return {
        ...item,
        isExpired,
      };
    });
  }

  /**
   * Candidate Applications: List applications submitted by this candidate
   */
  static async getCandidateApplications(candidateId) {
    const applications = await prisma.jobApplication.findMany({
      where: { candidateId },
      orderBy: { appliedAt: 'desc' },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            status: true,
            city: true,
            country: true,
            workArrangements: true,
            company: {
              select: { id: true, name: true, logoUrl: true },
            },
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
    });

    return applications;
  }

  /**
   * Admin / Employer: List candidates with filtering, search, and pagination
   */
  static async listCandidates({
    page = 1,
    limit = 10,
    search,
    status,
    country,
    profession,
    minExperience,
    maxExperience,
    inTrash = false,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  }) {
    const skip = (page - 1) * limit;

    const where = {
      ...(inTrash ? { deletedAt: { not: null } } : { deletedAt: null }),
      ...(status ? { status } : {}),
      ...(country ? { country } : {}),
      ...(profession ? { profession: { contains: profession, mode: 'insensitive' } } : {}),
      ...(minExperience !== undefined || maxExperience !== undefined
        ? {
            yearsOfExperience: {
              ...(minExperience !== undefined ? { gte: minExperience } : {}),
              ...(maxExperience !== undefined ? { lte: maxExperience } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { currentJobTitle: { contains: search, mode: 'insensitive' } },
              { profession: { contains: search, mode: 'insensitive' } },
              { city: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy = { [sortBy]: sortOrder };

    const [total, items, activeCount, pendingCount, inactiveCount, suspendedCount, trashCount] = await Promise.all([
      prisma.candidate.count({ where }),
      prisma.candidate.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          email: true,
          firstName: true,
          middleName: true,
          lastName: true,
          fullName: true,
          phone: true,
          alternateMobile: true,
          status: true,
          country: true,
          city: true,
          profession: true,
          currentJobTitle: true,
          currentCompany: true,
          yearsOfExperience: true,
          profileCompletion: true,
          resumeUrl: true,
          resumeFileName: true,
          source: true,
          companyId: true,
          company: {
            select: { id: true, name: true, logoUrl: true },
          },
          invitationStatus: true,
          invitationSentAt: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
          _count: {
            select: { applications: true, savedJobs: true },
          },
        },
      }),
      prisma.candidate.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
      prisma.candidate.count({ where: { deletedAt: null, status: 'PENDING_APPROVAL' } }),
      prisma.candidate.count({ where: { deletedAt: null, status: 'INACTIVE' } }),
      prisma.candidate.count({ where: { deletedAt: null, status: 'SUSPENDED' } }),
      prisma.candidate.count({ where: { deletedAt: { not: null } } }),
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
      counts: {
        all: activeCount + pendingCount + inactiveCount + suspendedCount,
        active: activeCount,
        pending: pendingCount,
        inactive: inactiveCount,
        suspended: suspendedCount,
        trash: trashCount,
      },
    };
  }

  /**
   * Admin / Employer: Get Candidate 360° Profile by ID
   */
  static async getCandidateById(id, viewerContext = {}) {
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: {
        company: {
          select: { id: true, name: true, logoUrl: true },
        },
        applications: {
          include: {
            job: {
              select: {
                id: true,
                title: true,
                companyId: true,
                company: { select: { id: true, name: true, logoUrl: true } },
              },
            },
            currentStage: {
              select: { id: true, name: true, category: true, order: true },
            },
          },
          orderBy: { appliedAt: 'desc' },
        },
        _count: {
          select: { savedJobs: true },
        },
      },
    });

    if (!candidate) {
      throw createHttpError('Candidate not found.', 404);
    }

    const platformSettings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    const { passwordHash, passwordResetTokenHash, verificationTokenHash, invitationTokenHash, ...safeCandidate } = candidate;

    // Apply visibility policy (masks info for employers if configured)
    return enforceCandidateVisibility(safeCandidate, platformSettings, viewerContext);
  }

  /**
   * Admin / Employer: Create candidate with canonical deduplication check & secure invitation
   */
  static async createCandidateByAdminOrEmployer(data, actorContext = {}, file = null) {
    if (!file) {
      throw createHttpError('Resume document is required. Please upload a valid PDF, DOC, or DOCX resume (max 10MB).', 400);
    }

    // 1. Rigorous resume file validation (size, magic bytes signature, MIME & extension)
    if (file.size > 10 * 1024 * 1024) {
      throw createHttpError('Resume file exceeds maximum limit of 10 MB.', 400);
    }

    if (file.buffer) {
      const sig = inspectFileSignature(file.buffer);
      if (sig.isExecutable) {
        throw createHttpError('Binary content inspection detected an executable payload. Upload rejected.', 400);
      }
      if (
        file.originalname.toLowerCase().endsWith('.pdf') &&
        sig.detectedType !== 'application/pdf' &&
        sig.detectedType !== 'unknown'
      ) {
        throw createHttpError('File extension is .pdf but binary content signature is not a valid PDF document.', 400);
      }
    }

    const platformSettings = await prisma.platformSetting.findUnique({ where: { id: 'global' } });
    const resumeValidation = validateResumeFile(
      file.originalname,
      file.mimetype,
      platformSettings?.acceptedResumeFileTypes
    );
    if (!resumeValidation.valid) {
      throw createHttpError(resumeValidation.error, 400);
    }

    // 2. Upload resume to private document storage if configured
    let resumeUrl = '/api/candidates/me/resume';
    let resumePublicId = null;
    let resumeFileName = file.originalname;
    let resumeMimeType = file.mimetype;

    if (isCloudinaryConfigured()) {
      try {
        const uploaded = await uploadBuffer(file.buffer, {
          folder: CLOUDINARY_NAMESPACES.DOCUMENTS,
          isPrivate: true,
          resourceType: 'raw',
        });
        resumeUrl = uploaded.secureUrl;
        resumePublicId = uploaded.publicId;
      } catch (uploadErr) {
        logger.error({ error: uploadErr.message }, 'Failed to upload candidate resume to private storage');
        throw createHttpError(`Failed to securely store resume document: ${uploadErr.message}`, 500);
      }
    } else {
      const localFileName = await CandidateService.saveLocalResumeFile(file);
      resumePublicId = localFileName;
      resumeUrl = `/api/candidates/me/resume`;
    }

    // 3. Deduplication check by canonical email
    const canonicalEmail = data.email.trim().toLowerCase();
    const existingCandidate = await prisma.candidate.findUnique({
      where: { email: canonicalEmail },
      include: {
        company: { select: { id: true, name: true, logoUrl: true } },
      },
    });

    if (existingCandidate) {
      const alreadyHasPassword = Boolean(existingCandidate.passwordHash);

      // Existing candidate with active account - do not overwrite credentials or send unsolicited link
      if (alreadyHasPassword) {
        // If an asset was created in private storage, clean it up to prevent orphaned files
        if (resumePublicId) {
          if (isCloudinaryConfigured()) {
            await deleteCloudinaryAsset(resumePublicId, { isPrivate: true, resourceType: 'raw' }).catch(() => {});
          } else {
            const uploadDir = path.resolve(process.cwd(), 'uploads', 'resumes');
            fs.promises.unlink(path.join(uploadDir, path.basename(resumePublicId))).catch(() => {});
          }
        }
        const { passwordHash: _p, passwordResetTokenHash: _rt, verificationTokenHash: _vt, invitationTokenHash: _it, ...safeExisting } = existingCandidate;
        return {
          candidate: safeExisting,
          alreadyExists: true,
          alreadyActivated: true,
          invitationSent: false,
          invitationStatus: existingCandidate.invitationStatus || 'ACCEPTED',
          message: `A candidate with email "${canonicalEmail}" already exists and has an active account. Existing profile returned without altering credentials.`,
        };
      }

      // Existing candidate without active account - update profile details and offer activation
      const updatePayload = {};
      const fields = [
        'firstName', 'middleName', 'lastName', 'phone', 'alternateMobile',
        'dateOfBirth', 'gender', 'maritalStatus', 'nationality',
        'addressLine1', 'addressLine2', 'city', 'state', 'country', 'postalCode',
        'profession', 'employmentType', 'currentJobTitle', 'currentCompany',
        'yearsOfExperience', 'noticePeriodDays', 'currentSalary', 'expectedSalary',
        'preferredLocation', 'willingToRelocate', 'headline', 'summary', 'currentLocation',
        'passportNumber', 'passportExpiryDate', 'visaStatus', 'workPermitAuthorized',
        'linkedinUrl', 'portfolioUrl', 'githubUrl', 'companyId',
      ];

      for (const f of fields) {
        if (data[f] !== undefined && data[f] !== null) {
          if (f === 'dateOfBirth' || f === 'passportExpiryDate') {
            updatePayload[f] = data[f] ? new Date(data[f]) : null;
          } else if (f === 'companyId') {
            updatePayload[f] = data[f] ? data[f].trim() : null;
          } else {
            updatePayload[f] = data[f];
          }
        }
      }

      const fullName = this.deriveFullName(
        updatePayload.firstName || existingCandidate.firstName,
        updatePayload.middleName !== undefined ? updatePayload.middleName : existingCandidate.middleName,
        updatePayload.lastName || existingCandidate.lastName
      );
      updatePayload.fullName = fullName;

      // When existing candidate found: preserve existing resume and follow established rules; do not overwrite silently.
      if (!existingCandidate.resumeUrl) {
        updatePayload.resumeUrl = resumeUrl;
        updatePayload.resumePublicId = resumePublicId;
        updatePayload.resumeFileName = resumeFileName;
        updatePayload.resumeMimeType = resumeMimeType;
      } else {
        // Existing candidate already has a resume; do not overwrite silently, clean up newly uploaded file
        if (resumePublicId) {
          if (isCloudinaryConfigured()) {
            await deleteCloudinaryAsset(resumePublicId, { isPrivate: true, resourceType: 'raw' }).catch(() => {});
          } else {
            const uploadDir = path.resolve(process.cwd(), 'uploads', 'resumes');
            fs.promises.unlink(path.join(uploadDir, path.basename(resumePublicId))).catch(() => {});
          }
        }
      }

      const mergedCandidate = { ...existingCandidate, ...updatePayload };
      updatePayload.profileCompletion = this.computeProfileCompletion(mergedCandidate);

      const updatedCandidate = await prisma.candidate.update({
        where: { id: existingCandidate.id },
        data: updatePayload,
      });

      let inviteRes = null;
      if (data.sendInvitation !== false) {
        inviteRes = await this.sendCandidateInvitation(updatedCandidate.id, actorContext);
      }

      const finalRecord = await prisma.candidate.findUnique({
        where: { id: updatedCandidate.id },
        include: { company: { select: { id: true, name: true, logoUrl: true } } },
      });

      const { passwordHash: _p, passwordResetTokenHash: _rt, verificationTokenHash: _vt, invitationTokenHash: _it, ...safeCandidate } = finalRecord;

      BusinessEventNotificationService.notifyCandidateCreatedByAdmin({
        candidate: safeCandidate,
        actorAdminId: actorContext.adminId || actorContext.id,
      }).catch((err) => logger.warn(`[Candidates] Failed to send candidate created by admin notification: ${err.message}`));

      return {
        candidate: safeCandidate,
        alreadyExists: true,
        alreadyActivated: false,
        invitationSent: Boolean(inviteRes?.delivered),
        invitationStatus: inviteRes?.invitationStatus || updatedCandidate.invitationStatus || 'PENDING_RETRY',
        activationUrl: inviteRes?.activationUrl,
        message: inviteRes?.delivered
          ? `Existing candidate profile found with email "${canonicalEmail}". Account setup invitation dispatched.`
          : `Existing candidate profile found with email "${canonicalEmail}". Setup invitation could not be sent (pending retry).`,
      };
    }

    // 4. Validate company & enforce authorization
    let verifiedCompanyId = null;
    if (actorContext.isEmployer && actorContext.companyId) {
      if (data.companyId && data.companyId !== actorContext.companyId) {
        throw createHttpError('Employer users can only associate candidates with their own company.', 403);
      }
      verifiedCompanyId = actorContext.companyId;
    } else if (data.companyId && data.companyId.trim()) {
      const company = await prisma.company.findUnique({
        where: { id: data.companyId.trim() },
        select: { id: true, status: true, deletedAt: true },
      });
      if (!company || company.deletedAt !== null) {
        throw createHttpError('Selected company was not found or has been deactivated.', 400);
      }
      verifiedCompanyId = company.id;
    }

    // 5. Create new candidate
    const { sendInvitation, ...candidateFields } = data;
    const fullName = this.deriveFullName(data.firstName, data.middleName, data.lastName);
    const source = actorContext.isEmployer ? 'EMPLOYER' : (data.source || 'CAREER_PORTAL');

    const temp = {
      ...candidateFields,
      email: canonicalEmail,
      fullName,
      source,
      country: data.country || 'DE',
      status: data.status || 'ACTIVE',
      emailVerified: false,
      companyId: verifiedCompanyId,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
      passportExpiryDate: data.passportExpiryDate ? new Date(data.passportExpiryDate) : null,
      invitationStatus: 'NONE',
      resumeUrl,
      resumePublicId,
      resumeFileName,
      resumeMimeType,
    };

    const profileCompletion = this.computeProfileCompletion(temp);

    const candidate = await prisma.candidate.create({
      data: {
        ...temp,
        profileCompletion,
      },
      include: {
        company: { select: { id: true, name: true, logoUrl: true } },
      },
    });

    let inviteRes = null;
    if (sendInvitation !== false) {
      inviteRes = await this.sendCandidateInvitation(candidate.id, actorContext);
    }

    const refreshedCandidate = await prisma.candidate.findUnique({
      where: { id: candidate.id },
      include: { company: { select: { id: true, name: true, logoUrl: true } } },
    });

    const { passwordHash: _p, passwordResetTokenHash: _rt, verificationTokenHash: _vt, invitationTokenHash: _it, ...safeCandidate } = refreshedCandidate;

    BusinessEventNotificationService.notifyCandidateCreatedByAdmin({
      candidate: safeCandidate,
      actorAdminId: actorContext.adminId || actorContext.id,
    }).catch((err) => logger.warn(`[Candidates] Failed to send candidate created by admin notification: ${err.message}`));

    return {
      candidate: safeCandidate,
      alreadyExists: false,
      alreadyActivated: false,
      invitationSent: Boolean(inviteRes?.delivered),
      invitationStatus: inviteRes?.invitationStatus || 'NONE',
      activationUrl: inviteRes?.activationUrl,
      message: inviteRes?.delivered
        ? 'Candidate created and activation email sent successfully.'
        : (inviteRes?.invitationStatus === 'PENDING_RETRY'
            ? 'Candidate created successfully. Initial invitation email failed to deliver and is pending retry.'
            : 'Candidate profile created successfully in the shared talent pool.'),
    };
  }

  /**
   * Secure Candidate Account Setup: Send invitation email with single-use cryptographic token
   */
  static async sendCandidateInvitation(candidateId, actorContext = {}) {
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate || candidate.deletedAt !== null) {
      throw createHttpError('Candidate not found.', 404);
    }

    if (candidate.status === 'SUSPENDED') {
      throw createHttpError('Cannot dispatch invitation: candidate account is suspended.', 403);
    }

    if (candidate.passwordHash) {
      return {
        success: false,
        alreadyActivated: true,
        message: 'Candidate account is already activated. Unsolicited activation link cannot be dispatched.',
      };
    }

    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresHours = env.CANDIDATE_INVITATION_EXPIRES_HOURS || 48;
    const expiresAt = new Date(Date.now() + expiresHours * 3600 * 1000);
    const activationUrl = buildCandidateActivationUrl(rawToken);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        invitationTokenHash: tokenHash,
        invitationExpiresAt: expiresAt,
        invitationSentAt: new Date(),
      },
    });

    let delivered = false;
    let mailError = null;

    try {
      const mailRes = await sendCandidateAccountActivationEmail({
        to: candidate.email,
        recipientName: candidate.firstName || candidate.fullName,
        activationUrl,
        expiresHours,
      });

      delivered = Boolean(mailRes && mailRes.success && mailRes.delivered);
      if (!delivered) {
        mailError = mailRes?.error || 'Failed to deliver candidate activation email via SMTP.';
      }
    } catch (err) {
      logger.error({ error: err.message, candidateId: candidate.id }, 'Unexpected error dispatching candidate activation email');
      delivered = false;
      mailError = err.message;
    }

    const invitationStatus = delivered ? 'PENDING' : 'PENDING_RETRY';

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { invitationStatus },
    });

    return {
      success: true,
      delivered,
      invitationStatus,
      activationUrl,
      error: mailError,
    };
  }

  /**
   * Resend candidate account activation invitation
   */
  static async resendCandidateInvitation(candidateId, actorContext = {}) {
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate || candidate.deletedAt !== null) {
      throw createHttpError('Candidate not found.', 404);
    }

    if (candidate.passwordHash) {
      return {
        success: false,
        alreadyActivated: true,
        message: 'Candidate account is already activated. Unsolicited activation link cannot be dispatched.',
      };
    }

    // Cooldown rate-limit: 60 seconds
    if (candidate.invitationSentAt) {
      const elapsedSeconds = (Date.now() - new Date(candidate.invitationSentAt).getTime()) / 1000;
      if (elapsedSeconds < 60) {
        const remaining = Math.ceil(60 - elapsedSeconds);
        throw createHttpError(`An invitation was recently sent. Please wait ${remaining} second(s) before requesting a resend.`, 429);
      }
    }

    return this.sendCandidateInvitation(candidateId, actorContext);
  }

  /**
   * Candidate App: Verify invitation token
   */
  static async verifyInvitationToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string' || !rawToken.trim()) {
      const error = createHttpError('Invitation token is required.', 400);
      error.code = 'TOKEN_REQUIRED';
      throw error;
    }

    const tokenHash = hashToken(rawToken.trim());
    const candidate = await prisma.candidate.findFirst({
      where: {
        invitationTokenHash: tokenHash,
        deletedAt: null,
      },
      include: {
        company: { select: { id: true, name: true, logoUrl: true } },
      },
    });

    if (!candidate) {
      const error = createHttpError('Invalid or expired invitation token.', 400);
      error.code = 'INVITATION_INVALID';
      throw error;
    }

    if (candidate.status === 'SUSPENDED') {
      const error = createHttpError('Your candidate account has been suspended. Please contact platform support.', 403);
      error.code = 'CANDIDATE_SUSPENDED';
      throw error;
    }

    if (candidate.passwordHash || candidate.invitationStatus === 'ACCEPTED') {
      const error = createHttpError('This invitation has already been accepted and can only be used once.', 400);
      error.code = 'INVITATION_ALREADY_ACCEPTED';
      throw error;
    }

    if (candidate.invitationExpiresAt && new Date() > new Date(candidate.invitationExpiresAt)) {
      const error = createHttpError('This invitation has expired. Please contact your platform administrator or request a new invitation.', 400);
      error.code = 'INVITATION_EXPIRED';
      throw error;
    }

    return {
      valid: true,
      candidateId: candidate.id,
      email: candidate.email,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      fullName: candidate.fullName,
      company: candidate.company,
      expiresAt: candidate.invitationExpiresAt,
    };
  }

  /**
   * Candidate App: Activate invitation and set password
   */
  static async activateInvitation({ token, password, firstName, lastName }) {
    const verification = await this.verifyInvitationToken(token);

    if (!password || password.length < 8) {
      throw createHttpError('Password must be at least 8 characters long.', 400);
    }

    const candidate = await prisma.candidate.findUnique({
      where: { id: verification.candidateId },
    });

    const passwordHash = await hashPassword(password);
    const finalFirstName = firstName?.trim() || candidate.firstName;
    const finalLastName = lastName?.trim() || candidate.lastName;
    const fullName = this.deriveFullName(finalFirstName, candidate.middleName, finalLastName);

    const merged = {
      ...candidate,
      firstName: finalFirstName,
      lastName: finalLastName,
      fullName,
      passwordHash,
      emailVerified: true,
      invitationTokenHash: null,
      invitationExpiresAt: null,
      invitationStatus: 'ACCEPTED',
      failedLoginAttempts: 0,
      lockedUntil: null,
      status: candidate.status === 'PENDING_APPROVAL' ? 'ACTIVE' : candidate.status,
    };

    const profileCompletion = this.computeProfileCompletion(merged);

    const updated = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        passwordHash,
        emailVerified: true,
        invitationTokenHash: null,
        invitationExpiresAt: null,
        invitationStatus: 'ACCEPTED',
        failedLoginAttempts: 0,
        lockedUntil: null,
        firstName: finalFirstName,
        lastName: finalLastName,
        fullName,
        profileCompletion,
        status: candidate.status === 'PENDING_APPROVAL' ? 'ACTIVE' : candidate.status,
      },
    });

    const { passwordHash: _p, passwordResetTokenHash: _rt, verificationTokenHash: _vt, invitationTokenHash: _it, ...safeCandidate } = updated;

    return {
      success: true,
      message: 'Account successfully activated! You may now sign in to the candidate portal with your email and chosen password.',
      candidate: safeCandidate,
    };
  }

  /**
   * Admin: Upload resume for candidate
   */
  static async uploadResumeByAdmin(candidateId, file, actorContext = {}) {
    return this.uploadResume(candidateId, file);
  }

  /**
   * Admin: Update candidate status
   */
  static async updateCandidateStatus(id, status, actorAdminId = null) {
    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate || candidate.deletedAt !== null) {
      throw createHttpError('Candidate not found.', 404);
    }

    const updated = await prisma.candidate.update({
      where: { id },
      data: { status },
    });

    const { passwordHash, passwordResetTokenHash, verificationTokenHash, invitationTokenHash, ...safeCandidate } = updated;

    BusinessEventNotificationService.notifyCandidateStatusChanged({
      candidate: safeCandidate,
      status,
      previousStatus: candidate.status,
      actorAdminId,
    }).catch((err) => logger.warn(`[Candidates] Failed to send candidate status notification: ${err.message}`));

    return safeCandidate;
  }

  /**
   * Admin: Soft delete or permanently delete candidate
   */
  static async deleteCandidate(id, mode = 'MOVE_TO_TRASH') {
    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate) {
      throw createHttpError('Candidate not found.', 404);
    }

    if (mode === 'DELETE_PERMANENTLY') {
      await prisma.candidate.delete({ where: { id } });
      return { success: true, message: 'Candidate permanently deleted from database.' };
    }

    // Default: Soft delete
    await prisma.candidate.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });

    return { success: true, message: 'Candidate moved to trash.' };
  }

  /**
   * Admin: Restore soft-deleted candidate
   */
  static async restoreCandidate(id) {
    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate) {
      throw createHttpError('Candidate not found.', 404);
    }

    const updated = await prisma.candidate.update({
      where: { id },
      data: { deletedAt: null, status: 'ACTIVE' },
    });

    const { passwordHash, passwordResetTokenHash, verificationTokenHash, invitationTokenHash, ...safeCandidate } = updated;
    return safeCandidate;
  }
}
