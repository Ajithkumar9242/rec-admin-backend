/**
 * RecruiTrain Soft Deletion & Trash Management Lifecycle Standards
 *
 * Defines the canonical soft-deletion architecture for upcoming data-management modules.
 * Standard Rules:
 * 1. Normal delete moves record to Trash (sets deletedAt timestamp and deletedBy admin ID).
 * 2. Trash records are retained for exactly 30 days.
 * 3. Authorized administrators can restore records within the 30-day window.
 * 4. Authorized administrators can permanently delete records from Trash immediately.
 * 5. A scheduled background cleanup worker purges records past their 30-day retention deadline.
 */

export const SOFT_DELETE_RETENTION_DAYS = 30;

export const DeletionMode = {
  MOVE_TO_TRASH: 'MOVE_TO_TRASH',
  DELETE_PERMANENTLY: 'DELETE_PERMANENTLY',
};

/**
 * Calculates the cutoff Date prior to which trash records are expired and eligible for permanent purge.
 * @param {number} [retentionDays=30] 
 * @returns {Date}
 */
export function getTrashRetentionCutoff(retentionDays = SOFT_DELETE_RETENTION_DAYS) {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Checks if a deleted record has exceeded the retention threshold.
 * @param {Date|string} deletedAt 
 * @param {number} [retentionDays=30] 
 * @returns {boolean}
 */
export function isTrashExpired(deletedAt, retentionDays = SOFT_DELETE_RETENTION_DAYS) {
  if (!deletedAt) return false;
  const deletedTime = new Date(deletedAt).getTime();
  const cutoffTime = getTrashRetentionCutoff(retentionDays).getTime();
  return deletedTime <= cutoffTime;
}

/**
 * Sanitizes and prepares soft-delete update payload.
 * @param {string} adminId 
 * @returns {{ deletedAt: Date, deletedBy: string }}
 */
export function prepareSoftDeletePayload(adminId) {
  return {
    deletedAt: new Date(),
    deletedBy: adminId || 'SYSTEM',
  };
}

/**
 * Sanitizes and prepares restore update payload.
 * @returns {{ deletedAt: null, deletedBy: null }}
 */
export function prepareRestorePayload() {
  return {
    deletedAt: null,
    deletedBy: null,
  };
}

/**
 * Shared filter helper to exclude soft-deleted records from standard queries.
 * @returns {{ deletedAt: null }}
 */
export function activeRecordsFilter() {
  return {
    deletedAt: null,
  };
}

/**
 * Shared filter helper to query records currently in Trash.
 * @returns {{ deletedAt: { not: null } }}
 */
export function trashRecordsFilter() {
  return {
    deletedAt: {
      not: null,
    },
  };
}
