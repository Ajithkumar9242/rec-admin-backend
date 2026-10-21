import { CandidateService } from './candidate.service.js';
import { ResumeParserService } from './resumeParser.service.js';
import { inspectFileSignature } from '../../lib/fileValidation.js';
import { validateResumeFile } from '../configuration/candidateVisibilityPolicy.js';

export class CandidateController {
  // ----------------------------------------------------
  // Candidate Self-Service Authentication
  // ----------------------------------------------------

  static async register(req, res, next) {
    try {
      const candidate = await CandidateService.register(req.body);
      if (req.session) {
        req.session.candidateId = candidate.id;
      }
      res.status(201).json({
        success: true,
        data: candidate,
        message: 'Registration successful.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async login(req, res, next) {
    try {
      const candidate = await CandidateService.login(req.body);
      if (req.session) {
        req.session.candidateId = candidate.id;
      }
      res.status(200).json({
        success: true,
        data: candidate,
        message: 'Signed in successfully.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async logout(req, res, next) {
    try {
      if (req.session) {
        delete req.session.candidateId;
      }
      res.status(200).json({
        success: true,
        message: 'Logged out successfully.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async forgotPassword(req, res, next) {
    try {
      const result = await CandidateService.forgotPassword(req.body.email);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async resetPassword(req, res, next) {
    try {
      const result = await CandidateService.resetPassword(req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  // ----------------------------------------------------
  // Candidate Self Profile & Documents
  // ----------------------------------------------------

  static async getMe(req, res, next) {
    try {
      const profile = await CandidateService.getCandidateProfile(req.candidate.id);
      res.status(200).json({
        success: true,
        data: profile,
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateMe(req, res, next) {
    try {
      const profile = await CandidateService.updateCandidateProfile(req.candidate.id, req.body);
      res.status(200).json({
        success: true,
        data: profile,
        message: 'Profile updated successfully.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async uploadResume(req, res, next) {
    try {
      const profile = await CandidateService.uploadResume(req.candidate.id, req.file);
      res.status(200).json({
        success: true,
        data: profile,
        message: 'Resume uploaded and verified successfully.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async getMyResume(req, res, next) {
    try {
      const disposition = req.query.disposition === 'attachment' ? 'attachment' : 'inline';
      const actorContext = {
        isCandidate: true,
        candidateId: req.candidate.id,
      };
      const { buffer, mimeType, filename, length } = await CandidateService.streamCandidateResume(
        req.candidate.id,
        disposition,
        actorContext
      );

      res.setHeader('Content-Type', mimeType);
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${encodeURIComponent(filename)}"`
      );
      res.setHeader('Content-Length', length);
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      return res.status(200).send(buffer);
    } catch (err) {
      next(err);
    }
  }

  static async getSavedJobs(req, res, next) {
    try {
      const savedJobs = await CandidateService.getSavedJobs(req.candidate.id);
      res.status(200).json({
        success: true,
        data: savedJobs,
      });
    } catch (err) {
      next(err);
    }
  }

  static async saveJob(req, res, next) {
    try {
      const saved = await CandidateService.saveJob(req.candidate.id, req.params.jobId);
      res.status(200).json({
        success: true,
        data: saved,
        message: 'Job opening saved successfully.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async removeSavedJob(req, res, next) {
    try {
      const result = await CandidateService.removeSavedJob(req.candidate.id, req.params.jobId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getMyApplications(req, res, next) {
    try {
      const applications = await CandidateService.getCandidateApplications(req.candidate.id);
      res.status(200).json({
        success: true,
        data: applications,
      });
    } catch (err) {
      next(err);
    }
  }

  // ----------------------------------------------------
  // Admin & Employer Candidate Management
  // ----------------------------------------------------

  static async listCandidates(req, res, next) {
    try {
      const result = await CandidateService.listCandidates(req.query);
      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getCandidateById(req, res, next) {
    try {
      const viewerContext = {
        role: req.admin?.role || 'SUPER_ADMIN',
      };
      const candidate = await CandidateService.getCandidateById(req.params.id, viewerContext);
      res.status(200).json({
        success: true,
        data: candidate,
      });
    } catch (err) {
      next(err);
    }
  }

  static async createCandidate(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'Resume document is required. Please upload a valid PDF, DOC, or DOCX resume (max 10MB).',
        });
      }

      const actorContext = {
        isEmployer: Boolean(req.isEmployer || req.companyUser),
        adminId: req.admin?.id,
        companyId: req.companyUser?.companyId,
      };
      const result = await CandidateService.createCandidateByAdminOrEmployer(req.body, actorContext, req.file);
      res.status(result.alreadyExists ? 200 : 201).json({
        success: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async parseResume(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'Resume file is required for parsing.',
        });
      }

      if (req.file.size > 10 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          error: 'Resume file exceeds maximum limit of 10 MB.',
        });
      }

      if (req.file.buffer) {
        const sig = inspectFileSignature(req.file.buffer);
        if (sig.isExecutable) {
          return res.status(400).json({
            success: false,
            error: 'Binary content inspection detected an executable payload. Upload rejected.',
          });
        }
      }

      const resumeValidation = validateResumeFile(
        req.file.originalname,
        req.file.mimetype,
        ['application/pdf', '.pdf', 'application/msword', '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx']
      );

      if (!resumeValidation.valid) {
        return res.status(400).json({
          success: false,
          error: resumeValidation.error,
        });
      }

      const result = await ResumeParserService.parseResume(req.file);
      return res.status(200).json({
        success: true,
        parseSuccess: result.parseSuccess,
        extracted: result.extracted,
        suggestions: result.extracted,
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  }

  static async verifyInvitation(req, res, next) {
    try {
      const result = await CandidateService.verifyInvitationToken(req.query.token);
      res.status(200).json({
        success: true,
        valid: Boolean(result.valid),
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async activateInvitation(req, res, next) {
    try {
      const result = await CandidateService.activateInvitation(req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async resendInvitation(req, res, next) {
    try {
      const result = await CandidateService.resendCandidateInvitation(req.params.id, {
        adminId: req.admin?.id,
      });
      res.status(200).json({
        success: true,
        message: result.delivered
          ? 'Candidate account activation invitation resent successfully.'
          : (result.alreadyActivated
              ? result.message
              : 'Failed to deliver invitation email via SMTP. Invitation marked as PENDING_RETRY.'),
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async uploadResumeByAdmin(req, res, next) {
    try {
      const profile = await CandidateService.uploadResumeByAdmin(req.params.id, req.file, {
        adminId: req.admin?.id,
      });
      res.status(200).json({
        success: true,
        data: profile,
        message: 'Resume uploaded and verified successfully.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async getResume(req, res, next) {
    try {
      const disposition = req.query.disposition === 'attachment' ? 'attachment' : 'inline';
      const actorContext = {
        isAdmin: Boolean(req.admin),
        adminId: req.admin?.id,
        isEmployer: Boolean(req.isEmployer || req.companyUser),
        companyId: req.companyUser?.companyId,
      };
      const { buffer, mimeType, filename, length } = await CandidateService.streamCandidateResume(
        req.params.id,
        disposition,
        actorContext
      );

      res.setHeader('Content-Type', mimeType);
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${encodeURIComponent(filename)}"`
      );
      res.setHeader('Content-Length', length);
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      return res.status(200).send(buffer);
    } catch (err) {
      next(err);
    }
  }

  static async updateCandidate(req, res, next) {
    try {
      const actorContext = {
        isAdmin: Boolean(req.admin),
        adminId: req.admin?.id,
        isEmployer: Boolean(req.isEmployer || req.companyUser),
        companyId: req.companyUser?.companyId,
      };
      const candidate = await CandidateService.updateCandidateProfile(req.params.id, req.body, actorContext);
      res.status(200).json({
        success: true,
        data: candidate,
        message: 'Candidate updated successfully.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateCandidateStatus(req, res, next) {
    try {
      const candidate = await CandidateService.updateCandidateStatus(req.params.id, req.body.status, req.admin?.id);
      res.status(200).json({
        success: true,
        data: candidate,
        message: `Candidate status updated to ${candidate.status}.`,
      });
    } catch (err) {
      next(err);
    }
  }

  static async deleteCandidate(req, res, next) {
    try {
      const result = await CandidateService.deleteCandidate(req.params.id, req.query.mode);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async restoreCandidate(req, res, next) {
    try {
      const candidate = await CandidateService.restoreCandidate(req.params.id);
      res.status(200).json({
        success: true,
        data: candidate,
        message: 'Candidate restored successfully from trash.',
      });
    } catch (err) {
      next(err);
    }
  }
}
