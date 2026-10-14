import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/recruitrain_admin?schema=public',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  SESSION_SECRET: process.env.SESSION_SECRET || 'recruitrain-super-secure-session-secret-change-in-production-min32chars',
  COOKIE_NAME: process.env.COOKIE_NAME || 'recruitrain_admin_sid',
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  COOKIE_SAME_SITE: process.env.COOKIE_SAME_SITE || 'lax',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  
  // Super Admin Bootstrap
  SUPER_ADMIN_EMAIL: process.env.SUPER_ADMIN_EMAIL || 'admin@recruitrain.com',
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || '',
  SUPER_ADMIN_NAME: process.env.SUPER_ADMIN_NAME || 'Super Administrator',

  // Rate Limiting & Account Lockout
  LOGIN_MAX_FAILED_ATTEMPTS: parseInt(process.env.LOGIN_MAX_FAILED_ATTEMPTS || '5', 10),
  ACCOUNT_LOCKOUT_MINUTES: parseInt(process.env.ACCOUNT_LOCKOUT_MINUTES || '15', 10),
  PASSWORD_RESET_EXPIRES_MINUTES: parseInt(process.env.PASSWORD_RESET_EXPIRES_MINUTES || '60', 10),

  // SMTP Settings
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'RecruiTrain Security <security@recruitrain.com>',
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
};
