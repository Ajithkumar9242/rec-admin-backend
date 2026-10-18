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

// Helper function to validate employer application base URL
export function validateEmployerAppUrl(url, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== 'production') {
    return (url && url.trim()) ? url.trim().replace(/\/+$/, '') : 'http://localhost:5174';
  }

  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new Error('EMPLOYER_APP_URL is strictly required in production environment.');
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`EMPLOYER_APP_URL "${url}" is not a valid URL.`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`EMPLOYER_APP_URL "${url}" must use HTTP or HTTPS protocol.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopbacks = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (loopbacks.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(
      `EMPLOYER_APP_URL cannot point to localhost, loopback, or private origin in production ("${url}"). Please configure a valid public origin.`
    );
  }

  return url.trim().replace(/\/+$/, '');
}

// Helper function to validate candidate application base URL
export function validateCandidateAppUrl(url, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== 'production') {
    return (url && url.trim()) ? url.trim().replace(/\/+$/, '') : 'http://localhost:5173';
  }

  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new Error('CANDIDATE_APP_URL is strictly required in production environment.');
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`CANDIDATE_APP_URL "${url}" is not a valid URL.`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`CANDIDATE_APP_URL "${url}" must use HTTP or HTTPS protocol.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopbacks = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (loopbacks.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(
      `CANDIDATE_APP_URL cannot point to localhost, loopback, or private origin in production ("${url}"). Please configure a valid public origin.`
    );
  }

  return url.trim().replace(/\/+$/, '');
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
  ALLOWED_ORIGINS: (() => {
    const defaultOrigins = [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ];
    const origins = (process.env.ALLOWED_ORIGINS || defaultOrigins.join(','))
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);

    try {
      const empUrl = process.env.EMPLOYER_APP_URL || process.env.EMPLOYER_PORTAL_URL;
      if (empUrl) {
        const empOrigin = new URL(empUrl.trim()).origin;
        if (!origins.includes(empOrigin)) {
          origins.push(empOrigin);
        }
      }
      const candUrl = process.env.CANDIDATE_APP_URL || process.env.CANDIDATE_PORTAL_URL;
      if (candUrl) {
        const candOrigin = new URL(candUrl.trim()).origin;
        if (!origins.includes(candOrigin)) {
          origins.push(candOrigin);
        }
      }
    } catch {
      // Ignore URL parse errors here as validate URL helpers will handle validation
    }
    return origins;
  })(),
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
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || 'RecruiTrain Platform',
  MAIL_FROM_ADDRESS: process.env.MAIL_FROM_ADDRESS || 'notifications@recruitrain.com',

  // Cloudinary Configuration
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
  CLOUDINARY_FOLDER: process.env.CLOUDINARY_FOLDER || 'recruitrain',

  // Employer Portal & Activation URLs
  EMPLOYER_APP_URL: validateEmployerAppUrl(
    process.env.EMPLOYER_APP_URL || process.env.EMPLOYER_PORTAL_URL,
    process.env.NODE_ENV
  ),
  EMPLOYER_PORTAL_URL: validateEmployerAppUrl(
    process.env.EMPLOYER_APP_URL || process.env.EMPLOYER_PORTAL_URL,
    process.env.NODE_ENV
  ),
  EMPLOYER_ACTIVATION_PATH: process.env.EMPLOYER_ACTIVATION_PATH || '/activate',
  COMPANY_INVITATION_EXPIRES_HOURS: parseInt(process.env.COMPANY_INVITATION_EXPIRES_HOURS || '48', 10),

  // Candidate Portal & Activation URLs
  CANDIDATE_APP_URL: validateCandidateAppUrl(
    process.env.CANDIDATE_APP_URL || process.env.CANDIDATE_PORTAL_URL,
    process.env.NODE_ENV
  ),
  CANDIDATE_PORTAL_URL: validateCandidateAppUrl(
    process.env.CANDIDATE_APP_URL || process.env.CANDIDATE_PORTAL_URL,
    process.env.NODE_ENV
  ),
  CANDIDATE_ACTIVATION_PATH: process.env.CANDIDATE_ACTIVATION_PATH || '/activate',
  CANDIDATE_INVITATION_EXPIRES_HOURS: parseInt(process.env.CANDIDATE_INVITATION_EXPIRES_HOURS || '48', 10),
};

export function buildEmployerActivationUrl(rawToken, options = {}) {
  const baseUrl = options.baseUrl || env.EMPLOYER_APP_URL || env.EMPLOYER_PORTAL_URL || 'http://localhost:5174';
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const activationPath = (options.path || env.EMPLOYER_ACTIVATION_PATH || '/activate').replace(/^\/?/, '/');
  return `${cleanBase}${activationPath}?token=${encodeURIComponent(rawToken)}`;
}

export function buildCandidateActivationUrl(rawToken, options = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  let baseUrl = options.baseUrl || env.CANDIDATE_APP_URL || env.CANDIDATE_PORTAL_URL;
  if (!baseUrl) {
    if (isProd) {
      throw new Error('CANDIDATE_APP_URL is strictly required to build candidate activation links in production.');
    }
    baseUrl = 'http://localhost:5173';
  }
  if (isProd) {
    try {
      const parsed = new URL(baseUrl);
      const loopbacks = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
      if (loopbacks.has(parsed.hostname.toLowerCase()) || parsed.hostname.endsWith('.localhost') || parsed.hostname.endsWith('.local')) {
        throw new Error(`Production candidate activation link cannot point to localhost or loopback origin ("${baseUrl}"). Please configure a valid public origin.`);
      }
    } catch (urlErr) {
      if (urlErr.message.includes('Production candidate activation link')) {
        throw urlErr;
      }
      throw new Error(`Invalid candidate activation base URL "${baseUrl}": ${urlErr.message}`);
    }
  }
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const activationPath = (options.path || env.CANDIDATE_ACTIVATION_PATH || '/activate').replace(/^\/?/, '/');
  return `${cleanBase}${activationPath}?token=${encodeURIComponent(rawToken)}`;
}

