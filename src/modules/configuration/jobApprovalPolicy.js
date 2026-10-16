/**
 * Job Approval Policy Foundation
 *
 * Enforces automatic job approval rules and authorization policies.
 * Ensures jobs are only auto-approved if the persisted platform setting is enabled,
 * and maintains strict auditing and permission enforcement.
 */

export const JobApprovalStatus = {
  APPROVED: 'APPROVED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  REJECTED: 'REJECTED',
};

/**
 * Evaluates the initial status of a job posting upon submission.
 *
 * @param {object} params
 * @param {object} params.jobData
 * @param {object} params.settings Persisted platform settings
 * @param {object} params.creatorContext Actor submitting the job
 * @returns {{ status: string, requiresReview: boolean, reason: string }}
 */
export function evaluateJobApprovalStatus({ jobData, settings, creatorContext = {} }) {
  // If platform auto-approve jobs is enabled
  if (settings?.autoApproveJobs === true) {
    return {
      status: JobApprovalStatus.APPROVED,
      requiresReview: false,
      reason: 'Auto-approved by platform configuration policy.',
    };
  }

  // If created directly by a platform administrator, auto-approve
  if (creatorContext.role === 'SUPER_ADMIN' || creatorContext.role === 'ADMIN') {
    return {
      status: JobApprovalStatus.APPROVED,
      requiresReview: false,
      reason: 'Directly published by platform administrator.',
    };
  }

  // Default workflow: Requires administrative review and approval
  return {
    status: JobApprovalStatus.PENDING_APPROVAL,
    requiresReview: true,
    reason: 'Pending manual administrator review per platform configuration.',
  };
}

/**
 * Evaluates candidate profile approval status upon registration.
 *
 * @param {object} params
 * @param {object} params.settings Persisted platform settings
 * @returns {{ status: string, requiresReview: boolean }}
 */
export function evaluateCandidateProfileStatus({ settings }) {
  if (settings?.autoApproveCandidateProfiles === true) {
    return {
      status: 'APPROVED',
      requiresReview: false,
      reason: 'Auto-approved by platform configuration policy.',
    };
  }

  return {
    status: 'PENDING_APPROVAL',
    requiresReview: true,
    reason: 'Pending manual administrator verification per platform configuration.',
  };
}
