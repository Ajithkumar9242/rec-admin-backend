import { beforeAll, afterAll } from 'vitest';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/lib/prisma.js';
import { assertTestDatabase, assertConnectedDatabase, extractDatabaseName } from '../../src/config/dbSafetyGuard.js';

beforeAll(async () => {
  // Hard safety guard: Verify environment and connection string
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`[TEST SETUP] FATAL: Tests must run with NODE_ENV=test. Current: ${process.env.NODE_ENV}`);
  }

  const configuredDb = assertTestDatabase(env.DATABASE_URL);

  // Runtime database assertion: Verify the actual connected PostgreSQL instance
  const connectedDb = await assertConnectedDatabase(prisma);

  if (configuredDb !== connectedDb) {
    throw new Error(
      `[TEST SETUP] FATAL MISMATCH: Configured DB (${configuredDb}) does not match connected DB (${connectedDb})!`
    );
  }

  console.log(`[TEST SETUP] Verified safe test database isolation: "${connectedDb}".`);
});

afterAll(async () => {
  await prisma.$disconnect();
});
