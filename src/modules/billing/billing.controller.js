/**
 * Production-Oriented Billing & Subscriptions Controller
 *
 * Implements strict server-side validation, decimal arithmetic, audit logging,
 * and decoupling of presentation from backend operations.
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { calculateSubscriptionEndDate, calculateNextBillingDate } from './billingDateUtils.js';
import { calculateInvoiceTotals } from './taxService.js';
import { generateNextInvoiceNumber } from './invoiceNumberService.js';
import { logBillingAction } from './billingAudit.service.js';
import { EntitlementService, QuotaExceededError, SubscriptionError } from './entitlement.service.js';
import { stripeService } from './stripe.service.js';

export class BillingController {
  // ==========================================
  // PLANS MANAGEMENT
  // ==========================================

  static async listPlans(req, res) {
    try {
      const { status, includeArchived } = req.query;
      const where = {};

      if (status) {
        where.status = status;
      } else if (includeArchived !== 'true') {
        where.status = { in: ['ACTIVE', 'INACTIVE'] };
      }

      const plans = await prisma.plan.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: {
          _count: {
            select: { subscriptions: true },
          },
        },
      });

      return res.status(200).json({
        success: true,
        data: plans,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to list plans');
      return res.status(500).json({ success: false, error: 'Internal server error listing plans.' });
    }
  }

  static async getPlan(req, res) {
    try {
      const { id } = req.params;
      const plan = await prisma.plan.findUnique({
        where: { id },
        include: {
          _count: { select: { subscriptions: true } },
        },
      });

      if (!plan) {
        return res.status(404).json({ success: false, error: 'Plan not found.' });
      }

      return res.status(200).json({ success: true, data: plan });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Internal server error fetching plan.' });
    }
  }

  static async createPlan(req, res) {
    try {
      const payload = req.body;

      const plan = await prisma.plan.create({
        data: {
          name: payload.name,
          description: payload.description,
          price: payload.price,
          offerPrice: payload.offerPrice ?? null,
          currency: payload.currency || 'EUR',
          billingInterval: payload.billingInterval,
          candidateAccessLimit: payload.candidateAccessLimit,
          jobPostingLimit: payload.jobPostingLimit,
          teamMemberLimit: payload.teamMemberLimit,
          status: payload.status || 'ACTIVE',
        },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'PLAN',
        entityId: plan.id,
        action: 'CREATE',
        actor: req.admin?.email || 'ADMIN',
        details: { plan },
      });

      return res.status(201).json({
        success: true,
        message: 'Plan created successfully.',
        data: plan,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create plan');
      return res.status(500).json({ success: false, error: 'Internal server error creating plan.' });
    }
  }

  static async updatePlan(req, res) {
    try {
      const { id } = req.params;
      const payload = req.body;

      const existing = await prisma.plan.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Plan not found.' });
      }

      if (existing.status === 'ARCHIVED') {
        return res.status(400).json({ success: false, error: 'Cannot modify an archived plan.' });
      }

      const updated = await prisma.plan.update({
        where: { id },
        data: {
          name: payload.name ?? undefined,
          description: payload.description !== undefined ? payload.description : undefined,
          price: payload.price !== undefined ? payload.price : undefined,
          offerPrice: payload.offerPrice !== undefined ? payload.offerPrice : undefined,
          currency: payload.currency ?? undefined,
          billingInterval: payload.billingInterval ?? undefined,
          candidateAccessLimit: payload.candidateAccessLimit !== undefined ? payload.candidateAccessLimit : undefined,
          jobPostingLimit: payload.jobPostingLimit !== undefined ? payload.jobPostingLimit : undefined,
          teamMemberLimit: payload.teamMemberLimit !== undefined ? payload.teamMemberLimit : undefined,
          status: payload.status ?? undefined,
        },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'PLAN',
        entityId: id,
        action: 'UPDATE',
        actor: req.admin?.email || 'ADMIN',
        details: { before: existing, after: updated },
      });

      return res.status(200).json({
        success: true,
        message: 'Plan updated successfully.',
        data: updated,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to update plan');
      return res.status(500).json({ success: false, error: 'Internal server error updating plan.' });
    }
  }

  static async togglePlanStatus(req, res) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const plan = await prisma.plan.findUnique({ where: { id } });
      if (!plan) {
        return res.status(404).json({ success: false, error: 'Plan not found.' });
      }

      const updated = await prisma.plan.update({
        where: { id },
        data: { status },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'PLAN',
        entityId: id,
        action: status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE',
        actor: req.admin?.email || 'ADMIN',
        details: { previousStatus: plan.status, newStatus: status },
      });

      return res.status(200).json({
        success: true,
        message: `Plan status updated to ${status}.`,
        data: updated,
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to update plan status.' });
    }
  }

  static async archivePlan(req, res) {
    try {
      const { id } = req.params;

      const plan = await prisma.plan.findUnique({
        where: { id },
        include: {
          _count: {
            select: { subscriptions: true },
          },
        },
      });

      if (!plan) {
        return res.status(404).json({ success: false, error: 'Plan not found.' });
      }

      // Check if plan is referenced by active or past subscriptions
      if (plan._count.subscriptions > 0) {
        // Safe archive: Never physically delete historical records
        const archived = await prisma.plan.update({
          where: { id },
          data: {
            status: 'ARCHIVED',
            deletedAt: new Date(),
          },
        });

        await logBillingAction({
          adminId: req.admin?.id,
          entityType: 'PLAN',
          entityId: id,
          action: 'ARCHIVE_SAFE',
          actor: req.admin?.email || 'ADMIN',
          details: { note: 'Plan archived. Preserved because subscriptions reference it.' },
        });

        return res.status(200).json({
          success: true,
          message: 'Plan has associated historical subscriptions and has been safely archived.',
          data: archived,
        });
      }

      // If zero subscriptions ever existed, soft delete
      const deleted = await prisma.plan.update({
        where: { id },
        data: {
          status: 'ARCHIVED',
          deletedAt: new Date(),
        },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'PLAN',
        entityId: id,
        action: 'ARCHIVE',
        actor: req.admin?.email || 'ADMIN',
        details: { note: 'Unreferenced plan archived.' },
      });

      return res.status(200).json({
        success: true,
        message: 'Plan archived successfully.',
        data: deleted,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to archive plan');
      return res.status(500).json({ success: false, error: 'Failed to archive plan.' });
    }
  }

  // ==========================================
  // SUBSCRIPTIONS MANAGEMENT
  // ==========================================

  static async listSubscriptions(req, res) {
    try {
      const { companyId, status, billingInterval } = req.query;
      const where = {};

      if (companyId) where.companyId = companyId;
      if (status) where.status = status;
      if (billingInterval) where.billingInterval = billingInterval;

      const subscriptions = await prisma.subscription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          company: {
            select: { id: true, name: true, legalName: true, taxId: true, billingEmail: true },
          },
          plan: {
            select: { id: true, name: true, price: true, currency: true, billingInterval: true },
          },
        },
      });

      return res.status(200).json({
        success: true,
        data: subscriptions,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to list subscriptions');
      return res.status(500).json({ success: false, error: 'Internal server error listing subscriptions.' });
    }
  }

  static async getSubscription(req, res) {
    try {
      const { id } = req.params;
      const subscription = await prisma.subscription.findUnique({
        where: { id },
        include: {
          company: true,
          plan: true,
          invoices: {
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      });

      if (!subscription) {
        return res.status(404).json({ success: false, error: 'Subscription not found.' });
      }

      const usageSnapshot = await EntitlementService.getCompanySubscriptionUsage(subscription.companyId);

      return res.status(200).json({
        success: true,
        data: {
          ...subscription,
          usageSnapshot,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch subscription details.' });
    }
  }

  static async createSubscription(req, res) {
    try {
      const {
        companyId,
        planId,
        startDate: inputStartDate,
        customCandidateAccessLimit,
        customJobPostingLimit,
        customTeamMemberLimit,
      } = req.body;

      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) {
        return res.status(404).json({ success: false, error: 'Selected employer not found.' });
      }

      const plan = await prisma.plan.findUnique({ where: { id: planId } });
      if (!plan) {
        return res.status(404).json({ success: false, error: 'Selected plan not found.' });
      }

      if (plan.status !== 'ACTIVE') {
        return res.status(400).json({ success: false, error: 'Cannot subscribe to an inactive or archived plan.' });
      }

      const startDate = inputStartDate ? new Date(inputStartDate) : new Date();
      const endDate = calculateSubscriptionEndDate(startDate, plan.billingInterval);
      const nextBillingDate = calculateNextBillingDate(startDate, plan.billingInterval);

      const candidateLimit = customCandidateAccessLimit !== undefined ? customCandidateAccessLimit : plan.candidateAccessLimit;
      const jobLimit = customJobPostingLimit !== undefined ? customJobPostingLimit : plan.jobPostingLimit;
      const teamLimit = customTeamMemberLimit !== undefined ? customTeamMemberLimit : plan.teamMemberLimit;

      const subscription = await prisma.$transaction(async (tx) => {
        // Cancel any existing active subscriptions for this company to prevent double subscription
        await tx.subscription.updateMany({
          where: {
            companyId,
            status: 'ACTIVE',
          },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancellationReason: 'Superseded by new subscription creation',
          },
        });

        const created = await tx.subscription.create({
          data: {
            companyId,
            planId,
            status: 'ACTIVE',
            startDate,
            endDate,
            nextBillingDate,
            billingInterval: plan.billingInterval,
            currency: plan.currency,
            price: plan.offerPrice ?? plan.price,
            candidateAccessLimit: candidateLimit,
            jobPostingLimit: jobLimit,
            teamMemberLimit: teamLimit,
          },
          include: {
            company: true,
            plan: true,
          },
        });

        // Issue initial invoice
        const invoiceNumber = await generateNextInvoiceNumber(tx);
        const totals = calculateInvoiceTotals(plan.offerPrice ?? plan.price, null, company.country);

        const dueDate = new Date(startDate.getTime());
        dueDate.setDate(dueDate.getDate() + 14); // 14-day default payment window

        await tx.invoice.create({
          data: {
            invoiceNumber,
            companyId,
            subscriptionId: created.id,
            dueDate,
            currency: plan.currency,
            netAmount: totals.netAmount,
            taxRate: totals.taxRate,
            taxAmount: totals.taxAmount,
            grossTotal: totals.grossTotal,
            status: 'OPEN',
            legalNameSnapshot: company.legalName || company.name,
            taxIdSnapshot: company.taxId,
            billingAddressSnapshot: company.billingAddress,
          },
        });

        await logBillingAction({
          adminId: req.admin?.id,
          entityType: 'SUBSCRIPTION',
          entityId: created.id,
          action: 'CREATE',
          actor: req.admin?.email || 'ADMIN',
          details: { subscription: created, invoiceNumber },
          tx,
        });

        return created;
      });

      return res.status(201).json({
        success: true,
        message: 'Subscription created and invoice generated successfully.',
        data: subscription,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create subscription');
      return res.status(500).json({ success: false, error: 'Internal server error creating subscription.' });
    }
  }

  static async updateEntitlements(req, res) {
    try {
      const { id } = req.params;
      const { candidateAccessLimit, jobPostingLimit, teamMemberLimit, confirmBelowUsage } = req.body;

      const subscription = await prisma.subscription.findUnique({
        where: { id },
        include: { company: true },
      });

      if (!subscription) {
        return res.status(404).json({ success: false, error: 'Subscription not found.' });
      }

      // Check if reducing candidate access below current actual usage
      if (candidateAccessLimit < subscription.candidateAccessUsage) {
        if (!confirmBelowUsage) {
          return res.status(400).json({
            success: false,
            code: 'CONFIRMATION_REQUIRED_BELOW_USAGE',
            error: `New limit (${candidateAccessLimit}) is lower than current usage (${subscription.candidateAccessUsage}). Explicit administrator confirmation is required.`,
            currentUsage: subscription.candidateAccessUsage,
            proposedLimit: candidateAccessLimit,
          });
        }
      }

      const updated = await prisma.subscription.update({
        where: { id },
        data: {
          candidateAccessLimit,
          jobPostingLimit,
          teamMemberLimit,
        },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'ENTITLEMENT',
        entityId: id,
        action: 'ADJUST_ENTITLEMENT',
        actor: req.admin?.email || 'ADMIN',
        details: {
          before: {
            candidateAccessLimit: subscription.candidateAccessLimit,
            jobPostingLimit: subscription.jobPostingLimit,
            teamMemberLimit: subscription.teamMemberLimit,
            candidateAccessUsage: subscription.candidateAccessUsage,
          },
          after: {
            candidateAccessLimit,
            jobPostingLimit,
            teamMemberLimit,
          },
          confirmedBelowUsage: confirmBelowUsage || false,
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Entitlements updated successfully.',
        data: updated,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to update entitlements');
      return res.status(500).json({ success: false, error: 'Failed to update subscription entitlements.' });
    }
  }

  static async upgradeSubscription(req, res) {
    try {
      const { id } = req.params;
      const { newPlanId } = req.body;

      const subscription = await prisma.subscription.findUnique({
        where: { id },
        include: { company: true, plan: true },
      });

      if (!subscription) {
        return res.status(404).json({ success: false, error: 'Subscription not found.' });
      }

      const newPlan = await prisma.plan.findUnique({ where: { id: newPlanId } });
      if (!newPlan) {
        return res.status(404).json({ success: false, error: 'Target plan not found.' });
      }

      if (newPlan.status !== 'ACTIVE') {
        return res.status(400).json({ success: false, error: 'Target plan is not active.' });
      }

      const now = new Date();
      const newEndDate = calculateSubscriptionEndDate(now, newPlan.billingInterval);
      const newNextBilling = calculateNextBillingDate(now, newPlan.billingInterval);

      const isUpgrade = Number(newPlan.price) >= Number(subscription.price);

      const updated = await prisma.$transaction(async (tx) => {
        const sub = await tx.subscription.update({
          where: { id },
          data: {
            planId: newPlan.id,
            price: newPlan.offerPrice ?? newPlan.price,
            currency: newPlan.currency,
            billingInterval: newPlan.billingInterval,
            candidateAccessLimit: newPlan.candidateAccessLimit,
            jobPostingLimit: newPlan.jobPostingLimit,
            teamMemberLimit: newPlan.teamMemberLimit,
            endDate: newEndDate,
            nextBillingDate: newNextBilling,
            status: 'ACTIVE',
          },
        });

        // Issue upgrade invoice if price > 0
        if (Number(newPlan.offerPrice ?? newPlan.price) > 0) {
          const invNum = await generateNextInvoiceNumber(tx);
          const totals = calculateInvoiceTotals(newPlan.offerPrice ?? newPlan.price, null, subscription.company.country);

          await tx.invoice.create({
            data: {
              invoiceNumber: invNum,
              companyId: subscription.companyId,
              subscriptionId: id,
              dueDate: new Date(Date.now() + 14 * 86400000),
              currency: newPlan.currency,
              netAmount: totals.netAmount,
              taxRate: totals.taxRate,
              taxAmount: totals.taxAmount,
              grossTotal: totals.grossTotal,
              status: 'OPEN',
              legalNameSnapshot: subscription.company.legalName || subscription.company.name,
              taxIdSnapshot: subscription.company.taxId,
            },
          });
        }

        await logBillingAction({
          adminId: req.admin?.id,
          entityType: 'SUBSCRIPTION',
          entityId: id,
          action: isUpgrade ? 'UPGRADE' : 'DOWNGRADE',
          actor: req.admin?.email || 'ADMIN',
          details: {
            fromPlan: subscription.plan.name,
            toPlan: newPlan.name,
            newLimits: {
              candidateAccess: newPlan.candidateAccessLimit,
              jobs: newPlan.jobPostingLimit,
              team: newPlan.teamMemberLimit,
            },
          },
          tx,
        });

        return sub;
      });

      return res.status(200).json({
        success: true,
        message: `Subscription successfully ${isUpgrade ? 'upgraded' : 'downgraded'} to ${newPlan.name}.`,
        data: updated,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to change subscription plan');
      return res.status(500).json({ success: false, error: 'Failed to update plan.' });
    }
  }

  static async cancelSubscription(req, res) {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const subscription = await prisma.subscription.findUnique({ where: { id } });
      if (!subscription) {
        return res.status(404).json({ success: false, error: 'Subscription not found.' });
      }

      if (subscription.status === 'CANCELLED') {
        return res.status(400).json({ success: false, error: 'Subscription is already cancelled.' });
      }

      const updated = await prisma.subscription.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: reason || 'Cancelled by administrator',
        },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'SUBSCRIPTION',
        entityId: id,
        action: 'CANCEL',
        actor: req.admin?.email || 'ADMIN',
        details: { reason: reason || 'No reason provided' },
      });

      return res.status(200).json({
        success: true,
        message: 'Subscription has been cancelled.',
        data: updated,
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to cancel subscription.' });
    }
  }

  static async revokeSubscription(req, res) {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const subscription = await prisma.subscription.findUnique({ where: { id } });
      if (!subscription) {
        return res.status(404).json({ success: false, error: 'Subscription not found.' });
      }

      if (subscription.status === 'REVOKED') {
        return res.status(400).json({ success: false, error: 'Subscription is already revoked.' });
      }

      const updated = await prisma.subscription.update({
        where: { id },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: reason,
        },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'SUBSCRIPTION',
        entityId: id,
        action: 'REVOKE',
        actor: req.admin?.email || 'ADMIN',
        details: { reason },
      });

      return res.status(200).json({
        success: true,
        message: 'Subscription has been revoked with immediate effect.',
        data: updated,
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to revoke subscription.' });
    }
  }

  static async getSubscriptionHistory(req, res) {
    try {
      const { id } = req.params;

      const logs = await prisma.billingAuditLog.findMany({
        where: {
          OR: [
            { entityType: 'SUBSCRIPTION', entityId: id },
            { entityType: 'ENTITLEMENT', entityId: id },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.status(200).json({ success: true, data: logs });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch subscription history.' });
    }
  }

  // ==========================================
  // INVOICES & PAYMENTS MANAGEMENT
  // ==========================================

  static async listInvoices(req, res) {
    try {
      const { status, companyId, search, page = 1, limit = 20 } = req.query;
      const where = {};

      if (status) where.status = status;
      if (companyId) where.companyId = companyId;
      if (search) {
        where.OR = [
          { invoiceNumber: { contains: search, mode: 'insensitive' } },
          { legalNameSnapshot: { contains: search, mode: 'insensitive' } },
          { company: { name: { contains: search, mode: 'insensitive' } } },
        ];
      }

      const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
      const take = parseInt(limit, 10);

      const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          include: {
            company: { select: { id: true, name: true, billingEmail: true } },
            payments: { orderBy: { createdAt: 'desc' } },
          },
        }),
        prisma.invoice.count({ where }),
      ]);

      return res.status(200).json({
        success: true,
        data: invoices,
        pagination: {
          total,
          page: parseInt(page, 10),
          limit: parseInt(limit, 10),
          totalPages: Math.ceil(total / take),
        },
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to list invoices');
      return res.status(500).json({ success: false, error: 'Internal server error listing invoices.' });
    }
  }

  static async getInvoice(req, res) {
    try {
      const { id } = req.params;
      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: {
          company: true,
          subscription: { include: { plan: true } },
          payments: { orderBy: { createdAt: 'desc' } },
        },
      });

      if (!invoice) {
        return res.status(404).json({ success: false, error: 'Invoice not found.' });
      }

      return res.status(200).json({ success: true, data: invoice });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch invoice details.' });
    }
  }

  static async createInvoice(req, res) {
    try {
      const { companyId, subscriptionId, netAmount, currency, customTaxRate, dueDate: inputDueDate } = req.body;

      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) {
        return res.status(404).json({ success: false, error: 'Employer not found.' });
      }

      const totals = calculateInvoiceTotals(netAmount, customTaxRate, company.country);
      const invoiceNumber = await generateNextInvoiceNumber();

      const dueDate = inputDueDate ? new Date(inputDueDate) : new Date(Date.now() + 14 * 86400000);

      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber,
          companyId,
          subscriptionId: subscriptionId || null,
          dueDate,
          currency: currency || 'EUR',
          netAmount: totals.netAmount,
          taxRate: totals.taxRate,
          taxAmount: totals.taxAmount,
          grossTotal: totals.grossTotal,
          status: 'OPEN',
          legalNameSnapshot: company.legalName || company.name,
          taxIdSnapshot: company.taxId,
          billingAddressSnapshot: company.billingAddress,
        },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'INVOICE',
        entityId: invoice.id,
        action: 'CREATE',
        actor: req.admin?.email || 'ADMIN',
        details: { invoiceNumber, grossTotal: totals.grossTotal, currency: invoice.currency },
      });

      return res.status(201).json({
        success: true,
        message: 'Invoice generated successfully.',
        data: invoice,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create invoice');
      return res.status(500).json({ success: false, error: 'Failed to create invoice.' });
    }
  }

  static async recordPayment(req, res) {
    try {
      const { id } = req.params;
      const { amount, paymentMethod, reference } = req.body;

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { payments: true },
      });

      if (!invoice) {
        return res.status(404).json({ success: false, error: 'Invoice not found.' });
      }

      if (invoice.status === 'PAID') {
        return res.status(400).json({ success: false, error: 'Invoice has already been marked as PAID.' });
      }

      if (invoice.status === 'VOID') {
        return res.status(400).json({ success: false, error: 'Cannot record payment for a voided invoice.' });
      }

      const payment = await prisma.$transaction(async (tx) => {
        const createdPayment = await tx.payment.create({
          data: {
            invoiceId: id,
            amount,
            currency: invoice.currency,
            status: 'SUCCEEDED',
            paymentMethod,
            errorMessage: reference ? `Ref: ${reference}` : null,
            paidAt: new Date(),
          },
        });

        // Calculate total successful payments recorded
        const totalPaid = invoice.payments
          .filter((p) => p.status === 'SUCCEEDED')
          .reduce((sum, p) => sum + Number(p.amount), 0) + Number(amount);

        if (totalPaid >= Number(invoice.grossTotal)) {
          await tx.invoice.update({
            where: { id },
            data: {
              status: 'PAID',
              paidDate: new Date(),
            },
          });
        }

        await logBillingAction({
          adminId: req.admin?.id,
          entityType: 'PAYMENT',
          entityId: createdPayment.id,
          action: 'RECORD_PAYMENT',
          actor: req.admin?.email || 'ADMIN',
          details: { invoiceId: id, amount, paymentMethod, reference },
          tx,
        });

        return createdPayment;
      });

      return res.status(201).json({
        success: true,
        message: 'Payment recorded successfully.',
        data: payment,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to record payment');
      return res.status(500).json({ success: false, error: 'Failed to record payment.' });
    }
  }

  static async voidInvoice(req, res) {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) {
        return res.status(404).json({ success: false, error: 'Invoice not found.' });
      }

      if (invoice.status === 'PAID') {
        return res.status(400).json({ success: false, error: 'Cannot void an invoice that has already been marked as PAID.' });
      }

      if (invoice.status === 'VOID') {
        return res.status(400).json({ success: false, error: 'Invoice is already voided.' });
      }

      const updated = await prisma.invoice.update({
        where: { id },
        data: {
          status: 'VOID',
          voidReason: reason,
          voidedAt: new Date(),
        },
      });

      await logBillingAction({
        adminId: req.admin?.id,
        entityType: 'INVOICE',
        entityId: id,
        action: 'VOID_INVOICE',
        actor: req.admin?.email || 'ADMIN',
        details: { invoiceNumber: invoice.invoiceNumber, reason },
      });

      return res.status(200).json({
        success: true,
        message: 'Invoice has been voided.',
        data: updated,
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to void invoice.' });
    }
  }

  // ==========================================
  // COMPANIES / EMPLOYERS (Minimal Canonical)
  // ==========================================

  static async listCompanies(req, res) {
    try {
      const { search } = req.query;
      const where = { status: 'ACTIVE' };

      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { legalName: { contains: search, mode: 'insensitive' } },
          { taxId: { contains: search, mode: 'insensitive' } },
        ];
      }

      const companies = await prisma.company.findMany({
        where,
        orderBy: { name: 'asc' },
        take: 50,
      });

      return res.status(200).json({ success: true, data: companies });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to search employers.' });
    }
  }

  static async createCompany(req, res) {
    try {
      const payload = req.body;
      const company = await prisma.company.create({
        data: {
          name: payload.name,
          legalName: payload.legalName || null,
          taxId: payload.taxId || null,
          billingEmail: payload.billingEmail || null,
          billingAddress: payload.billingAddress || null,
          country: payload.country || 'DE',
          status: 'ACTIVE',
        },
      });

      return res.status(201).json({
        success: true,
        message: 'Employer entity created successfully.',
        data: company,
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to create employer entity.' });
    }
  }

  // ==========================================
  // BILLING ANALYTICS & REPORTS
  // ==========================================

  static async getAnalytics(req, res) {
    try {
      const { from, to, groupBy = 'month', currency } = req.query;

      const dateFilter = {};
      if (from) dateFilter.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setUTCHours(23, 59, 59, 999);
        dateFilter.lte = toDate;
      }

      const subWhere = { status: 'ACTIVE' };
      if (Object.keys(dateFilter).length > 0) {
        subWhere.createdAt = dateFilter;
      }

      // 1. Subscription Metrics
      const [
        totalActiveSubscriptions,
        newSubscriptionsInPeriod,
        plansDistribution,
        cancelledCount,
      ] = await Promise.all([
        prisma.subscription.count({ where: { status: 'ACTIVE' } }),
        prisma.subscription.count({ where: subWhere }),
        prisma.subscription.groupBy({
          by: ['planId'],
          where: { status: 'ACTIVE' },
          _count: { id: true },
        }),
        prisma.subscription.count({
          where: {
            status: 'CANCELLED',
            ...(Object.keys(dateFilter).length > 0 ? { cancelledAt: dateFilter } : {}),
          },
        }),
      ]);

      // Enrich plan distribution with plan names
      const planIds = plansDistribution.map((p) => p.planId);
      const plans = await prisma.plan.findMany({
        where: { id: { in: planIds } },
        select: { id: true, name: true, billingInterval: true },
      });
      const planNameMap = Object.fromEntries(plans.map((p) => [p.id, p]));

      const planDistributionReport = plansDistribution.map((p) => ({
        planId: p.planId,
        planName: planNameMap[p.planId]?.name || 'Unknown',
        interval: planNameMap[p.planId]?.billingInterval || 'N/A',
        count: p._count.id,
      }));

      // 2. Revenue Metrics (Separated Collected vs Invoiced)
      const invoiceWhere = Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {};
      if (currency) invoiceWhere.currency = currency;

      const [invoicesSummary, overdueCount] = await Promise.all([
        prisma.invoice.groupBy({
          by: ['currency', 'status'],
          where: invoiceWhere,
          _sum: {
            netAmount: true,
            taxAmount: true,
            grossTotal: true,
          },
          _count: { id: true },
        }),
        prisma.invoice.count({
          where: {
            status: 'OPEN',
            dueDate: { lt: new Date() },
          },
        }),
      ]);

      // 3. Payment attempts & collected revenue
      const paymentWhere = Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {};
      if (currency) paymentWhere.currency = currency;

      const [paymentsSummary, failedPaymentCount] = await Promise.all([
        prisma.payment.groupBy({
          by: ['currency', 'status'],
          where: paymentWhere,
          _sum: { amount: true, refundedAmount: true },
          _count: { id: true },
        }),
        prisma.payment.count({
          where: {
            status: 'FAILED',
            ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
          },
        }),
      ]);

      // Group totals by currency
      const revenueByCurrency = {};

      for (const row of invoicesSummary) {
        const cur = row.currency;
        if (!revenueByCurrency[cur]) {
          revenueByCurrency[cur] = {
            currency: cur,
            invoicedGross: 0,
            collectedGross: 0,
            outstandingGross: 0,
            invoiceCount: 0,
          };
        }

        const gross = Number(row._sum.grossTotal || 0);
        revenueByCurrency[cur].invoicedGross += gross;
        revenueByCurrency[cur].invoiceCount += row._count.id;

        if (row.status === 'PAID') {
          revenueByCurrency[cur].collectedGross += gross;
        } else if (row.status === 'OPEN' || row.status === 'OVERDUE') {
          revenueByCurrency[cur].outstandingGross += gross;
        }
      }

      // Reconcile collected revenue from successful payment records
      for (const row of paymentsSummary) {
        const cur = row.currency;
        if (!revenueByCurrency[cur]) {
          revenueByCurrency[cur] = {
            currency: cur,
            invoicedGross: 0,
            collectedGross: 0,
            outstandingGross: 0,
            invoiceCount: 0,
          };
        }
        if (row.status === 'SUCCEEDED') {
          // Verify actual collected
          const paid = Number(row._sum.amount || 0);
          const refunded = Number(row._sum.refundedAmount || 0);
          revenueByCurrency[cur].collectedGross = Math.max(revenueByCurrency[cur].collectedGross, paid - refunded);
        }
      }

      const stripeStatus = stripeService.getStatus();

      return res.status(200).json({
        success: true,
        data: {
          period: { from: from || null, to: to || null, groupBy },
          paymentProvider: {
            name: 'Stripe',
            status: stripeStatus.mode,
            isLive: stripeStatus.mode === 'live',
            configured: stripeStatus.configured,
            notice: !stripeStatus.configured
              ? 'Payment provider credentials pending. Payment metrics reflect recorded transactions.'
              : null,
          },
          kpis: {
            activeSubscriptions: totalActiveSubscriptions,
            newSubscriptions: newSubscriptionsInPeriod,
            cancelledSubscriptions: cancelledCount,
            overdueInvoices: overdueCount,
            failedPayments: failedPaymentCount,
          },
          planDistribution: planDistributionReport,
          revenueByCurrency: Object.values(revenueByCurrency),
        },
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to compute billing analytics');
      return res.status(500).json({ success: false, error: 'Internal server error computing analytics.' });
    }
  }

  // ==========================================
  // STRIPE CHECKOUT & WEBHOOK
  // ==========================================

  static async getStripeConfig(req, res) {
    try {
      const status = stripeService.getStatus();
      return res.status(200).json({ success: true, data: status });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to retrieve Stripe config.' });
    }
  }

  static async createCheckoutSession(req, res) {
    try {
      const { companyId, planId, subscriptionId, returnUrl } = req.body;

      if (!stripeService.isConfigured()) {
        return res.status(503).json({
          success: false,
          code: 'STRIPE_NOT_CONFIGURED',
          error: 'Stripe integration is pending configuration. Real payment sessions are not available.',
        });
      }

      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) {
        return res.status(404).json({ success: false, error: 'Employer not found.' });
      }

      const plan = await prisma.plan.findUnique({ where: { id: planId } });
      if (!plan || plan.status !== 'ACTIVE') {
        return res.status(400).json({ success: false, error: 'Plan is not active.' });
      }

      const origin = req.headers.origin || 'http://localhost:5173';
      const successUrl = `${origin}/admin/billing/subscriptions?session_id={CHECKOUT_SESSION_ID}&status=success`;
      const cancelUrl = returnUrl || `${origin}/admin/billing/subscriptions?status=cancelled`;

      const session = await stripeService.createCheckoutSession({
        companyId,
        companyName: company.name,
        billingEmail: company.billingEmail,
        plan,
        subscriptionId,
        successUrl,
        cancelUrl,
        idempotencyKey: `sess_${companyId}_${planId}_${Date.now()}`,
      });

      return res.status(200).json({
        success: true,
        data: session,
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create Stripe checkout session');
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async handleWebhook(req, res) {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      return res.status(400).json({ success: false, error: 'Missing stripe-signature header.' });
    }

    try {
      const rawBody = req.rawBody || req.body;
      const event = stripeService.verifyWebhookSignature(rawBody, signature);
      const result = await stripeService.handleWebhookEvent(event);

      return res.status(200).json({ received: true, ...result });
    } catch (err) {
      logger.warn({ error: err.message }, 'Stripe webhook verification or execution error');
      return res.status(400).json({ success: false, error: `Webhook error: ${err.message}` });
    }
  }
}
