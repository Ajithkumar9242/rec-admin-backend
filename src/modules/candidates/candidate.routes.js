import { Router } from 'express';
import multer from 'multer';
import { CandidateController } from './candidate.controller.js';
import {
  candidateRegisterSchema,
  candidateLoginSchema,
  candidateForgotPasswordSchema,
  candidateResetPasswordSchema,
  updateCandidateProfileSchema,
  adminCreateCandidateSchema,
  adminUpdateCandidateStatusSchema,
  listCandidatesSchema,
  candidateIdParamSchema,
  jobIdParamSchema,
  candidateVerifyInvitationSchema,
  candidateActivateInvitationSchema,
} from './candidate.validation.js';
import { authenticateCandidate } from './candidateAuth.middleware.js';
import { authenticateSession, require2FAVerified } from '../../middleware/auth.js';
import { invitationLimiter } from '../../middleware/rateLimiter.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

function validate(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      if (parsed.body) req.body = parsed.body;
      if (parsed.query) req.query = parsed.query;
      if (parsed.params) req.params = parsed.params;
      next();
    } catch (err) {
      if (err.errors) {
        return res.status(400).json({
          success: false,
          error: err.errors[0]?.message || 'Validation error',
          details: err.errors,
        });
      }
      next(err);
    }
  };
}

const router = Router();

// ====================================================
// 1. Candidate Self-Service & Invitations (Public)
// ====================================================
router.post('/register', validate(candidateRegisterSchema), CandidateController.register);
router.post('/login', validate(candidateLoginSchema), CandidateController.login);
router.post('/forgot-password', validate(candidateForgotPasswordSchema), CandidateController.forgotPassword);
router.post('/reset-password', validate(candidateResetPasswordSchema), CandidateController.resetPassword);

// Candidate Account Invitation
router.get('/invitations/verify', invitationLimiter, validate(candidateVerifyInvitationSchema), CandidateController.verifyInvitation);
router.post('/invitations/activate', invitationLimiter, validate(candidateActivateInvitationSchema), CandidateController.activateInvitation);

// ====================================================
// 2. Candidate Authenticated Endpoints
// ====================================================
router.post('/logout', authenticateCandidate, CandidateController.logout);
router.get('/me', authenticateCandidate, CandidateController.getMe);
router.put('/me', authenticateCandidate, validate(updateCandidateProfileSchema), CandidateController.updateMe);
router.get('/me/resume', authenticateCandidate, CandidateController.getMyResume);
router.post(
  '/me/resume',
  authenticateCandidate,
  upload.single('resume'),
  CandidateController.uploadResume
);
router.get('/me/saved-jobs', authenticateCandidate, CandidateController.getSavedJobs);
router.post('/me/saved-jobs/:jobId', authenticateCandidate, validate(jobIdParamSchema), CandidateController.saveJob);
router.delete('/me/saved-jobs/:jobId', authenticateCandidate, validate(jobIdParamSchema), CandidateController.removeSavedJob);
router.get('/me/applications', authenticateCandidate, CandidateController.getMyApplications);

// ====================================================
// 3. Admin Candidate Management (Session + 2FA Verified)
// ====================================================
const adminAuth = [authenticateSession, require2FAVerified];

// Candidate Directory (available on /admin and /)
router.get('/admin', ...adminAuth, validate(listCandidatesSchema), CandidateController.listCandidates);
router.get('/', ...adminAuth, validate(listCandidatesSchema), CandidateController.listCandidates);

// Create Candidate by Admin (requires valid resume file upload)
router.post('/admin', ...adminAuth, upload.single('resume'), validate(adminCreateCandidateSchema), CandidateController.createCandidate);
router.post('/', ...adminAuth, upload.single('resume'), validate(adminCreateCandidateSchema), CandidateController.createCandidate);

// Automatic Resume Parsing from uploaded document
router.post('/admin/parse-resume', ...adminAuth, upload.single('resume'), CandidateController.parseResume);
router.post('/parse-resume', ...adminAuth, upload.single('resume'), CandidateController.parseResume);

// Stream Resume Document (Inline Preview & Attachment Download)
router.get('/admin/:id/resume', ...adminAuth, validate(candidateIdParamSchema), CandidateController.getResume);
router.get('/:id/resume', ...adminAuth, validate(candidateIdParamSchema), CandidateController.getResume);

// Candidate 360° Profile Details
router.get('/admin/:id', ...adminAuth, validate(candidateIdParamSchema), CandidateController.getCandidateById);
router.get('/:id', ...adminAuth, validate(candidateIdParamSchema), CandidateController.getCandidateById);

// Update Candidate Profile by Admin
router.put('/admin/:id', ...adminAuth, validate(candidateIdParamSchema), validate(updateCandidateProfileSchema), CandidateController.updateCandidate);
router.put('/:id', ...adminAuth, validate(candidateIdParamSchema), validate(updateCandidateProfileSchema), CandidateController.updateCandidate);

// Update Candidate Status
router.patch('/admin/:id/status', ...adminAuth, validate(adminUpdateCandidateStatusSchema), CandidateController.updateCandidateStatus);
router.patch('/:id/status', ...adminAuth, validate(adminUpdateCandidateStatusSchema), CandidateController.updateCandidateStatus);

// Resend Invitation Email to Candidate
router.post('/admin/:id/resend-invitation', ...adminAuth, validate(candidateIdParamSchema), CandidateController.resendInvitation);
router.post('/:id/resend-invitation', ...adminAuth, validate(candidateIdParamSchema), CandidateController.resendInvitation);

// Upload Resume Document for Candidate by Admin
router.post('/admin/:id/resume', ...adminAuth, validate(candidateIdParamSchema), upload.single('resume'), CandidateController.uploadResumeByAdmin);
router.post('/:id/resume', ...adminAuth, validate(candidateIdParamSchema), upload.single('resume'), CandidateController.uploadResumeByAdmin);

// Soft Delete / Permanent Delete
router.delete('/admin/:id', ...adminAuth, validate(candidateIdParamSchema), CandidateController.deleteCandidate);
router.delete('/:id', ...adminAuth, validate(candidateIdParamSchema), CandidateController.deleteCandidate);

// Restore Candidate
router.post('/admin/:id/restore', ...adminAuth, validate(candidateIdParamSchema), CandidateController.restoreCandidate);
router.post('/:id/restore', ...adminAuth, validate(candidateIdParamSchema), CandidateController.restoreCandidate);

export default router;
