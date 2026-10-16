import { Router } from 'express';
import multer from 'multer';
import { JobController } from './job.controller.js';
import {
  authenticateSession,
  require2FAVerified,
} from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  createJobSchema,
  updateJobSchema,
  getJobByIdSchema,
  listAdminJobsSchema,
  listCompanyJobsSchema,
  listPublicJobsSchema,
  applyJobSchema,
  getJobApplicantsSchema,
  updateJobStatusSchema,
  deleteJobSchema,
  restoreJobSchema,
} from './job.validation.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max buffer
  },
});

const txtUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1 * 1024 * 1024, // 1MB max for .txt files
  },
});

const router = Router();

// ----------------------------------------------------
// Public Candidate Discovery & Applications (Unauthenticated)
// ----------------------------------------------------
router.get(
  '/public',
  validate(listPublicJobsSchema),
  JobController.listPublicJobs
);

router.get(
  '/public/:id',
  validate(getJobByIdSchema),
  JobController.getPublicJobById
);

router.post(
  '/public/:id/apply',
  upload.single('resume'),
  (req, res, next) => {
    if (req.file) {
      req.body.resumeFileName = req.file.originalname;
      req.body.resumeMimeType = req.file.mimetype;
      req.body.resumeBuffer = req.file.buffer;
      req.body.resumeSize = req.file.size;
    }
    next();
  },
  validate(applyJobSchema),
  JobController.applyForJob
);

// ----------------------------------------------------
// Protected Management Routes (Admin & Session Authenticated)
// ----------------------------------------------------
router.use(authenticateSession);
router.use(require2FAVerified);

// Admin Job Directory
router.get(
  '/',
  validate(listAdminJobsSchema),
  JobController.listAdminJobs
);

// Create Job
router.post(
  '/',
  validate(createJobSchema),
  JobController.createJob
);

// Upload .txt file to parse description
router.post(
  '/parse-description-file',
  txtUpload.single('file'),
  JobController.parseDescriptionFile
);

// List company jobs
router.get(
  '/company/:companyId',
  validate(listCompanyJobsSchema),
  JobController.listCompanyJobs
);

// Single job details
router.get(
  '/:id',
  validate(getJobByIdSchema),
  JobController.getJobById
);

// Job applicants
router.get(
  '/:id/applicants',
  validate(getJobApplicantsSchema),
  JobController.getJobApplicants
);

// Update job
router.put(
  '/:id',
  validate(updateJobSchema),
  JobController.updateJob
);

// Update job status (suspend, inactive, resume, etc.)
router.patch(
  '/:id/status',
  validate(updateJobStatusSchema),
  JobController.updateJobStatus
);

// Delete job (move to trash or permanently delete)
router.delete(
  '/:id',
  validate(deleteJobSchema),
  JobController.deleteJob
);

// Restore job from trash
router.post(
  '/:id/restore',
  validate(restoreJobSchema),
  JobController.restoreJob
);

export default router;
