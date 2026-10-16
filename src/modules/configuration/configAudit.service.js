/**
 * Platform Configuration Audit Service
 *
 * Persists structured audit trail entries for all changes to industries,
 * document definitions, dynamic recruitment stages, and platform settings.
 * Automatically redacts any sensitive keys or tokens.
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'secret',
  'token',
  'key',
  'totpsecret',
  'mfaencryptionkey',
]);

/**
 * Recursively redacts sensitive keys in audit payloads.
 * @param {any} data
 * @returns {any}
 */
export function redactSensitiveConfigAuditData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(redactSensitiveConfigAuditData);
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = redactSensitiveConfigAuditData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Records a platform configuration audit log entry.
 *
 * @param {object} params
 * @param {string} [params.adminId]
 * @param {'INDUSTRY'|'DOCUMENT_DEFINITION'|'RECRUITMENT_STAGE'|'PLATFORM_SETTING'} params.entityType
 * @param {string} params.entityId
 * @param {string} params.action
 * @param {string} params.actor
 * @param {object} [params.details]
 * @param {any} [params.tx] Optional Prisma transaction client
 */
export async function logConfigAction({
  adminId = null,
  entityType,
  entityId,
  action,
  actor,
  details = null,
  tx = prisma,
}) {
  try {
    let sanitizedDetails = details ? redactSensitiveConfigAuditData(details) : null;
    if (sanitizedDetails) {
      sanitizedDetails = JSON.parse(JSON.stringify(sanitizedDetails));
    }

    const entry = await tx.platformConfigAuditLog.create({
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
    logger.error({ error: error.message, entityType, entityId, action }, 'Failed to record configuration audit log');
    return null;
  }
}
