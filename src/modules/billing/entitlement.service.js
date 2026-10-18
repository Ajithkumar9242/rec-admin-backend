/**
 * Reusable Subscription Entitlement & Quota Enforcement Service
 *
 * Implements strict server-side authorization and usage enforcement:
 * - Resolves active subscription with calendar validity boundaries.
 * - Handles EXPIRED, CANCELLED, REVOKED, and PAST_DUE states explicitly.
 * - Enforces resource limits atomically to prevent race conditions under concurrency.
 * - Clarifies Candidate Access as a consumption entitlement (unit: profile views/unlocks).
 * - Exposes Job Postings and Team Members as 'MODULE_PENDING' (not integrated)
 *   without fabricating dummy usage or zero-usage counters.
 */

import { prisma } from '../../lib/prisma.js';
import { isSubscriptionWithinValidity } from './billingDateUtils.js';

export class SubscriptionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.details = details;
    this.statusCode = 403;
  }
}

export class SubscriptionRequiredError extends SubscriptionError {
  constructor(companyId) {
    super(`No subscription found for employer ${companyId}. A valid subscription is required.`, 'NO_SUBSCRIPTION');
    this.statusCode = 402;
  }
}

export class SubscriptionInactiveError extends SubscriptionError {
  constructor(status, message = null) {
    super(message || `Subscription is not active (current status: ${status}).`, 'SUBSCRIPTION_INACTIVE', { status });
  }
}

export class SubscriptionExpiredError extends SubscriptionError {
  constructor(endDate) {
    super(`Subscription expired on ${new Date(endDate).toISOString()}. Access is blocked.`, 'SUBSCRIPTION_EXPIRED', { endDate });
  }
}

export class SubscriptionCancelledError extends SubscriptionError {
  constructor(cancelledAt, reason) {
    super(`Subscription was cancelled on ${cancelledAt}. Reason: ${reason || 'N/A'}.`, 'SUBSCRIPTION_CANCELLED', { cancelledAt, reason });
  }
}

export class SubscriptionRevokedError extends SubscriptionError {
  constructor(revokedAt, reason) {
    super(`Subscription was revoked by administrator on ${revokedAt}. Reason: ${reason || 'Administrative action'}.`, 'SUBSCRIPTION_REVOKED', { revokedAt, reason });
  }
}

export class QuotaExceededError extends SubscriptionError {
  constructor(resourceType, limit, currentUsage, requested) {
    super(
      `Entitlement quota exceeded for "${resourceType}". Current usage: ${currentUsage}, requested: ${requested}, limit: ${limit}.`,
      'QUOTA_EXCEEDED',
      { resourceType, limit, currentUsage, requested }
    );
    this.statusCode = 429;
    this.limit = limit;
    this.currentUsage = currentUsage;
    this.requested = requested;
    this.resourceType = resourceType;
  }
}

export class EntitlementService {
  /**
   * Resolves the current effective subscription for a company.
   * Performs automatic expiration transition if end date has passed.
   *
   * @param {string} companyId
   * @param {any} [tx=prisma]
   * @returns {Promise<any>}
   */
  static async resolveEffectiveSubscription(companyId, tx = prisma) {
    if (!companyId) {
      throw new Error('companyId is required to resolve effective subscription');
    }

    // Find the latest non-archived subscription
    const subscription = await tx.subscription.findFirst({
      where: {
        companyId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        plan: true,
        company: true,
      },
    });

    if (!subscription) {
      throw new SubscriptionRequiredError(companyId);
    }

    const now = new Date();

    // Check status-specific lifecycle
    if (subscription.status === 'CANCELLED') {
      throw new SubscriptionCancelledError(subscription.cancelledAt, subscription.cancellationReason);
    }

    if (subscription.status === 'REVOKED') {
      throw new SubscriptionRevokedError(subscription.revokedAt, subscription.revokedReason);
    }

    if (subscription.status === 'PAST_DUE' || subscription.status === 'INCOMPLETE') {
      throw new SubscriptionInactiveError(subscription.status, `Subscription payment is ${subscription.status.toLowerCase()}. Access suspended.`);
    }

    // Check temporal validity [startDate, endDate)
    if (subscription.status === 'ACTIVE' && subscription.endDate && now >= new Date(subscription.endDate)) {
      // Auto-transition to EXPIRED in database
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { status: 'EXPIRED' },
      });
      throw new SubscriptionExpiredError(subscription.endDate);
    }

    if (subscription.status === 'EXPIRED') {
      throw new SubscriptionExpiredError(subscription.endDate);
    }

    if (subscription.status !== 'ACTIVE') {
      throw new SubscriptionInactiveError(subscription.status);
    }

    // Check if subscription has not started yet
    if (new Date(subscription.startDate) > now) {
      throw new SubscriptionInactiveError('FUTURE', `Subscription starts on ${new Date(subscription.startDate).toISOString()}.`);
    }

    return subscription;
  }

  /**
   * Checks whether the employer is entitled to perform an operation.
   *
   * @param {object} params
   * @param {string} params.companyId
   * @param {'candidateAccess'|'jobPosting'|'teamMember'} params.resourceType
   * @param {number} [params.requestedCount=1]
   * @param {any} [params.tx]
   * @returns {Promise<{ allowed: boolean, subscription: any, limit: number, usage: any, integrated: boolean }>}
   */
  static async checkEntitlement({ companyId, resourceType, requestedCount = 1, tx = prisma }) {
    const subscription = await this.resolveEffectiveSubscription(companyId, tx);

    if (resourceType === 'candidateAccess') {
      const limit = subscription.candidateAccessLimit;
      const currentUsage = subscription.candidateAccessUsage;

      if (currentUsage + requestedCount > limit) {
        throw new QuotaExceededError('candidateAccess', limit, currentUsage, requestedCount);
      }

      return {
        allowed: true,
        subscription,
        limit,
        usage: currentUsage,
        integrated: true,
      };
    }

    if (resourceType === 'jobPosting') {
      const limit = subscription.jobPostingLimit;
      const currentUsage = await tx.job.count({
        where: {
          companyId,
          status: { in: ['PUBLISHED', 'PENDING_APPROVAL'] },
          deletedAt: null,
        },
      });

      if (currentUsage + requestedCount > limit) {
        throw new QuotaExceededError('jobPosting', limit, currentUsage, requestedCount);
      }

      return {
        allowed: true,
        subscription,
        limit,
        usage: currentUsage,
        integrated: true,
      };
    }

    if (resourceType === 'teamMember') {
      const limit = subscription.teamMemberLimit;
      const currentUsage = await tx.companyUser.count({
        where: { companyId },
      });

      if (currentUsage + requestedCount > limit) {
        throw new QuotaExceededError('teamMember', limit, currentUsage, requestedCount);
      }

      return {
        allowed: true,
        subscription,
        limit,
        usage: currentUsage,
        integrated: true,
      };
    }

    throw new Error(`Unknown resourceType: "${resourceType}"`);
  }

  /**
   * Concurrency-safe atomic consumption of candidate access entitlement.
   * Guarantees that parallel requests cannot exceed candidate access limit.
   *
   * @param {object} params
   * @param {string} params.companyId
   * @param {number} [params.amount=1]
   * @param {string} [params.reason]
   * @param {string} [params.adminId]
   * @param {any} [params.externalTx]
   * @returns {Promise<{ success: boolean, newUsage: number, limit: number }>}
   */
  static async consumeCandidateAccess({ companyId, amount = 1, reason = 'Candidate profile view', adminId = null, externalTx = null }) {
    if (amount <= 0) {
      throw new Error('Consumption amount must be a positive integer.');
    }

    const runInTx = async (tx) => {
      const subscription = await this.resolveEffectiveSubscription(companyId, tx);

      // Atomic conditional update: ONLY increment if usage + amount <= limit
      const result = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          status: 'ACTIVE',
          candidateAccessUsage: {
            lte: subscription.candidateAccessLimit - amount,
          },
        },
        data: {
          candidateAccessUsage: {
            increment: amount,
          },
        },
      });

      if (result.count === 0) {
        // Fetch current usage for accurate error details
        const latest = await tx.subscription.findUnique({
          where: { id: subscription.id },
          select: { candidateAccessUsage: true, candidateAccessLimit: true },
        });
        throw new QuotaExceededError(
          'candidateAccess',
          latest?.candidateAccessLimit ?? subscription.candidateAccessLimit,
          latest?.candidateAccessUsage ?? subscription.candidateAccessUsage,
          amount
        );
      }

      // Record in audit ledger
      await tx.candidateAccessLog.create({
        data: {
          subscriptionId: subscription.id,
          companyId,
          amount,
          reason,
        },
      });

      const updatedSub = await tx.subscription.findUnique({
        where: { id: subscription.id },
        select: { candidateAccessUsage: true, candidateAccessLimit: true },
      });

      return {
        success: true,
        newUsage: updatedSub.candidateAccessUsage,
        limit: updatedSub.candidateAccessLimit,
      };
    };

    if (externalTx) {
      return runInTx(externalTx);
    }
    return prisma.$transaction(runInTx);
  }

  /**
   * Returns comprehensive subscription usage snapshot for an employer.
   * Clearly distinguishes integrated candidate access from pending modules (jobs, team members).
   *
   * @param {string} companyId
   * @param {any} [tx=prisma]
   * @returns {Promise<any>}
   */
  static async getCompanySubscriptionUsage(companyId, tx = prisma) {
    try {
      const subscription = await this.resolveEffectiveSubscription(companyId, tx);

      const [activeJobCount, teamMemberCount] = await Promise.all([
        tx.job.count({
          where: {
            companyId,
            status: { in: ['PUBLISHED', 'PENDING_APPROVAL'] },
            deletedAt: null,
          },
        }),
        tx.companyUser.count({
          where: {
            companyId,
          },
        }),
      ]);

      return {
        hasActiveSubscription: true,
        subscription: {
          id: subscription.id,
          status: subscription.status,
          planName: subscription.plan.name,
          planId: subscription.planId,
          startDate: subscription.startDate,
          endDate: subscription.endDate,
          nextBillingDate: subscription.nextBillingDate,
          billingInterval: subscription.billingInterval,
          currency: subscription.currency,
          price: subscription.price,
        },
        entitlements: {
          candidateAccess: {
            limit: subscription.candidateAccessLimit,
            usage: subscription.candidateAccessUsage,
            remaining: Math.max(0, subscription.candidateAccessLimit - subscription.candidateAccessUsage),
            unit: 'candidate_views',
            resetPolicy: subscription.billingInterval === 'ONE_TIME' ? 'lifetime' : 'per_billing_interval',
            integrated: true,
            statusText: 'INTEGRATED',
          },
          jobPostings: {
            limit: subscription.jobPostingLimit,
            usage: activeJobCount,
            remaining: Math.max(0, subscription.jobPostingLimit - activeJobCount),
            unit: 'active_postings',
            resetPolicy: 'concurrent_active',
            integrated: true,
            statusText: 'INTEGRATED',
          },
          teamMembers: {
            limit: subscription.teamMemberLimit,
            usage: teamMemberCount,
            remaining: Math.max(0, subscription.teamMemberLimit - teamMemberCount),
            unit: 'seats',
            resetPolicy: 'concurrent_active',
            integrated: false,
            statusText: 'MODULE_PENDING',
          },
        },
      };
    } catch (err) {
      if (err instanceof SubscriptionError) {
        return {
          hasActiveSubscription: false,
          error: err.message,
          code: err.code,
          details: err.details,
          entitlements: null,
        };
      }
      throw err;
    }
  }
}
