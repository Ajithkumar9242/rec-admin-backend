import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { assertTestDatabase } from './dbSafetyGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load the single private local environment file backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

let effectiveDatabaseUrl;

if (isTest) {
  process.env.NODE_ENV = 'test';
  // In test mode, strictly require the dedicated test database
  const testDbUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('_test')
      ? process.env.DATABASE_URL
      : 'postgresql://postgres:postgres@localhost:5432/recruitrain_admin_test?schema=public');

  effectiveDatabaseUrl = testDbUrl;
  process.env.DATABASE_URL = testDbUrl;

  // Hard safety assertion: Abort immediately if database is not explicitly an authorized test database
  assertTestDatabase(effectiveDatabaseUrl);
} else {
  effectiveDatabaseUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/recruitrain_admin?schema=public';
}

const mfaEncryptionKey = process.env.MFA_ENCRYPTION_KEY || 'e15f27b0e2a966028848a85aa925ea70d33d7c6492e62e3fb433bf1c25e5b599';

if (process.env.NODE_ENV === 'production' && (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.length < 64)) {
  throw new Error('MFA_ENCRYPTION_KEY must be a valid 32-byte hex string (64 characters) in production.');
}

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: isTest ? parseInt(process.env.TEST_PORT || '5001', 10) : parseInt(process.env.PORT || '5000', 10),
  DATABASE_URL: effectiveDatabaseUrl,
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  SESSION_SECRET: isTest
    ? (process.env.TEST_SESSION_SECRET || 'recruitrain_test_session_secret_min32chars_test_suite_key')
    : (process.env.SESSION_SECRET || 'recruitrain_super_secure_session_secret_replace_in_production_32chars'),
  MFA_ENCRYPTION_KEY: mfaEncryptionKey,
  COOKIE_NAME: isTest
    ? 'recruitrain_admin_sid_test'
    : (process.env.COOKIE_NAME || 'recruitrain_admin_sid'),
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  COOKIE_SAME_SITE: process.env.COOKIE_SAME_SITE || 'lax',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  
  // Super Admin Bootstrap (configured via environment or CLI flags)
  SUPER_ADMIN_EMAIL: process.env.SUPER_ADMIN_EMAIL || '',
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || '',
  SUPER_ADMIN_NAME: process.env.SUPER_ADMIN_NAME || 'Platform Administrator',

  // Rate Limiting & Account Lockout
  LOGIN_MAX_FAILED_ATTEMPTS: parseInt(process.env.LOGIN_MAX_FAILED_ATTEMPTS || '5', 10),
  ACCOUNT_LOCKOUT_MINUTES: parseInt(process.env.ACCOUNT_LOCKOUT_MINUTES || '15', 10),
  PASSWORD_RESET_EXPIRES_MINUTES: parseInt(process.env.PASSWORD_RESET_EXPIRES_MINUTES || '60', 10),

  // Stripe Configuration
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || '',

  // SMTP Settings
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'RecruiTrain Security <security@recruitrain.com>',
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
};
