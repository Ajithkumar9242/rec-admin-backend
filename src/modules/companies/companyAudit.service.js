/**
 * Company Audit Service
 *
 * Persists structured audit trail entries for all company operations,
 * onboarding steps, status transitions, review decisions, and document actions.
 * Automatically redacts any sensitive keys or tokens.
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'secret',
  'token',
  'tokenhash',
  'key',
  'totpsecret',
  'mfaencryptionkey',
]);

/**
 * Recursively redacts sensitive keys in audit payloads.
 */
export function redactSensitiveCompanyAuditData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(redactSensitiveCompanyAuditData);
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = redactSensitiveCompanyAuditData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Records a company audit log entry.
 *
 * @param {object} params
 * @param {string} params.companyId
 * @param {string} [params.adminId]
 * @param {string} params.action
 * @param {string} params.actor
 * @param {object} [params.details]
 * @param {any} [params.tx] Optional Prisma transaction client
 */
export async function logCompanyAction({
  companyId,
  adminId = null,
  action,
  actor,
  details = null,
  tx = prisma,
}) {
  try {
    let sanitizedDetails = details ? redactSensitiveCompanyAuditData(details) : null;
    if (sanitizedDetails) {
      sanitizedDetails = JSON.parse(JSON.stringify(sanitizedDetails));
    }

    const entry = await tx.companyAuditLog.create({
      data: {
        companyId,
        adminId,
        action,
        actor: actor || 'SYSTEM',
        details: sanitizedDetails,
      },
    });

    return entry;
  } catch (error) {
    logger.error({ error: error.message, companyId, action }, 'Failed to record company audit log');
    return null;
  }
}
