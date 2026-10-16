import { Router } from 'express';
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
  listCompanyJobsSchema,
  listPublicJobsSchema,
  applyJobSchema,
} from './job.validation.js';

import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max resume buffer
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

router.post(
  '/',
  validate(createJobSchema),
  JobController.createJob
);

router.get(
  '/company/:companyId',
  validate(listCompanyJobsSchema),
  JobController.listCompanyJobs
);

router.get(
  '/:id',
  validate(getJobByIdSchema),
  JobController.getJobById
);

router.put(
  '/:id',
  validate(updateJobSchema),
  JobController.updateJob
);

router.delete(
  '/:id',
  validate(getJobByIdSchema),
  JobController.deleteJob
);

export default router;
