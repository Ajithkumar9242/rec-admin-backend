import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { assertTestDatabase } from './dbSafetyGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

if (isTest) {
  process.env.NODE_ENV = 'test';
  const explicitlyProvidedUrl = process.env.DATABASE_URL;
  if (explicitlyProvidedUrl) {
    // If caller explicitly set DATABASE_URL, assert it immediately before any env loading
    assertTestDatabase(explicitlyProvidedUrl);
  }
  // Load .env.test (only override if an explicit test URL was not provided)
  dotenv.config({ path: path.resolve(__dirname, '../../.env.test'), override: !explicitlyProvidedUrl });
} else {
  // Load .env from backend root
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const defaultDatabaseUrl = isTest
  ? 'postgresql://postgres:postgres@localhost:5432/recruitrain_admin_test?schema=public'
  : 'postgresql://postgres:postgres@localhost:5432/recruitrain_admin?schema=public';

const effectiveDatabaseUrl = process.env.DATABASE_URL || defaultDatabaseUrl;

if (isTest) {
  // Hard safety assertion: Abort immediately if database is not explicitly a test database
  assertTestDatabase(effectiveDatabaseUrl);
}

const mfaEncryptionKey = process.env.MFA_ENCRYPTION_KEY || 'e15f27b0e2a966028848a85aa925ea70d33d7c6492e62e3fb433bf1c25e5b599';

if (process.env.NODE_ENV === 'production' && (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.length < 64)) {
  throw new Error('MFA_ENCRYPTION_KEY must be a valid 32-byte hex string (64 characters) in production.');
}

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),
  DATABASE_URL: effectiveDatabaseUrl,
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  SESSION_SECRET: process.env.SESSION_SECRET || 'recruitrain-super-secure-session-secret-change-in-production-min32chars',
  MFA_ENCRYPTION_KEY: mfaEncryptionKey,
  COOKIE_NAME: process.env.COOKIE_NAME || 'recruitrain_admin_sid',
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  COOKIE_SAME_SITE: process.env.COOKIE_SAME_SITE || 'lax',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
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

  // SMTP Settings
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'RecruiTrain Security <security@recruitrain.com>',
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
};
