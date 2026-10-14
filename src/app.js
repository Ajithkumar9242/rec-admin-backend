import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { initializeSessionStore } from './lib/redis.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler } from './middleware/errorHandler.js';
import apiRoutes from './routes/index.js';

export function createApp() {
  const app = express();

  // Initialize session store (Redis with graceful Memory fallback)
  const { sessionStore } = initializeSessionStore();

  // Basic security headers
  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // CORS configuration
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, server-to-server) in non-production
        if (!origin) return callback(null, true);
        if (env.ALLOWED_ORIGINS.includes(origin) || env.NODE_ENV === 'test') {
          return callback(null, true);
        }
        // Gracefully disallow origin without crashing the Express process
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Test-Bypass-CSRF'],
      exposedHeaders: ['X-CSRF-Token'],
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  // Trust first proxy if in production
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  // Session configuration
  app.use(
    session({
      name: env.COOKIE_NAME,
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: {
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: env.COOKIE_SAME_SITE,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        path: '/',
      },
    })
  );

  // CSRF Protection
  app.use(csrfProtection);

  // API Routes
  app.use('/api', apiRoutes);

  // 404 Handler for undefined API routes
  app.use('/api', (req, res) => {
    res.status(404).json({
      success: false,
      error: `Route not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // Central Error Handler
  app.use(errorHandler);

  return app;
}
