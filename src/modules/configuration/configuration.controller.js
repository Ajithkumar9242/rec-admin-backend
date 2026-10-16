import { ConfigurationService } from './configuration.service.js';

export class ConfigurationController {
  // ==========================================
  // Industry Controllers
  // ==========================================

  static async getIndustries(req, res, next) {
    try {
      const result = await ConfigurationService.getIndustries(req.query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getIndustryById(req, res, next) {
    try {
      const industry = await ConfigurationService.getIndustryById(req.params.id);
      return res.status(200).json({
        success: true,
        data: industry,
      });
    } catch (error) {
      next(error);
    }
  }

  static async createIndustry(req, res, next) {
    try {
      const industry = await ConfigurationService.createIndustry(req.body, req.admin);
      return res.status(201).json({
        success: true,
        message: 'Industry successfully created.',
        data: industry,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateIndustry(req, res, next) {
    try {
      const industry = await ConfigurationService.updateIndustry(req.params.id, req.body, req.admin);
      return res.status(200).json({
        success: true,
        message: 'Industry successfully updated.',
        data: industry,
      });
    } catch (error) {
      next(error);
    }
  }

  static async toggleIndustryStatus(req, res, next) {
    try {
      const industry = await ConfigurationService.toggleIndustryStatus(
        req.params.id,
        req.body.status,
        req.admin
      );
      return res.status(200).json({
        success: true,
        message: `Industry status set to ${req.body.status}.`,
        data: industry,
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteIndustry(req, res, next) {
    try {
      const mode = req.query.mode || 'MOVE_TO_TRASH';
      const result = await ConfigurationService.deleteIndustry(req.params.id, mode, req.admin);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  // ==========================================
  // Document Definition Controllers
  // ==========================================

  static async getDocumentDefinitions(req, res, next) {
    try {
      const result = await ConfigurationService.getDocumentDefinitions(req.query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getDocumentDefinitionById(req, res, next) {
    try {
      const docDef = await ConfigurationService.getDocumentDefinitionById(req.params.id);
      return res.status(200).json({
        success: true,
        data: docDef,
      });
    } catch (error) {
      next(error);
    }
  }

  static async createDocumentDefinition(req, res, next) {
    try {
      const docDef = await ConfigurationService.createDocumentDefinition(req.body, req.admin);
      return res.status(201).json({
        success: true,
        message: `${req.body.targetType === 'COMPANY' ? 'Company' : 'Candidate'} document definition created.`,
        data: docDef,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateDocumentDefinition(req, res, next) {
    try {
      const docDef = await ConfigurationService.updateDocumentDefinition(
        req.params.id,
        req.body,
        req.admin
      );
      return res.status(200).json({
        success: true,
        message: 'Document definition successfully updated.',
        data: docDef,
      });
    } catch (error) {
      next(error);
    }
  }

  static async toggleDocumentDefinitionStatus(req, res, next) {
    try {
      const docDef = await ConfigurationService.toggleDocumentDefinitionStatus(
        req.params.id,
        req.body.status,
        req.admin
      );
      return res.status(200).json({
        success: true,
        message: `Document definition status set to ${req.body.status}.`,
        data: docDef,
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteDocumentDefinition(req, res, next) {
    try {
      const mode = req.query.mode || 'MOVE_TO_TRASH';
      const result = await ConfigurationService.deleteDocumentDefinition(
        req.params.id,
        mode,
        req.admin
      );
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  // ==========================================
  // Recruitment Stages Controllers
  // ==========================================

  static async getRecruitmentStages(req, res, next) {
    try {
      const result = await ConfigurationService.getRecruitmentStages(req.query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getRecruitmentStageById(req, res, next) {
    try {
      const stage = await ConfigurationService.getRecruitmentStageById(req.params.id);
      return res.status(200).json({
        success: true,
        data: stage,
      });
    } catch (error) {
      next(error);
    }
  }

  static async createRecruitmentStage(req, res, next) {
    try {
      const stage = await ConfigurationService.createRecruitmentStage(req.body, req.admin);
      return res.status(201).json({
        success: true,
        message: 'Recruitment stage created.',
        data: stage,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateRecruitmentStage(req, res, next) {
    try {
      const stage = await ConfigurationService.updateRecruitmentStage(
        req.params.id,
        req.body,
        req.admin
      );
      return res.status(200).json({
        success: true,
        message: 'Recruitment stage updated.',
        data: stage,
      });
    } catch (error) {
      next(error);
    }
  }

  static async reorderRecruitmentStages(req, res, next) {
    try {
      const stages = await ConfigurationService.reorderRecruitmentStages(
        req.body.stages,
        req.admin
      );
      return res.status(200).json({
        success: true,
        message: 'Recruitment stages order persisted.',
        data: stages,
      });
    } catch (error) {
      next(error);
    }
  }

  static async toggleRecruitmentStageStatus(req, res, next) {
    try {
      const stage = await ConfigurationService.toggleRecruitmentStageStatus(
        req.params.id,
        req.body.status,
        req.admin
      );
      return res.status(200).json({
        success: true,
        message: `Stage status set to ${req.body.status}.`,
        data: stage,
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteRecruitmentStage(req, res, next) {
    try {
      const mode = req.query.mode || 'MOVE_TO_TRASH';
      const result = await ConfigurationService.deleteRecruitmentStage(
        req.params.id,
        mode,
        req.admin
      );
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  // ==========================================
  // Platform Settings Controllers
  // ==========================================

  static async getPlatformSettings(req, res, next) {
    try {
      const settings = await ConfigurationService.getPlatformSettings();
      return res.status(200).json({
        success: true,
        data: settings,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateCandidateSettings(req, res, next) {
    try {
      const settings = await ConfigurationService.updateCandidateSettings(req.body, req.admin);
      return res.status(200).json({
        success: true,
        message: 'Candidate configuration successfully updated.',
        data: settings,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateEmployerVisibility(req, res, next) {
    try {
      const settings = await ConfigurationService.updateEmployerVisibility(req.body, req.admin);
      return res.status(200).json({
        success: true,
        message: 'Employer visibility configuration successfully updated.',
        data: settings,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateJobSettings(req, res, next) {
    try {
      const settings = await ConfigurationService.updateJobSettings(req.body, req.admin);
      return res.status(200).json({
        success: true,
        message: 'Job approval configuration successfully updated.',
        data: settings,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getAuditLogs(req, res, next) {
    try {
      const result = await ConfigurationService.getAuditLogs(req.query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }
}
