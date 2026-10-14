import Redis from 'ioredis';
import RedisStore from 'connect-redis';
import session from 'express-session';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let redisClient = null;
let sessionStore = null;

/**
 * Resilient Session Store
 * Dynamically routes to Redis when available, with automatic fallback to MemoryStore
 */
class ResilientSessionStore extends session.Store {
  constructor(redisStore, memoryStore, getRedisStatus) {
    super();
    this.redisStore = redisStore;
    this.memoryStore = memoryStore;
    this.getRedisStatus = getRedisStatus;
  }

  get activeStore() {
    if (this.redisStore && this.getRedisStatus() === 'ready') {
      return this.redisStore;
    }
    return this.memoryStore;
  }

  get(sid, fn) {
    return this.activeStore.get(sid, fn);
  }

  set(sid, sess, fn) {
    return this.activeStore.set(sid, sess, fn);
  }

  destroy(sid, fn) {
    return this.activeStore.destroy(sid, fn);
  }

  all(fn) {
    if (this.activeStore.all) {
      return this.activeStore.all(fn);
    }
    return fn(null, []);
  }

  clear(fn) {
    if (this.activeStore.clear) {
      return this.activeStore.clear(fn);
    }
    return fn && fn();
  }

  length(fn) {
    if (this.activeStore.length) {
      return this.activeStore.length(fn);
    }
    return fn(null, 0);
  }

  touch(sid, sess, fn) {
    if (this.activeStore.touch) {
      return this.activeStore.touch(sid, sess, fn);
    }
    return fn && fn();
  }
}

export function initializeSessionStore() {
  const memoryStore = new session.MemoryStore();

  if (env.NODE_ENV === 'test' || process.env.USE_REDIS === 'false') {
    sessionStore = memoryStore;
    return { sessionStore, redisClient: null };
  }

  try {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 2) return null; // stop reconnecting
        return 1000;
      },
      enableOfflineQueue: false,
      lazyConnect: false,
    });

    redisClient.on('connect', () => {
      logger.info('Connected to Redis server for session storage');
    });

    redisClient.on('ready', () => {
      logger.info('Redis connection ready for session operations');
    });

    redisClient.on('error', (err) => {
      logger.warn({ error: err.message }, 'Redis server unavailable. Utilizing fallback session store.');
    });

    const realRedisStore = new RedisStore({
      client: redisClient,
      prefix: 'recruitrain_sess:',
      disableTouch: false,
    });

    sessionStore = new ResilientSessionStore(
      realRedisStore,
      memoryStore,
      () => redisClient?.status
    );
  } catch (error) {
    logger.warn({ error: error.message }, 'Failed to initialize Redis. Using in-memory session store.');
    sessionStore = memoryStore;
  }

  return { sessionStore, redisClient };
}

export { redisClient, sessionStore };
