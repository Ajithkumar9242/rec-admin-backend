/**
 * Billing Audit Service
 *
 * Persists structured audit trail entries for all plan, subscription,
 * entitlement, invoice, and payment modifications.
 * Automatically redacts sensitive credentials, tokens, or financial identifiers.
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'secret',
  'token',
  'cvc',
  'cardnumber',
  'stripesecretkey',
  'stripewebhooksecret',
  'key',
]);

/**
 * Recursively redacts sensitive keys in audit payloads.
 * @param {any} data
 * @returns {any}
 */
export function redactSensitiveAuditData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(redactSensitiveAuditData);
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = redactSensitiveAuditData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Records a billing audit log entry.
 *
 * @param {object} params
 * @param {string} [params.adminId]
 * @param {'PLAN'|'SUBSCRIPTION'|'INVOICE'|'PAYMENT'|'ENTITLEMENT'} params.entityType
 * @param {string} params.entityId
 * @param {string} params.action
 * @param {string} params.actor
 * @param {object} [params.details]
 * @param {any} [params.tx] Optional Prisma transaction client
 */
export async function logBillingAction({
  adminId = null,
  entityType,
  entityId,
  action,
  actor,
  details = null,
  tx = prisma,
}) {
  try {
    let sanitizedDetails = details ? redactSensitiveAuditData(details) : null;
    if (sanitizedDetails) {
      sanitizedDetails = JSON.parse(JSON.stringify(sanitizedDetails));
    }

    const entry = await tx.billingAuditLog.create({
      data: {
        adminId,
        entityType,
        entityId: String(entityId),
        action,
        actor: actor || 'SYSTEM',
        details: sanitizedDetails,
      },
    });

    return entry;
  } catch (error) {
    logger.error({ error: error.message, entityType, entityId, action }, 'Failed to record billing audit log');
    // We log but do not bubble catastrophic failure unless strict
    return null;
  }
}
