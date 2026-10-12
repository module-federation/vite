import { defineConfig } from '@playwright/test';

/**
 * Opt-in Playwright suite for experiments.externalRuntime /
 * provideExternalRuntime. Does not run as part of the default `pnpm e2e`.
 *
 *   pnpm run e2e:external
 */
export default defineConfig({
  testDir: 'e2e/vite-vite/tests',
  testMatch: 'external-runtime.spec.ts',
  timeout: 30 * 1000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // Host and remote get a server each: one url check would let the tests start before the other is up.
  webServer: [
    {
      command:
        'pnpm run build:shared-lib && EXTERNAL_RUNTIME=1 pnpm --filter examples-vite-vite-remote run preview',
      url: 'http://localhost:5176/testbase/',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: 'EXTERNAL_RUNTIME=1 pnpm --filter examples-vite-vite-host run preview',
      url: 'http://localhost:5175',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
  use: {
    baseURL: 'http://localhost:5175',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'vite-vite-external-runtime',
    },
  ],
  outputDir: 'reports/e2e/output-external-runtime',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/e2e/playwright-report-external-runtime', open: 'never' }],
  ],
});
