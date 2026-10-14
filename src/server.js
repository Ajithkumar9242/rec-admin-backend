import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { pingRedis, closeRedis } from './lib/redis.js';

async function startServer() {
  try {
    // 1. Verify PostgreSQL Database connection
    await prisma.$queryRaw`SELECT 1`;
    logger.info('PostgreSQL connection verified successfully (Database: recruitrain_admin)');

    // 2. Initialize application & session store
    const app = createApp();

    // 3. Verify Redis Server connection
    const redisPong = await pingRedis();
    logger.info(`Redis session storage verified successfully (PING -> ${redisPong})`);

    const server = app.listen(env.PORT, () => {
      logger.info(`RecruiTrain Admin Backend running on port ${env.PORT} in ${env.NODE_ENV} mode`);
      logger.info(`API Base URL: http://localhost:${env.PORT}/api`);
    });

    // Graceful shutdown handling
    async function shutdown(signal) {
      logger.info(`Received ${signal}. Gracefully shutting down...`);
      server.close(async () => {
        logger.info('HTTP server closed.');
        await closeRedis();
        await prisma.$disconnect();
        logger.info('Database & Redis connections cleanly closed.');
        process.exit(0);
      });
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ error: err.message }, 'Failed to start RecruiTrain Admin Backend.');
    await closeRedis();
    await prisma.$disconnect();
    process.exit(1);
  }
}

startServer();
