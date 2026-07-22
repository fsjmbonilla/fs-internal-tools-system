import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './src/db/testSetup.ts',
    fileParallelism: false, // all suites share one MySQL test DB
    env: { DB_NAME: 'fs_internal_system_test', NODE_ENV: 'test' },
  },
});
