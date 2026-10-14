import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export function errorHandler(err, req, res, next) {
  logger.error(
    {
      error: err.message,
      stack: env.NODE_ENV === 'development' ? err.stack : undefined,
      url: req.originalUrl,
      method: req.method,
    },
    'Unhandled request error'
  );

  const statusCode = err.status || err.statusCode || 500;
  const message =
    statusCode === 500 && env.NODE_ENV === 'production'
      ? 'An unexpected error occurred. Please try again later.'
      : err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(env.NODE_ENV === 'development' && { details: err.stack }),
  });
}
