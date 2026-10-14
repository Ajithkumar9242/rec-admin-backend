import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isAuthorizedTestDatabase,
  extractDatabaseName,
  sanitizeDatabaseUrl,
  assertTestDatabase,
  assertConnectedDatabase,
} from '../src/config/dbSafetyGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Database Isolation & Safety Guard Suite', () => {
  describe('1. Database Name Extraction and Masking', () => {
    it('correctly extracts database name from postgresql connection strings', () => {
      const url = 'postgresql://postgres:secret@localhost:5432/recruitrain_admin_test?schema=public';
      expect(extractDatabaseName(url)).toBe('recruitrain_admin_test');
    });

    it('masks sensitive credentials when sanitizing connection strings', () => {
      const url = 'postgresql://postgres:SuperSecretPassword123@localhost:5432/recruitrain_admin_test?schema=public';
      const sanitized = sanitizeDatabaseUrl(url);
      expect(sanitized).not.toContain('SuperSecretPassword123');
      expect(sanitized).toContain('****');
      expect(sanitized).toContain('recruitrain_admin_test');
    });
  });

  describe('2. Test Database Authorization Safety Rules', () => {
    it('explicitly rejects the main production/dev database "recruitrain_admin"', () => {
      expect(isAuthorizedTestDatabase('recruitrain_admin')).toBe(false);
    });

    it('explicitly rejects standard non-test database names', () => {
      expect(isAuthorizedTestDatabase('recruitrain_admin_prod')).toBe(false);
      expect(isAuthorizedTestDatabase('recruitrain_admin_dev')).toBe(false);
      expect(isAuthorizedTestDatabase('production')).toBe(false);
      expect(isAuthorizedTestDatabase('development')).toBe(false);
      expect(isAuthorizedTestDatabase('postgres')).toBe(false);
      expect(isAuthorizedTestDatabase('admin')).toBe(false);
      expect(isAuthorizedTestDatabase('')).toBe(false);
      expect(isAuthorizedTestDatabase(null)).toBe(false);
    });

    it('accepts valid test database names', () => {
      expect(isAuthorizedTestDatabase('recruitrain_admin_test')).toBe(true);
      expect(isAuthorizedTestDatabase('recruitrain_testing')).toBe(true);
      expect(isAuthorizedTestDatabase('test_recruitrain')).toBe(true);
    });
  });

  describe('3. Hard Safety Guard Abort Assertions', () => {
    it('throws DatabaseIsolationError when connection points to recruitrain_admin', () => {
      const mainDbUrl = 'postgresql://postgres:postgres@localhost:5432/recruitrain_admin?schema=public';
      expect(() => assertTestDatabase(mainDbUrl)).toThrowError(/CRITICAL SAFETY VIOLATION/);
    });

    it('throws DatabaseIsolationError when connection points to postgres or production', () => {
      expect(() => assertTestDatabase('postgresql://postgres:postgres@localhost:5432/postgres')).toThrowError();
      expect(() => assertTestDatabase('postgresql://postgres:postgres@localhost:5432/production')).toThrowError();
    });

    it('succeeds without error when connection points to recruitrain_admin_test', () => {
      const testDbUrl = 'postgresql://postgres:postgres@localhost:5432/recruitrain_admin_test?schema=public';
      const dbName = assertTestDatabase(testDbUrl);
      expect(dbName).toBe('recruitrain_admin_test');
    });

    it('assertConnectedDatabase rejects connections to recruitrain_admin', async () => {
      const mockPrismaMainDb = {
        $queryRaw: async () => [{ db_name: 'recruitrain_admin' }],
      };
      await expect(assertConnectedDatabase(mockPrismaMainDb)).rejects.toThrowError(
        /CRITICAL SAFETY VIOLATION.*recruitrain_admin/
      );
    });

    it('assertConnectedDatabase succeeds on recruitrain_admin_test', async () => {
      const mockPrismaTestDb = {
        $queryRaw: async () => [{ db_name: 'recruitrain_admin_test' }],
      };
      const connected = await assertConnectedDatabase(mockPrismaTestDb);
      expect(connected).toBe('recruitrain_admin_test');
    });
  });

  describe('4. Static Code Safety Verification (No Unscoped Destructive Calls)', () => {
    const testDir = __dirname;
    const testFiles = fs
      .readdirSync(testDir)
      .filter((f) => (f.endsWith('.test.js') || f.endsWith('.spec.js')) && f !== 'safety.test.js');

    it('finds test files to inspect', () => {
      expect(testFiles.length).toBeGreaterThan(0);
      expect(testFiles).toContain('auth.test.js');
    });

    testFiles.forEach((file) => {
      it(`verifies ${file} contains no unscoped deleteMany calls or TRUNCATE`, () => {
        const filePath = path.join(testDir, file);
        const content = fs.readFileSync(filePath, 'utf8');

        // Regex patterns for dangerous unscoped operations:
        // 1. deleteMany({}) or deleteMany() with only whitespace/empty object
        const unscopedDeleteManyRegex = /\.deleteMany\(\s*(\{\s*\})?\s*\)/g;
        const unscopedMatches = [...content.matchAll(unscopedDeleteManyRegex)];

        expect(
          unscopedMatches,
          `File ${file} contains ${unscopedMatches.length} unscoped deleteMany() call(s)! All deletes must be scoped.`
        ).toHaveLength(0);

        // 2. Raw TRUNCATE SQL queries
        const truncateRegex = /\bTRUNCATE\b/i;
        expect(
          truncateRegex.test(content),
          `File ${file} contains a dangerous TRUNCATE command!`
        ).toBe(false);

        // 3. Unscoped raw DELETE without WHERE
        const rawDeleteWithoutWhere = /DELETE\s+FROM\s+["`\w]+(?!\s+WHERE\b)/i;
        expect(
          rawDeleteWithoutWhere.test(content),
          `File ${file} contains a DELETE FROM without a WHERE clause!`
        ).toBe(false);
      });
    });

    it('verifies auth.test.js does not contain references to the real primary database', () => {
      const authTestPath = path.join(testDir, 'auth.test.js');
      const content = fs.readFileSync(authTestPath, 'utf8');

      // Should not reference recruitrain_admin unless followed by _test
      const mainDbRegex = /recruitrain_admin(?!_test)/g;
      const matches = [...content.matchAll(mainDbRegex)];
      expect(
        matches,
        `auth.test.js contains direct references to recruitrain_admin without _test suffix!`
      ).toHaveLength(0);
    });

    it('verifies auth.test.js uses deterministic non-production test domains (.test)', () => {
      const authTestPath = path.join(testDir, 'auth.test.js');
      const content = fs.readFileSync(authTestPath, 'utf8');

      // Created administrator fixture emails should end with .test
      const createdEmailRegex = /email:\s*['"]([^@'"]+@[^'"]+)['"]/g;
      const matches = [...content.matchAll(createdEmailRegex)];
      expect(matches.length).toBeGreaterThan(0);

      matches.forEach((m) => {
        const email = m[1];
        expect(
          email.endsWith('.test'),
          `Found test administrator fixture email "${email}" that does not use the .test safe domain!`
        ).toBe(true);
      });
    });
  });
});
