import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (env.SMTP_HOST && env.SMTP_USER) {
    transporter = nodemailer.createTransporter({
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

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail({ to, resetUrl, recipientName }) {
  const mailTransporter = getTransporter();

  const subject = 'RecruiTrain Admin — Password Reset Request';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #16313f;">
      <div style="border-bottom: 2px solid #eaf5f8; padding-bottom: 16px; margin-bottom: 24px;">
        <h2 style="color: #16313f; margin: 0; font-size: 20px;">RecruiTrain Admin Portal</h2>
      </div>
      <p style="font-size: 15px; line-height: 1.5;">Hello ${recipientName || 'Administrator'},</p>
      <p style="font-size: 15px; line-height: 1.5;">We received a request to reset the password for your RecruiTrain Admin account.</p>
      <div style="margin: 32px 0;">
        <a href="${resetUrl}" style="background-color: #16313f; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
          Reset Your Password
        </a>
      </div>
      <p style="font-size: 13px; color: #5c7480; line-height: 1.5;">
        This single-use link expires in ${env.PASSWORD_RESET_EXPIRES_MINUTES} minutes. If you did not request a password reset, please ignore this email or contact your Super Administrator immediately.
      </p>
      <hr style="border: none; border-top: 1px solid #dce9ed; margin: 24px 0;" />
      <p style="font-size: 12px; color: #5c7480;">Security notice: Never share this link with anyone.</p>
    </div>
  `;

  if (!mailTransporter) {
    logger.warn({ to }, 'SMTP service is not configured. Reset email cannot be dispatched.');
    return {
      success: false,
      delivered: false,
      error: 'SMTP service is not configured in this environment. Password reset email cannot be delivered.',
    };
  }

  try {
    const info = await mailTransporter.sendMail({
      from: env.SMTP_FROM,
      to,
      subject,
      html,
    });
    logger.info({ to, messageId: info.messageId }, 'Password reset email dispatched successfully via SMTP');
    return { success: true, delivered: true, messageId: info.messageId };
  } catch (error) {
    logger.error({ error: error.message, to }, 'Failed to deliver password reset email via SMTP');
    return { success: false, delivered: false, error: error.message };
  }
}
