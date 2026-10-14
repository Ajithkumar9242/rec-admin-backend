import Redis from 'ioredis';
import RedisStore from 'connect-redis';
import session from 'express-session';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let redisClient = null;
let sessionStore = null;

/**
 * Ping Redis server to verify connectivity
 */
export async function pingRedis() {
  if (env.NODE_ENV === 'test') {
    return 'PONG';
  }

  if (!redisClient) {
    throw new Error('Redis client has not been initialized');
  }

  if (redisClient.status !== 'ready') {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis connection timed out after 5 seconds')), 5000);
      redisClient.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
      redisClient.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  try {
    const response = await redisClient.ping();
    return response;
  } catch (error) {
    throw new Error(`Redis connection check failed: ${error.message}`);
  }
}

/**
 * Cleanly close Redis connection
 */
export async function closeRedis() {
  if (redisClient && redisClient.status !== 'end') {
    try {
      await redisClient.quit();
      logger.info('Redis connection cleanly terminated');
    } catch (err) {
      logger.warn({ error: err.message }, 'Error closing Redis client');
    }
  }
}

/**
 * Invalidate all Redis sessions for a specific admin ID, optionally preserving one current session
 */
export async function revokeAdminSessions(adminId, client = redisClient, exceptSessionId = null) {
  if (!client) return 0;
  let cursor = '0';
  let revokedCount = 0;
  try {
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', 'recruitrain_sess:*', 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        if (exceptSessionId && key.endsWith(exceptSessionId)) {
          continue;
        }
        const raw = await client.get(key);
        if (raw && (raw.includes(`"adminId":"${adminId}"`) || raw.includes(`"pendingAdminId":"${adminId}"`))) {
          await client.del(key);
          revokedCount++;
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn({ error: err.message, adminId }, 'Failed to revoke admin Redis sessions');
  }
  return revokedCount;
}

/**
 * Initialize session store:
 * Strictly requires Redis in development and production environments.
 * Strictly isolates in-memory session store to explicitly configured tests.
 */
export function initializeSessionStore() {
  if (env.NODE_ENV === 'test') {
    logger.info('Test environment: using isolated in-memory session store');
    sessionStore = new session.MemoryStore();
    return { sessionStore, redisClient: null };
  }

  try {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) {
          logger.error('Redis connection retries exhausted.');
          return null;
        }
        return Math.min(times * 200, 2000);
      },
      enableOfflineQueue: true,
      lazyConnect: false,
    });

    redisClient.on('connect', () => {
      logger.info(`Connected to Redis server at ${env.REDIS_URL}`);
    });

    redisClient.on('ready', () => {
      logger.info('Redis server is READY. Active session store: connect-redis');
    });

    redisClient.on('error', (err) => {
      logger.error({ error: err.message, host: env.REDIS_URL }, 'Redis server error. Required session store failed.');
    });

    sessionStore = new RedisStore({
      client: redisClient,
      prefix: 'recruitrain_sess:',
      disableTouch: false,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Fatal error initializing Redis connection.');
    throw new Error(`Failed to initialize required Redis session store: ${error.message}`);
  }

  return { sessionStore, redisClient };
}

export { redisClient, sessionStore };
