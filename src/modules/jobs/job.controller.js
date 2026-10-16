import { JobService } from './job.service.js';

export class JobController {
  /**
   * GET /api/jobs (Admin directory)
   */
  static async listAdminJobs(req, res, next) {
    try {
      const result = await JobService.listAdminJobs(req.query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async createJob(req, res, next) {
    try {
      const actorContext = {
        adminId: req.admin?.id,
        role: req.admin?.role,
      };
      const job = await JobService.createJob(req.body, actorContext);
      return res.status(201).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getJobById(req, res, next) {
    try {
      const job = await JobService.getJobById(req.params.id);
      return res.status(200).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getJobApplicants(req, res, next) {
    try {
      const result = await JobService.getJobApplicants(req.params.id, req.query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateJob(req, res, next) {
    try {
      const actorContext = {
        adminId: req.admin?.id,
        role: req.admin?.role,
      };
      const job = await JobService.updateJob(req.params.id, req.body, actorContext);
      return res.status(200).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateJobStatus(req, res, next) {
    try {
      const actorContext = {
        adminId: req.admin?.id,
        role: req.admin?.role,
      };
      const job = await JobService.updateJobStatus(req.params.id, req.body, actorContext);
      return res.status(200).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  static async parseDescriptionFile(req, res, next) {
    try {
      const result = JobService.parseDescriptionFile(req.file);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async deleteJob(req, res, next) {
    try {
      const result = await JobService.deleteJob(req.params.id);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async listCompanyJobs(req, res, next) {
    try {
      const result = await JobService.listCompanyJobs(req.params.companyId, req.query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async listPublicJobs(req, res, next) {
    try {
      const result = await JobService.listPublicJobs(req.query);
      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getPublicJobById(req, res, next) {
    try {
      const job = await JobService.getPublicJobById(req.params.id);
      return res.status(200).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  static async applyForJob(req, res, next) {
    try {
      const result = await JobService.applyForJob(req.params.id, req.body);
      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
}
