import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { NotificationService } from './notification.service.js';
import { getEffectivePermissions } from '../../middleware/rbac.js';

export class BusinessEventNotificationService {
  /**
   * Resolves active administrators eligible to receive a business event notification
   * based on role, module access, action, and company/tenant isolation.
   */
  static async resolveEligibleAdmins({
    module = null,
    action = 'READ',
    companyId = null,
    explicitAdminIds = null,
  } = {}) {
    if (Array.isArray(explicitAdminIds) && explicitAdminIds.length > 0) {
      return explicitAdminIds;
    }

    const activeAdmins = await prisma.admin.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, role: true, email: true },
    });

    const eligibleAdminIds = [];

    for (const admin of activeAdmins) {
      // Super Admin always has full visibility
      if (admin.role === 'SUPER_ADMIN') {
        eligibleAdminIds.push(admin.id);
        continue;
      }

      // If no module constraint, all active platform admins are eligible
      if (!module) {
        eligibleAdminIds.push(admin.id);
        continue;
      }

      try {
        const effective = await getEffectivePermissions(admin);

        // Enforce tenant isolation if the admin is scoped to a specific company
        if (companyId && effective.companyId && effective.companyId !== companyId) {
          continue;
        }

        if (effective.permissions?.[module]?.[action]) {
          eligibleAdminIds.push(admin.id);
        }
      } catch (err) {
        logger.warn(
          { error: err.message, adminId: admin.id },
          'Error checking admin permissions for business notification'
        );
      }
    }

    return eligibleAdminIds;
  }

  /**
   * Emits a business notification to all eligible admins with database-backed
   * idempotency and safe error isolation.
   */
  static async emitEvent({
    eventId, // Stable unique event identifier for idempotency
    title,
    body,
    category = 'GENERAL',
    deepLinkUrl = null,
    metadata = {},
    module = null,
    action = 'READ',
    companyId = null,
    explicitAdminIds = null,
    sendPush = true,
  }) {
    try {
      const recipientIds = await this.resolveEligibleAdmins({
        module,
        action,
        companyId,
        explicitAdminIds,
      });

      if (!recipientIds || recipientIds.length === 0) {
        logger.info(
          {
            eventId,
            eventType: metadata?.eventType || 'UNKNOWN_EVENT',
            recipientCount: 0,
          },
          'Business event notification: No eligible admin recipients resolved'
        );
        return { deliveredCount: 0, skipped: true, pushSent: 0, pushFailed: 0 };
      }

      let deliveredCount = 0;
      let idempotentSkippedCount = 0;
      let pushAttemptedCount = 0;
      let pushSentCount = 0;
      let pushFailedCount = 0;
      const allErrorCodes = [];

      for (const adminId of recipientIds) {
        // Idempotency check: prevent duplicate notifications for retries, webhooks, or repeated requests
        if (eventId) {
          const alreadyExists = await prisma.adminNotification.findFirst({
            where: {
              adminId,
              metadata: {
                path: ['eventId'],
                equals: eventId,
              },
            },
            select: { id: true },
          });

          if (alreadyExists) {
            idempotentSkippedCount++;
            continue;
          }
        }

        try {
          const result = await NotificationService.createNotification({
            adminId,
            title,
            body,
            category,
            deepLinkUrl,
            metadata: {
              ...metadata,
              eventId: eventId || undefined,
            },
            sendPush,
          });

          deliveredCount++;

          if (result?.delivery) {
            pushAttemptedCount += (result.delivery.sent || 0) + (result.delivery.failed || 0);
            pushSentCount += result.delivery.sent || 0;
            pushFailedCount += result.delivery.failed || 0;
            if (Array.isArray(result.delivery.errorCodes)) {
              allErrorCodes.push(...result.delivery.errorCodes);
            }
          }
        } catch (deliveryErr) {
          logger.warn(
            { error: deliveryErr.message, adminId, eventId },
            'Failed to deliver notification to individual admin. Operation preserved.'
          );
        }
      }

      logger.info(
        {
          eventId,
          eventType: metadata?.eventType || 'UNKNOWN_EVENT',
          recipientCount: recipientIds.length,
          createdCount: deliveredCount,
          idempotentSkippedCount,
          pushAttempted: pushAttemptedCount,
          pushSent: pushSentCount,
          pushFailed: pushFailedCount,
          errorCodes: [...new Set(allErrorCodes)],
        },
        'Business event notification dispatch completed'
      );

      return {
        deliveredCount,
        skipped: false,
        idempotentSkipped: idempotentSkippedCount,
        pushSent: pushSentCount,
        pushFailed: pushFailedCount,
      };
    } catch (error) {
      logger.error(
        { error: error.message, eventId, title },
        'Business event notification dispatcher encountered error. Business operation preserved.'
      );
      return { deliveredCount: 0, error: error.message };
    }
  }

  // =========================================================================
  // 1. Companies & Employer Management Events
  // =========================================================================

  static async notifyCompanyCreated({ company, actorAdminId = null }) {
    if (!company) return;
    return this.emitEvent({
      eventId: `COMPANY_CREATED_${company.id}`,
      title: 'RecruTrain — New Company Created',
      body: `Employer company "${company.name}" has been registered on the platform.`,
      category: 'SYSTEM',
      deepLinkUrl: `/companies/${company.id}`,
      metadata: {
        eventType: 'COMPANY_CREATED',
        companyId: company.id,
        companyName: company.name,
        actorAdminId,
      },
      module: 'COMPANIES',
      action: 'READ',
    });
  }

  static async notifyCompanyStatusChanged({
    company,
    status,
    newStatus,
    previousStatus,
    reason = null,
    decision = null,
    actorAdminId = null,
  }) {
    if (!company) return;

    const effectiveStatus = (newStatus || status || '').toUpperCase();
    let title = 'RecruTrain — Company Status Updated';
    let body = `Employer company "${company.name}" status changed to ${effectiveStatus}.`;
    let eventType = 'COMPANY_STATUS_UPDATED';

    if (decision === 'APPROVE' || effectiveStatus === 'ACTIVE') {
      title = previousStatus === 'PENDING_APPROVAL' ? 'RecruTrain — Company Approved' : 'RecruTrain — Company Activated';
      body = `Employer company "${company.name}" has been approved and activated.`;
      eventType = 'COMPANY_ACTIVATED';
    } else if (decision === 'REJECT' || effectiveStatus === 'REJECTED') {
      title = 'RecruTrain — Company Rejected';
      body = `Onboarding application for "${company.name}" was rejected${reason ? `: ${reason}` : '.'}`;
      eventType = 'COMPANY_REJECTED';
    } else if (effectiveStatus === 'SUSPENDED') {
      title = 'RecruTrain — Company Suspended';
      body = `Employer company "${company.name}" has been suspended${reason ? `: ${reason}` : '.'}`;
      eventType = 'COMPANY_SUSPENDED';
    } else if (effectiveStatus === 'INACTIVE') {
      title = 'RecruTrain — Company Deactivated';
      body = `Employer company "${company.name}" has been deactivated.`;
      eventType = 'COMPANY_DEACTIVATED';
    }

    return this.emitEvent({
      eventId: `COMPANY_STATUS_${company.id}_${effectiveStatus}_${Date.now()}`,
      title,
      body,
      category: 'SYSTEM',
      deepLinkUrl: `/companies/${company.id}`,
      metadata: {
        eventType,
        companyId: company.id,
        companyName: company.name,
        status: effectiveStatus,
        previousStatus,
        reason,
        actorAdminId,
      },
      module: 'COMPANIES',
      action: 'READ',
    });
  }

  static async notifyCompanyRestored({ company, actorAdminId = null }) {
    if (!company) return;
    return this.emitEvent({
      eventId: `COMPANY_RESTORED_${company.id}_${Date.now()}`,
      title: 'RecruTrain — Company Restored',
      body: `Employer company "${company.name}" has been restored from trash.`,
      category: 'SYSTEM',
      deepLinkUrl: `/companies/${company.id}`,
      metadata: {
        eventType: 'COMPANY_RESTORED',
        companyId: company.id,
        companyName: company.name,
        actorAdminId,
      },
      module: 'COMPANIES',
      action: 'READ',
    });
  }

  static async notifyCompanyInvitationAccepted({
    company,
    user,
    companyId,
    companyName,
    userEmail,
    userName,
  }) {
    const cId = company?.id || companyId;
    const cName = company?.name || companyName || 'the employer company';
    const uEmail = user?.email || userEmail;
    const uName = user?.name || userName || uEmail;

    return this.emitEvent({
      eventId: `COMPANY_INVITE_ACCEPTED_${cId}_${uEmail}`,
      title: 'RecruTrain — Invitation Accepted',
      body: `${uName}${uEmail ? ` (${uEmail})` : ''} has accepted the invitation to join ${cName}.`,
      category: 'SYSTEM',
      deepLinkUrl: `/companies/${cId}`,
      metadata: {
        eventType: 'COMPANY_INVITATION_ACCEPTED',
        companyId: cId,
        userEmail: uEmail,
      },
      module: 'COMPANIES',
      action: 'READ',
    });
  }

  // =========================================================================
  // 2. Jobs & Job Postings Events
  // =========================================================================

  static async notifyJobCreated({ job, company, actorAdminId = null }) {
    if (!job) return;
    const companyName = company?.name || 'Company';
    return this.emitEvent({
      eventId: `JOB_DRAFT_CREATED_${job.id}`,
      title: 'RecruTrain — Job Draft Created',
      body: `A new job draft "${job.title}" has been created for ${companyName}.`,
      category: 'APPLICATION',
      deepLinkUrl: `/jobs/${job.id}`,
      metadata: {
        eventType: 'JOB_DRAFT_CREATED',
        jobId: job.id,
        jobTitle: job.title,
        companyId: job.companyId,
        actorAdminId,
      },
      module: 'JOBS',
      action: 'READ',
      companyId: job.companyId,
    });
  }

  static async notifyJobPendingApproval({ job, company, actorAdminId = null }) {
    if (!job) return;
    const companyName = company?.name || 'Company';
    return this.emitEvent({
      eventId: `JOB_PENDING_APPROVAL_${job.id}_${Date.now()}`,
      title: 'RecruTrain — Job Pending Approval',
      body: `Job posting "${job.title}" for ${companyName} requires administrative approval.`,
      category: 'APPLICATION',
      deepLinkUrl: `/jobs/${job.id}`,
      metadata: {
        eventType: 'JOB_PENDING_APPROVAL',
        jobId: job.id,
        jobTitle: job.title,
        companyId: job.companyId,
        actorAdminId,
      },
      module: 'JOBS',
      action: 'READ',
      companyId: job.companyId,
    });
  }

  static async notifyJobPublished({ job, company, actorAdminId = null }) {
    if (!job) return;
    const companyName = company?.name || 'Company';
    return this.emitEvent({
      eventId: `JOB_PUBLISHED_${job.id}`,
      title: 'RecruTrain — Job Published',
      body: `Job posting "${job.title}" for ${companyName} is now published and active.`,
      category: 'APPLICATION',
      deepLinkUrl: `/jobs/${job.id}`,
      metadata: {
        eventType: 'JOB_PUBLISHED',
        jobId: job.id,
        jobTitle: job.title,
        companyId: job.companyId,
        actorAdminId,
      },
      module: 'JOBS',
      action: 'READ',
      companyId: job.companyId,
    });
  }

  static async notifyJobStatusChanged({
    job,
    status,
    newStatus,
    previousStatus,
    reason = null,
    actorAdminId = null,
  }) {
    if (!job) return;

    const effectiveStatus = (newStatus || status || '').toUpperCase();
    let title = 'RecruTrain — Job Status Updated';
    let body = `Job posting "${job.title}" has been marked as ${effectiveStatus}.`;

    if (effectiveStatus === 'CLOSED') {
      title = 'RecruTrain — Job Closed';
      body = reason
        ? `Job posting "${job.title}" was closed: ${reason}`
        : `Job posting "${job.title}" has been closed to new applications.`;
    } else if (effectiveStatus === 'SUSPENDED') {
      title = 'RecruTrain — Job Suspended';
      body = `Job posting "${job.title}" has been suspended${reason ? `: ${reason}` : '.'}`;
    } else if (effectiveStatus === 'ARCHIVED') {
      title = 'RecruTrain — Job Archived';
      body = `Job posting "${job.title}" has been archived.`;
    }

    return this.emitEvent({
      eventId: `JOB_STATUS_${job.id}_${effectiveStatus}_${Date.now()}`,
      title,
      body,
      category: 'APPLICATION',
      deepLinkUrl: `/jobs/${job.id}`,
      metadata: {
        eventType: 'JOB_STATUS_CHANGED',
        jobId: job.id,
        jobTitle: job.title,
        status: effectiveStatus,
        previousStatus,
        reason,
        actorAdminId,
      },
      module: 'JOBS',
      action: 'READ',
      companyId: job.companyId,
    });
  }

  static async notifyJobRestored({ job, actorAdminId = null }) {
    if (!job) return;
    return this.emitEvent({
      eventId: `JOB_RESTORED_${job.id}_${Date.now()}`,
      title: 'RecruTrain — Job Restored',
      body: `Job posting "${job.title}" has been restored from trash.`,
      category: 'APPLICATION',
      deepLinkUrl: `/jobs/${job.id}`,
      metadata: {
        eventType: 'JOB_RESTORED',
        jobId: job.id,
        jobTitle: job.title,
        companyId: job.companyId,
        actorAdminId,
      },
      module: 'JOBS',
      action: 'READ',
      companyId: job.companyId,
    });
  }

  // =========================================================================
  // 3. Candidates & Applications Events
  // =========================================================================

  static async notifyCandidateRegistered({ candidate }) {
    if (!candidate) return;
    const displayName = candidate.fullName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'A new candidate';
    const emailStr = candidate.email ? ` (${candidate.email})` : '';
    return this.emitEvent({
      eventId: `CANDIDATE_REGISTERED_${candidate.id}`,
      title: 'RecruTrain — New Candidate Registered',
      body: `${displayName}${emailStr} has completed candidate registration.`,
      category: 'CANDIDATE',
      deepLinkUrl: `/candidates/${candidate.id}`,
      metadata: {
        eventType: 'CANDIDATE_REGISTERED',
        candidateId: candidate.id,
      },
      module: 'CANDIDATES',
      action: 'READ',
    });
  }

  static async notifyCandidateCreatedByAdmin({ candidate, actorAdminId = null }) {
    if (!candidate) return;
    const displayName = candidate.fullName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate';
    return this.emitEvent({
      eventId: `CANDIDATE_ADMIN_CREATED_${candidate.id}`,
      title: 'RecruTrain — Candidate Profile Created',
      body: `Candidate profile for ${displayName} was created successfully.`,
      category: 'CANDIDATE',
      deepLinkUrl: `/candidates/${candidate.id}`,
      metadata: {
        eventType: 'CANDIDATE_CREATED_BY_ADMIN',
        candidateId: candidate.id,
        actorAdminId,
      },
      module: 'CANDIDATES',
      action: 'READ',
    });
  }

  static async notifyCandidateStatusChanged({
    candidate,
    status,
    newStatus,
    previousStatus,
    reason = null,
    actorAdminId = null,
  }) {
    if (!candidate) return;

    const effectiveStatus = (newStatus || status || '').toUpperCase();
    const displayName = candidate.fullName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate';
    let title = 'RecruTrain — Candidate Status Updated';
    let body = `Candidate "${displayName}" status was updated to ${effectiveStatus}.`;

    return this.emitEvent({
      eventId: `CANDIDATE_STATUS_${candidate.id}_${effectiveStatus}_${Date.now()}`,
      title,
      body,
      category: 'CANDIDATE',
      deepLinkUrl: `/candidates/${candidate.id}`,
      metadata: {
        eventType: 'CANDIDATE_STATUS_CHANGED',
        candidateId: candidate.id,
        candidateName: displayName,
        status: effectiveStatus,
        previousStatus,
        reason,
        actorAdminId,
      },
      module: 'CANDIDATES',
      action: 'READ',
    });
  }

  static async notifyApplicationReceived({ application, job, candidateName }) {
    if (!application) return;
    const jobTitle = job?.title || 'Job Posting';
    const applicantName = candidateName || 'A candidate';
    const jobId = job?.id || application.jobId;
    return this.emitEvent({
      eventId: `APPLICATION_RECEIVED_${application.id}`,
      title: 'RecruTrain — New Application Received',
      body: `${applicantName} applied for "${jobTitle}".`,
      category: 'APPLICATION',
      deepLinkUrl: `/jobs/${jobId}/pipeline`,
      metadata: {
        eventType: 'APPLICATION_RECEIVED',
        applicationId: application.id,
        jobId,
      },
      module: 'APPLICATIONS',
      action: 'READ',
      companyId: job?.companyId || application.companyId,
    });
  }

  // =========================================================================
  // 4. Hiring Pipeline Events
  // =========================================================================

  static async notifyPipelineStageChanged({
    application,
    job,
    candidateName,
    fromStageName,
    toStageName,
    previousStageName,
    newStageName,
    newStageCategory,
    isHired = false,
    isRejected = false,
    actorAdminId = null,
  }) {
    if (!application) return;

    const fromStage = fromStageName || previousStageName || 'Screening';
    const toStage = toStageName || newStageName || 'Next Stage';
    const applicant = candidateName || 'Candidate';
    const jobTitle = job?.title || 'Job';
    const jobId = job?.id || application.jobId;
    const hired = isHired || newStageCategory === 'HIRED';
    const rejected = isRejected || newStageCategory === 'REJECTED';

    let title = `RecruTrain — Candidate Moved to ${toStage}`;
    let body = `Application for ${applicant} moved from ${fromStage} to ${toStage}.`;
    let eventType = 'STAGE_CHANGED';

    if (hired) {
      title = `RecruTrain — Candidate Hired: ${applicant}`;
      body = `${applicant} has been hired for "${jobTitle}".`;
      eventType = 'CANDIDATE_HIRED';
    } else if (rejected) {
      title = `RecruTrain — Application Rejected: ${applicant}`;
      body = `Application for ${applicant} on "${jobTitle}" was marked as rejected.`;
      eventType = 'CANDIDATE_REJECTED';
    }

    return this.emitEvent({
      eventId: `STAGE_CHANGE_${application.id}_${toStage}_${Date.now()}`,
      title,
      body,
      category: 'APPLICATION',
      deepLinkUrl: `/jobs/${jobId}/pipeline`,
      metadata: {
        eventType,
        applicationId: application.id,
        jobId,
        fromStage,
        toStage,
        actorAdminId,
      },
      module: 'APPLICATIONS',
      action: 'READ',
      companyId: job?.companyId || application.companyId,
    });
  }

  static async notifyBulkPipelineStagesChanged({
    job,
    jobId,
    jobTitle,
    count,
    toStageName,
    newStageName,
    actorAdminId = null,
  }) {
    if (!count || count <= 0) return;

    const targetJobId = job?.id || jobId;
    const targetJobTitle = job?.title || jobTitle || 'Job';
    const destinationStage = newStageName || toStageName || 'New Stage';

    return this.emitEvent({
      eventId: `BULK_STAGE_${targetJobId}_${destinationStage}_${Date.now()}`,
      title: `RecruTrain — ${count} Candidates Moved to ${destinationStage}`,
      body: `${count} candidates were moved to "${destinationStage}" for "${targetJobTitle}".`,
      category: 'APPLICATION',
      deepLinkUrl: `/jobs/${targetJobId}/pipeline`,
      metadata: {
        eventType: 'BULK_STAGE_CHANGED',
        jobId: targetJobId,
        count,
        toStage: destinationStage,
        actorAdminId,
      },
      module: 'APPLICATIONS',
      action: 'READ',
      companyId: job?.companyId,
    });
  }

  // =========================================================================
  // 5. Subscriptions & Billing Events
  // =========================================================================

  static async notifySubscriptionCreated({ subscription, plan, company, actorAdminId = null, eventId = null }) {
    if (!subscription) return;
    const companyName = company?.name || 'Company';
    const planName = plan?.name || 'Subscription Plan';

    return this.emitEvent({
      eventId: eventId || `SUB_CREATED_${subscription.id}`,
      title: 'RecruTrain — New Subscription Activated',
      body: `Company "${companyName}" subscribed to plan "${planName}".`,
      category: 'BILLING',
      deepLinkUrl: '/billing/subscriptions',
      metadata: {
        eventType: 'SUBSCRIPTION_ACTIVATED',
        subscriptionId: subscription.id,
        companyId: subscription.companyId,
        planId: subscription.planId,
        actorAdminId,
      },
      module: 'BILLING',
      action: 'READ',
    });
  }

  static async notifySubscriptionUpdated({
    subscription,
    plan,
    company,
    previousPlanName,
    newPlanName,
    changeType = 'updated',
    actorAdminId = null,
    eventId = null,
  }) {
    if (!subscription) return;
    const companyName = company?.name || 'Company';
    const planDesc = previousPlanName && newPlanName ? `${previousPlanName} to ${newPlanName}` : (plan?.name || newPlanName || 'Plan');

    return this.emitEvent({
      eventId: eventId || `SUB_UPDATED_${subscription.id}_${Date.now()}`,
      title: 'RecruTrain — Subscription Updated',
      body: `Subscription for "${companyName}" was changed from ${planDesc}.`,
      category: 'BILLING',
      deepLinkUrl: '/billing/subscriptions',
      metadata: {
        eventType: 'SUBSCRIPTION_UPDATED',
        subscriptionId: subscription.id,
        companyId: subscription.companyId,
        changeType,
        actorAdminId,
      },
      module: 'BILLING',
      action: 'READ',
    });
  }

  static async notifySubscriptionCancelled({ subscription, company, reason = null, actorAdminId = null, eventId = null }) {
    if (!subscription) return;
    const companyName = company?.name || 'Company';

    return this.emitEvent({
      eventId: eventId || `SUB_CANCELLED_${subscription.id}`,
      title: 'RecruTrain — Subscription Cancelled',
      body: `Subscription for "${companyName}" has been cancelled${reason ? `: ${reason}` : '.'}`,
      category: 'BILLING',
      deepLinkUrl: '/billing/subscriptions',
      metadata: {
        eventType: 'SUBSCRIPTION_CANCELLED',
        subscriptionId: subscription.id,
        companyId: subscription.companyId,
        reason,
        actorAdminId,
      },
      module: 'BILLING',
      action: 'READ',
    });
  }

  static async notifyPaymentSucceeded({
    payment,
    invoice,
    invoiceNumber,
    amount,
    currency = 'EUR',
    company,
    paymentMethod = 'stripe',
    eventId = null,
  }) {
    const companyName = company?.name || company?.legalName || 'Company';
    const payAmount = payment?.amount ?? amount ?? invoice?.grossTotal ?? 0;
    const payCurrency = payment?.currency || currency || 'EUR';
    const invNum = invoiceNumber || invoice?.invoiceNumber;
    const formattedAmount = `${Number(payAmount).toFixed(2)} ${payCurrency.toUpperCase()}`;

    return this.emitEvent({
      eventId: eventId || `PAYMENT_SUCCESS_${payment?.id || invoice?.id || Date.now()}`,
      title: invNum ? `RecruTrain — Payment Received: ${invNum}` : 'RecruTrain — Payment Received',
      body: `Payment of ${formattedAmount} confirmed for "${companyName}".`,
      category: 'BILLING',
      deepLinkUrl: '/billing/invoices',
      metadata: {
        eventType: 'PAYMENT_SUCCEEDED',
        invoiceId: invoice?.id || payment?.invoiceId,
        amount: payAmount,
        currency: payCurrency,
        paymentMethod,
      },
      module: 'BILLING',
      action: 'READ',
    });
  }

  static async notifyPaymentFailed({
    company,
    invoice,
    invoiceId,
    amount,
    currency = 'EUR',
    reason = null,
    eventId = null,
  }) {
    const companyName = company?.name || 'Company';
    const formattedAmount = amount ? `${Number(amount).toFixed(2)} ${currency.toUpperCase()}` : null;

    return this.emitEvent({
      eventId: eventId || `PAYMENT_FAILED_${invoiceId || invoice?.id || Date.now()}`,
      title: 'RecruTrain — Payment Failed',
      body: `Payment ${formattedAmount ? `of ${formattedAmount} ` : ''}for "${companyName}" failed${reason ? `: ${reason}` : '.'}`,
      category: 'BILLING',
      deepLinkUrl: '/billing/invoices',
      metadata: {
        eventType: 'PAYMENT_FAILED',
        invoiceId: invoiceId || invoice?.id,
        amount,
        reason,
      },
      module: 'BILLING',
      action: 'READ',
    });
  }

  static async notifyRefundCompleted({
    payment,
    chargeId,
    amount,
    currency = 'EUR',
    company,
    eventId = null,
  }) {
    const companyName = company?.name || 'Company';
    const refundAmount = amount ?? payment?.refundedAmount ?? 0;
    const refundCurrency = currency || payment?.currency || 'EUR';
    const formattedAmount = `${Number(refundAmount).toFixed(2)} ${refundCurrency.toUpperCase()}`;

    return this.emitEvent({
      eventId: eventId || `REFUND_${payment?.id || chargeId || Date.now()}`,
      title: 'RecruTrain — Refund Processed',
      body: `Refund of ${formattedAmount} processed for "${companyName}".`,
      category: 'BILLING',
      deepLinkUrl: '/billing/invoices',
      metadata: {
        eventType: 'REFUND_PROCESSED',
        chargeId: chargeId || payment?.stripeChargeId,
        amount: refundAmount,
        currency: refundCurrency,
      },
      module: 'BILLING',
      action: 'READ',
    });
  }

  // =========================================================================
  // 6. Security & Administration Events
  // =========================================================================

  static async notifyRoleUpdated({
    role,
    actorName,
    changesSummary,
    actorAdminId = null,
  }) {
    if (!role) return;
    const actorDesc = actorName ? ` by ${actorName}` : '';
    const summary = changesSummary ? `: ${changesSummary}` : '.';

    return this.emitEvent({
      eventId: `ROLE_UPDATED_${role.id}_${Date.now()}`,
      title: `RecruTrain — Security: Role "${role.name}" Updated`,
      body: `Permissions for security role "${role.name}" were updated${actorDesc}${summary}`,
      category: 'SECURITY',
      deepLinkUrl: '/teams/roles',
      metadata: {
        eventType: 'ROLE_UPDATED',
        roleId: role.id,
        roleName: role.name,
        actorAdminId,
      },
      module: 'TEAMS',
      action: 'READ',
    });
  }

  static async notifyAccountLocked({
    admin,
    failedAttempts,
    lockoutMinutes = 15,
    ipAddress = null,
  }) {
    if (!admin) return;
    return this.emitEvent({
      eventId: `ACCOUNT_LOCKED_${admin.id}_${Date.now()}`,
      title: 'RecruTrain — Security Alert: Account Locked',
      body: `Account ${admin.email} has been temporarily locked for ${lockoutMinutes} minutes due to ${failedAttempts || 'multiple'} consecutive failed login attempts.`,
      category: 'SECURITY',
      deepLinkUrl: '/teams/members',
      metadata: {
        eventType: 'ACCOUNT_LOCKED',
        targetAdminId: admin.id,
        targetEmail: admin.email,
        failedAttempts,
        ipAddress,
      },
      module: null, // Delivered platform-wide to Super Admins & platform administrators
      action: 'READ',
    });
  }
}
