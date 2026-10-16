import { CompanyService } from './company.service.js';
import { prisma } from '../../lib/prisma.js';
import { getCloudinaryStatus, generateUploadSignature } from '../../lib/cloudinary.js';
import { getMailStatus } from '../../lib/mailer.js';
import { logger } from '../../lib/logger.js';

export class CompanyController {
  /**
   * GET /api/companies
   */
  static async listCompanies(req, res, next) {
    try {
      const result = await CompanyService.listCompanies(req.query);
      return res.json({
        success: true,
        data: result.items,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/companies/status-summary
   */
  static async getStatusSummary(req, res, next) {
    try {
      const counts = await prisma.company.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { id: true },
      });

      const summary = {
        ALL: 0,
        IN_REVIEW: 0,
        UNVERIFIED: 0,
        ACTIVE: 0,
        INACTIVE: 0,
        SUSPENDED: 0,
      };

      for (const item of counts) {
        summary[item.status] = item._count.id;
        summary.ALL += item._count.id;
      }

      return res.json({
        success: true,
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/companies/integrations-status
   */
  static async getIntegrationsStatus(req, res, next) {
    try {
      const cloudinary = getCloudinaryStatus();
      const mail = getMailStatus();

      return res.json({
        success: true,
        data: {
          cloudinary,
          mail,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies/upload-signature
   */
  static async getUploadSignature(req, res, next) {
    try {
      const { folder, resourceType, isPrivate } = req.body;
      const signatureData = generateUploadSignature({ folder, resourceType, isPrivate });
      return res.json({
        success: true,
        data: signatureData,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/companies/:id
   */
  static async getCompanyById(req, res, next) {
    try {
      const company = await CompanyService.getCompanyById(req.params.id);
      return res.json({
        success: true,
        data: company,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies
   */
  static async createCompany(req, res, next) {
    try {
      const result = await CompanyService.createCompany(req.body, req.admin);
      const message = result.invitationSent
        ? 'Company created and invitation email sent successfully'
        : (result.invitationStatus === 'PENDING_RETRY'
            ? 'Company created successfully. Initial invitation email failed to deliver and is pending retry.'
            : 'Company created successfully');

      return res.status(201).json({
        success: true,
        message,
        data: result.company,
        invitationSent: result.invitationSent,
        invitationStatus: result.invitationStatus,
        invitationError: result.invitationError,
        invitation: result.invitation,
        activationUrl: result.activationUrl,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/companies/:id
   * PATCH /api/companies/:id
   */
  static async updateCompany(req, res, next) {
    try {
      const updated = await CompanyService.updateCompany(req.params.id, req.body, req.admin);
      return res.json({
        success: true,
        message: 'Company details updated successfully',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/companies/:id
   */
  static async deleteCompany(req, res, next) {
    try {
      const mode = req.query.mode || 'MOVE_TO_TRASH';
      const result = await CompanyService.deleteCompany(req.params.id, mode, req.admin);
      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies/:id/restore
   */
  static async restoreCompany(req, res, next) {
    try {
      const result = await CompanyService.restoreCompany(req.params.id, req.admin);
      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/companies/:id/status
   */
  static async updateCompanyStatus(req, res, next) {
    try {
      const updated = await CompanyService.updateCompanyStatus(req.params.id, req.body, req.admin);
      return res.json({
        success: true,
        message: `Company status changed to ${updated.status}`,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies/:id/review
   */
  static async reviewCompany(req, res, next) {
    try {
      const updated = await CompanyService.reviewCompany(req.params.id, req.body, req.admin);
      return res.json({
        success: true,
        message: `Company application ${req.body.decision === 'APPROVE' ? 'approved' : 'rejected'} successfully`,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies/:id/documents
   */
  static async addCompanyDocument(req, res, next) {
    try {
      const doc = await CompanyService.addCompanyDocument(req.params.id, req.body, req.admin);
      return res.status(201).json({
        success: true,
        message: 'Document uploaded successfully',
        data: doc,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/companies/:id/documents/:documentId/review
   */
  static async reviewCompanyDocument(req, res, next) {
    try {
      const doc = await CompanyService.reviewCompanyDocument(
        req.params.id,
        req.params.documentId,
        req.body,
        req.admin
      );
      return res.json({
        success: true,
        message: `Document ${req.body.decision === 'APPROVE' ? 'approved' : 'rejected'} successfully`,
        data: doc,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/companies/:id/documents/:documentId
   */
  static async deleteCompanyDocument(req, res, next) {
    try {
      await CompanyService.deleteCompanyDocument(req.params.id, req.params.documentId, req.admin);
      return res.json({
        success: true,
        message: 'Document deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/companies/:id/documents/:documentId/file
   * Streams verified document binary with strict authorization, PDF magic number inspection, and headers
   */
  static async streamCompanyDocument(req, res, next) {
    try {
      const disposition = req.query.disposition === 'attachment' ? 'attachment' : 'inline';
      const fileData = await CompanyService.streamCompanyDocument(
        req.params.id,
        req.params.documentId,
        req.admin
      );

      res.setHeader('Content-Type', fileData.mimeType);
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${encodeURIComponent(fileData.filename)}"`
      );
      res.setHeader('Content-Length', fileData.length);
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

      return res.send(fileData.buffer);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/companies/:id/documents/:documentId/download
   */
  static async getDocumentDownloadUrl(req, res, next) {
    try {
      if (req.query.stream === 'true' || req.headers.accept === 'application/pdf') {
        return CompanyController.streamCompanyDocument(req, res, next);
      }
      const result = await CompanyService.getPrivateDocumentSignedUrl(
        req.params.id,
        req.params.documentId,
        req.admin
      );
      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies/:id/invitations
   */
  static async sendCompanyInvitation(req, res, next) {
    try {
      const result = await CompanyService.sendCompanyInvitation(req.params.id, req.body, req.admin);
      return res.status(201).json({
        success: true,
        message: result.delivered
          ? 'Invitation email sent successfully'
          : 'Invitation generated successfully (email service unconfigured)',
        data: result.invitation,
        delivered: result.delivered,
        activationUrl: result.activationUrl,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies/:id/invitations/:invitationId/resend
   */
  static async resendCompanyInvitation(req, res, next) {
    try {
      const result = await CompanyService.resendCompanyInvitation(
        req.params.id,
        req.params.invitationId,
        req.admin
      );
      return res.json({
        success: true,
        message: result.delivered
          ? 'Invitation email resent successfully'
          : 'Invitation token regenerated (email service unconfigured or failed)',
        data: result.invitation,
        delivered: result.delivered,
        activationUrl: result.activationUrl,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies/upload
   * POST /api/companies/:id/documents/upload
   */
  static async uploadAsset(req, res, next) {
    try {
      const companyId = req.params.id || req.body.companyId || null;
      const { type, documentDefinitionId, name, isPrivate } = req.body;
      const file = req.file;

      const result = await CompanyService.uploadCompanyAsset(
        {
          file,
          type,
          companyId,
          documentDefinitionId,
          name,
          isPrivate,
        },
        req.admin
      );

      return res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/companies/invitations/verify
   */
  static async verifyInvitation(req, res, next) {
    try {
      const { token } = req.query;
      const result = await CompanyService.verifyInvitationToken(token);
      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/companies/invitations/activate
   */
  static async activateInvitation(req, res, next) {
    try {
      const result = await CompanyService.activateInvitation(req.body);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
