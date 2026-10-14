import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    testTimeout: 20000,
    setupFiles: ['./tests/setup/testSetup.js'],
    env: {
      NODE_ENV: 'test',
    },
  },
});
