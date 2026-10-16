import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let transporter = null;

export function getTransporter() {
  if (transporter) return transporter;

  if (env.SMTP_HOST && env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }

  return transporter;
}

export function setTransporter(customTransporter) {
  transporter = customTransporter;
}

export function resetTransporter() {
  transporter = null;
}

/**
 * Sanitize error messages to guarantee no sensitive credentials or tokens are exposed
 */
export function sanitizeErrorMessage(msg) {
  if (!msg) return '';
  let sanitized = String(msg);
  if (env.SMTP_PASS) {
    sanitized = sanitized.replaceAll(env.SMTP_PASS, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Verify SMTP transport connectivity and authentication without dispatching an email
 */
export async function verifySmtpTransport() {
  const mailTransporter = getTransporter();
  if (!mailTransporter) {
    return {
      success: false,
      configured: false,
      error: 'SMTP service is not configured in this environment.',
    };
  }

  try {
    await mailTransporter.verify();
    return {
      success: true,
      configured: true,
    };
  } catch (error) {
    const cleanError = sanitizeErrorMessage(error.message);
    logger.warn({ error: cleanError }, 'SMTP transport verification failed');
    return {
      success: false,
      configured: true,
      error: cleanError,
    };
  }
}

/**
 * Send a safe test email to verify end-to-end delivery
 */
export async function sendTestEmail({ to }) {
  const subject = 'RecruiTrain — SMTP Diagnostic Test Email';
  const html = `
    ${EMAIL_HEADER}
    <p style="font-size: 15px; line-height: 1.5;">This is an automated test email to verify SMTP delivery on RecruiTrain Admin.</p>
    <p style="font-size: 13px; color: #5c7480; line-height: 1.5;">Timestamp: ${new Date().toISOString()}</p>
    ${EMAIL_FOOTER}
  `;
  return dispatchMail({ to, subject, html });
}

/**
 * Check SMTP configuration status without exposing credentials
 */
export function getMailStatus() {
  const configured = Boolean(env.SMTP_HOST && env.SMTP_USER);
  return {
    configured,
    host: configured ? env.SMTP_HOST : null,
    port: configured ? env.SMTP_PORT : null,
    fromName: env.MAIL_FROM_NAME,
    fromAddress: env.MAIL_FROM_ADDRESS,
  };
}

/**
 * Escape HTML to prevent injection in email templates
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const EMAIL_HEADER = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #16313f; background-color: #ffffff; border: 1px solid #dce9ed; border-radius: 8px;">
    <div style="border-bottom: 2px solid #eaf5f8; padding-bottom: 16px; margin-bottom: 24px;">
      <h2 style="color: #16313f; margin: 0; font-size: 20px; font-weight: 700;">RecruiTrain</h2>
      <p style="margin: 4px 0 0; font-size: 13px; color: #5c7480;">Enterprise Recruitment & Talent Assessment</p>
    </div>
`;

const EMAIL_FOOTER = `
    <hr style="border: none; border-top: 1px solid #dce9ed; margin: 24px 0;" />
    <p style="font-size: 12px; color: #5c7480; line-height: 1.5; margin: 0;">
      RecruiTrain Platform Notification &bull; Confidential &bull; Do not forward this email.
    </p>
  </div>
`;

/**
 * Generic mail dispatcher with safety handling
 */
async function dispatchMail({ to, subject, html }) {
  const mailTransporter = getTransporter();

  if (!mailTransporter) {
    logger.warn({ to, subject }, 'SMTP service is not configured. Email logged but not dispatched.');
    return {
      success: false,
      delivered: false,
      error: 'SMTP service is not configured in this environment. Email was not delivered.',
    };
  }

  try {
    const info = await mailTransporter.sendMail({
      from: `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_ADDRESS}>`,
      to,
      subject,
      html,
    });
    logger.info({ to, subject, messageId: info.messageId }, 'Email dispatched successfully via SMTP');
    return { success: true, delivered: true, messageId: info.messageId };
  } catch (error) {
    const cleanError = sanitizeErrorMessage(error.message);
    logger.error({ error: cleanError, to, subject }, 'Failed to deliver email via SMTP');
    return { success: false, delivered: false, error: cleanError };
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail({ to, resetUrl, recipientName }) {
  const safeName = escapeHtml(recipientName || 'Administrator');
  const subject = 'RecruiTrain Admin — Password Reset Request';
  const html = `
    ${EMAIL_HEADER}
    <p style="font-size: 15px; line-height: 1.5;">Hello ${safeName},</p>
    <p style="font-size: 15px; line-height: 1.5;">We received a request to reset the password for your RecruiTrain Admin account.</p>
    <div style="margin: 32px 0;">
      <a href="${resetUrl}" style="background-color: #16313f; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
        Reset Your Password
      </a>
    </div>
    <p style="font-size: 13px; color: #5c7480; line-height: 1.5;">
      This single-use link expires in ${env.PASSWORD_RESET_EXPIRES_MINUTES} minutes. If you did not request a password reset, please ignore this email or contact your Super Administrator immediately.
    </p>
    ${EMAIL_FOOTER}
  `;

  return dispatchMail({ to, subject, html });
}

/**
 * 1. Initial Company Administrator Invitation
 */
export async function sendCompanyAdminInvitationEmail({ to, recipientName, companyName, invitationUrl, expiresHours = 48 }) {
  const safeName = escapeHtml(recipientName || 'Administrator');
  const safeCompany = escapeHtml(companyName);
  const subject = `Welcome to RecruiTrain — Activate Your Company Account for ${companyName}`;

  const html = `
    ${EMAIL_HEADER}
    <p style="font-size: 15px; line-height: 1.5;">Hello ${safeName},</p>
    <p style="font-size: 15px; line-height: 1.5;">
      You have been invited to set up the primary employer account for <strong>${safeCompany}</strong> on RecruiTrain.
    </p>
    <p style="font-size: 15px; line-height: 1.5;">
      Please activate your account and configure your secure administrator credentials by clicking the button below:
    </p>
    <div style="margin: 32px 0;">
      <a href="${invitationUrl}" style="background-color: #16313f; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
        Activate Account &amp; Set Password
      </a>
    </div>
    <p style="font-size: 13px; color: #5c7480; line-height: 1.5;">
      This secure setup link is valid for <strong>${expiresHours} hours</strong>. For security reasons, please do not share this link with anyone.
    </p>
    ${EMAIL_FOOTER}
  `;

  return dispatchMail({ to, subject, html });
}

/**
 * 2. Company Application / Onboarding Submission Acknowledgement
 */
export async function sendCompanySubmissionAckEmail({ to, recipientName, companyName }) {
  const safeName = escapeHtml(recipientName || 'Team');
  const safeCompany = escapeHtml(companyName);
  const subject = `RecruiTrain — Onboarding Application Received for ${companyName}`;

  const html = `
    ${EMAIL_HEADER}
    <p style="font-size: 15px; line-height: 1.5;">Hello ${safeName},</p>
    <p style="font-size: 15px; line-height: 1.5;">
      Thank you for submitting your employer onboarding details for <strong>${safeCompany}</strong>.
    </p>
    <p style="font-size: 15px; line-height: 1.5;">
      Our compliance and verification team is currently reviewing your registration data and submitted company verification documents.
    </p>
    <p style="font-size: 13px; color: #5c7480; line-height: 1.5;">
      Typical verification time is 1-2 business days. You will receive an automated notification as soon as your account review is complete.
    </p>
    ${EMAIL_FOOTER}
  `;

  return dispatchMail({ to, subject, html });
}

/**
 * 3. Company Account Approved / Activated
 */
export async function sendCompanyApprovalEmail({ to, recipientName, companyName, loginUrl }) {
  const safeName = escapeHtml(recipientName || 'Administrator');
  const safeCompany = escapeHtml(companyName);
  const subject = `RecruiTrain — Account Approved for ${companyName}`;
  const targetLoginUrl = loginUrl || env.EMPLOYER_PORTAL_URL;

  const html = `
    ${EMAIL_HEADER}
    <p style="font-size: 15px; line-height: 1.5;">Hello ${safeName},</p>
    <p style="font-size: 15px; line-height: 1.5;">
      Great news! The employer account for <strong>${safeCompany}</strong> has been verified and approved by the RecruiTrain team.
    </p>
    <p style="font-size: 15px; line-height: 1.5;">
      Your organization can now access talent pipelines, post job openings, and utilize candidate assessment workflows.
    </p>
    <div style="margin: 32px 0;">
      <a href="${targetLoginUrl}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
        Log In to Employer Portal
      </a>
    </div>
    ${EMAIL_FOOTER}
  `;

  return dispatchMail({ to, subject, html });
}

/**
 * 4. Company Application Rejection
 */
export async function sendCompanyRejectionEmail({ to, recipientName, companyName, reason }) {
  const safeName = escapeHtml(recipientName || 'Administrator');
  const safeCompany = escapeHtml(companyName);
  const safeReason = escapeHtml(reason || 'Verification requirements not satisfied.');
  const subject = `RecruiTrain — Update on Onboarding for ${companyName}`;

  const html = `
    ${EMAIL_HEADER}
    <p style="font-size: 15px; line-height: 1.5;">Hello ${safeName},</p>
    <p style="font-size: 15px; line-height: 1.5;">
      We have completed our review of the onboarding application for <strong>${safeCompany}</strong>. Unfortunately, we are unable to approve your account at this time.
    </p>
    <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 20px 0;">
      <p style="margin: 0; font-size: 14px; color: #991b1b;">
        <strong>Reason for rejection:</strong><br />
        ${safeReason}
      </p>
    </div>
    <p style="font-size: 13px; color: #5c7480; line-height: 1.5;">
      If you believe this was in error or you have updated documentation to submit, please reply to this email or contact support.
    </p>
    ${EMAIL_FOOTER}
  `;

  return dispatchMail({ to, subject, html });
}

/**
 * 5. Company Account Suspension
 */
export async function sendCompanySuspensionEmail({ to, recipientName, companyName, reason }) {
  const safeName = escapeHtml(recipientName || 'Administrator');
  const safeCompany = escapeHtml(companyName);
  const safeReason = escapeHtml(reason || 'Administrative action or policy violation.');
  const subject = `RecruiTrain — Important Notice: Account Suspended for ${companyName}`;

  const html = `
    ${EMAIL_HEADER}
    <p style="font-size: 15px; line-height: 1.5;">Hello ${safeName},</p>
    <p style="font-size: 15px; line-height: 1.5;">
      Please be advised that the employer account for <strong>${safeCompany}</strong> on RecruiTrain has been suspended.
    </p>
    <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 20px 0;">
      <p style="margin: 0; font-size: 14px; color: #991b1b;">
        <strong>Reason for suspension:</strong><br />
        ${safeReason}
      </p>
    </div>
    <p style="font-size: 13px; color: #5c7480; line-height: 1.5;">
      While suspended, access to candidate profiles, active job listings, and hiring tools is temporarily halted. To appeal or resolve this issue, please contact support.
    </p>
    ${EMAIL_FOOTER}
  `;

  return dispatchMail({ to, subject, html });
}
