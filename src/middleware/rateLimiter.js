import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.NODE_ENV === 'test' ? 1000 : 5, // 5 failed attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many login attempts from this IP. Please try again after 15 minutes.',
  },
  skipSuccessfulRequests: true, // Only count failed logins
});

export const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === 'test' ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many password reset requests. Please try again after 15 minutes.',
  },
});

export const twoFactorLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: env.NODE_ENV === 'test' ? 1000 : 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many two-factor attempts. Please wait 10 minutes.',
  },
});

export const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === 'test' ? 10000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Rate limit exceeded. Please slow down.',
  },
});
