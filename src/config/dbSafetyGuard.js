/**
 * Hard Safety Guard for Database Isolation
 *
 * Verifies and enforces that tests, test migrations, and test fixture cleanup
 * ONLY ever run against an authorized dedicated test database (e.g., recruitrain_admin_test).
 * Explicitly rejects the primary 'recruitrain_admin' database and non-test environments.
 */

const FORBIDDEN_DATABASES = new Set([
  'recruitrain_admin',
  'recruitrain_admin_prod',
  'recruitrain_admin_dev',
  'production',
  'development',
  'postgres',
  'admin',
]);

/**
 * Extracts database name from connection URL.
 * @param {string} connectionUrl 
 * @returns {string}
 */
export function extractDatabaseName(connectionUrl) {
  if (!connectionUrl || typeof connectionUrl !== 'string') {
    return '';
  }
  try {
    const parsed = new URL(connectionUrl);
    return parsed.pathname.replace(/^\//, '').split('?')[0].trim();
  } catch {
    // If not standard URL format, try regex fallback
    const match = connectionUrl.match(/(?:[:/])([a-zA-Z0-9_-]+)(?:\?|$)/);
    return match ? match[1] : '';
  }
}

/**
 * Sanitizes connection URL by masking password/credentials for safe logging.
 * @param {string} connectionUrl 
 * @returns {string}
 */
export function sanitizeDatabaseUrl(connectionUrl) {
  if (!connectionUrl || typeof connectionUrl !== 'string') {
    return '[EMPTY]';
  }
  try {
    const parsed = new URL(connectionUrl);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch {
    return connectionUrl.replace(/:([^:@]+)@/, ':****@');
  }
}

/**
 * Validates whether a database name is an authorized test database.
 * @param {string} dbName 
 * @returns {boolean}
 */
export function isAuthorizedTestDatabase(dbName) {
  if (!dbName || typeof dbName !== 'string') {
    return false;
  }
  const normalized = dbName.toLowerCase().trim();

  // Explicit blacklist check
  if (FORBIDDEN_DATABASES.has(normalized)) {
    return false;
  }

  // Must match explicit test naming pattern
  const isExplicitTestName =
    normalized === 'recruitrain_admin_test' ||
    normalized.endsWith('_test') ||
    normalized.endsWith('_testing') ||
    normalized.startsWith('test_');

  return isExplicitTestName;
}

/**
 * Asserts that a database URL points to an authorized test database.
 * Throws a critical error and aborts if it points to recruitrain_admin or non-test DB.
 * @param {string} connectionUrl 
 * @returns {string} Extracted database name
 */
export function assertTestDatabase(connectionUrl) {
  const dbName = extractDatabaseName(connectionUrl);

  if (!dbName) {
    const err = new Error(
      `[DB SAFETY GUARD] CRITICAL: Could not determine database name from connection URL. ` +
      `URL: ${sanitizeDatabaseUrl(connectionUrl)}. Aborting to prevent data loss.`
    );
    err.name = 'DatabaseIsolationError';
    throw err;
  }

  if (!isAuthorizedTestDatabase(dbName)) {
    const err = new Error(
      `[DB SAFETY GUARD] CRITICAL SAFETY VIOLATION: Refusing to operate on non-test database "${dbName}". ` +
      `Target must be a dedicated test database (e.g. recruitrain_admin_test). Aborting immediately.`
    );
    err.name = 'DatabaseIsolationError';
    throw err;
  }

  return dbName;
}

/**
 * Asserts that an active Prisma client connection is connected to an authorized test database.
 * Executes SELECT current_database() at runtime.
 * @param {import('@prisma/client').PrismaClient} prismaClient 
 * @returns {Promise<string>} Connected database name
 */
export async function assertConnectedDatabase(prismaClient) {
  if (!prismaClient) {
    throw new Error('[DB SAFETY GUARD] PrismaClient instance is required for connection assertion.');
  }

  const result = await prismaClient.$queryRaw`SELECT current_database() as db_name`;
  const currentDb = result[0]?.db_name || result[0]?.current_database;

  if (!currentDb || !isAuthorizedTestDatabase(currentDb)) {
    const err = new Error(
      `[DB SAFETY GUARD] CRITICAL SAFETY VIOLATION: Active database connection is connected to "${currentDb}", ` +
      `which is NOT an authorized test database! Target must be recruitrain_admin_test. Execution aborted.`
    );
    err.name = 'DatabaseIsolationError';
    throw err;
  }

  return currentDb;
}
