import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    exclude: ['**/e2e/**', '**/node_modules/**'],
    env: {
      MFE_VITE_NO_TEST_ENV_CHECK: 'true',
    },
  },
});
