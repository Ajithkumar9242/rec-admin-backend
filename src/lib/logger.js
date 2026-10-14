import pino from 'pino';
import { env } from '../config/env.js';

// Redact sensitive values from all logs
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL || 'info'),
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      'password',
      'passwordHash',
      'newPassword',
      'confirmPassword',
      'totpSecret',
      'code',
      'token',
      'backupCodes',
      '*.password',
      '*.passwordHash',
      '*.totpSecret',
      '*.token'
    ],
    remove: true,
  },
  transport:
    env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});
