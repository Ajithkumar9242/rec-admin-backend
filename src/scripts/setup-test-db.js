import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { assertTestDatabase, sanitizeDatabaseUrl, extractDatabaseName } from '../config/dbSafetyGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicitly set test environment
process.env.NODE_ENV = 'test';

// Always load the single private local environment file backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Target test database strictly from TEST_DATABASE_URL or explicitly provided test URL
const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('_test')
    ? process.env.DATABASE_URL
    : 'postgresql://postgres:postgres@localhost:5432/recruitrain_admin_test?schema=public');

process.env.DATABASE_URL = testDbUrl;

async function setupTestDatabase() {
  console.log('--- RecruiTrain Dedicated Test Database Setup ---');

  // Hard safety guard check: MUST be a valid test database
  const targetDbName = assertTestDatabase(testDbUrl);
  console.log(`[SAFETY CHECK PASSED] Target database: "${targetDbName}"`);
  console.log(`Target URL: ${sanitizeDatabaseUrl(testDbUrl)}`);

  // Dynamically import PrismaClient after test environment is guaranteed
  const { PrismaClient } = await import('@prisma/client');

  // 1. Ensure test database exists by connecting to postgres maintenance database
  const maintenanceUrl = testDbUrl.replace(
    new RegExp(`/${targetDbName}(\\?|$)`),
    '/postgres$1'
  );

  const maintenancePrisma = new PrismaClient({
    datasources: { db: { url: maintenanceUrl } },
    log: ['error'],
  });

  try {
    const existing = await maintenancePrisma.$queryRaw`
      SELECT 1 FROM pg_database WHERE datname = ${targetDbName}
    `;

    if (existing.length === 0) {
      console.log(`Database "${targetDbName}" does not exist. Creating...`);
      // CREATE DATABASE cannot run in a transaction, use raw query
      await maintenancePrisma.$executeRawUnsafe(`CREATE DATABASE "${targetDbName}";`);
      console.log(`Database "${targetDbName}" created successfully.`);
    } else {
      console.log(`Database "${targetDbName}" already exists.`);
    }
  } catch (err) {
    console.warn(`Note: Could not check/create database via maintenance connection: ${err.message}`);
    console.log('Proceeding to migration deploy check...');
  } finally {
    await maintenancePrisma.$disconnect();
  }

  // 2. Run migrations on the dedicated test database
  console.log(`Applying Prisma migrations to "${targetDbName}"...`);
  try {
    const backendRoot = path.resolve(__dirname, '../../');
    const cmd = `npx prisma migrate deploy --schema="${path.resolve(backendRoot, 'prisma/schema.prisma')}"`;

    execSync(cmd, {
      cwd: backendRoot,
      env: {
        ...process.env,
        DATABASE_URL: testDbUrl,
      },
      stdio: 'inherit',
      shell: true,
    });
    console.log(`[SUCCESS] Migrations deployed to "${targetDbName}".`);
  } catch (migErr) {
    console.error(`[ERROR] Failed to run migrations: ${migErr.message}`);
    process.exit(1);
  }

  // 3. Verify tables in test database
  const testPrisma = new PrismaClient({
    datasources: { db: { url: testDbUrl } },
    log: ['error'],
  });

  try {
    const currentDbResult = await testPrisma.$queryRaw`SELECT current_database() as db_name`;
    const connectedDb = currentDbResult[0]?.db_name;
    if (connectedDb !== targetDbName) {
      throw new Error(`Connected DB (${connectedDb}) did not match expected target (${targetDbName})!`);
    }

    const tables = await testPrisma.$queryRaw`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    console.log(`Verified tables in "${connectedDb}":`, tables.map((t) => t.tablename).join(', '));
    console.log('--- Test Database Setup Complete ---');
  } finally {
    await testPrisma.$disconnect();
  }
}

setupTestDatabase().catch((err) => {
  console.error('[FATAL] Test database setup failed:', err);
  process.exit(1);
});
