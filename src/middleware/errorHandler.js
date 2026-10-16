import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export function errorHandler(err, req, res, next) {
  const statusCode = err.status || err.statusCode || 500;

  if (statusCode >= 500) {
    logger.error(
      {
        error: err.message,
        stack: env.NODE_ENV === 'development' ? err.stack : undefined,
        url: req.originalUrl,
        method: req.method,
      },
      'Unhandled request error'
    );
  } else {
    logger.warn(
      {
        error: err.message,
        code: err.code,
        field: err.field,
        statusCode,
        url: req.originalUrl,
        method: req.method,
      },
      'Client request error or validation conflict'
    );
  }

  const message =
    statusCode === 500 && env.NODE_ENV === 'production'
      ? 'An unexpected error occurred. Please try again later.'
      : err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(err.code && { code: err.code }),
    ...(err.field && { field: err.field }),
    ...(err.issues && { issues: err.issues }),
    ...(env.NODE_ENV === 'development' && { details: err.stack }),
  });
}
