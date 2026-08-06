import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './src/db/testSetup.ts',
    fileParallelism: false, // all suites share one MySQL test DB
    env: {
      DB_NAME: 'fs_internal_system_test',
      NODE_ENV: 'test',
      // Deterministic Google config so the suites neither depend on a
      // developer's .env nor could ever reach real Google — the client id is
      // fake and every suite injects the fake transport anyway.
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_TOKEN_ENC_KEY: 'aaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111',
    },
  },
});
