import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 30 * 1000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  webServer: [
    {
      command: 'pnpm run multi-example',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm run preview-vv',
      url: 'http://localhost:5176/testbase',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'multi-example',
      testDir: 'e2e/vite-webpack-rspack',
      use: {
        baseURL: 'http://localhost:5173',
        browserName: 'chromium',
      },
    },
    {
      name: 'vite-vite-remote',
      testDir: 'e2e/vite-vite/tests',
      testMatch: 'remote-preview.spec.ts',
      use: {
        baseURL: 'http://localhost:5176/testbase',
        browserName: 'chromium',
      },
    },
    {
      name: 'vite-vite-host',
      testDir: 'e2e/vite-vite/tests',
      testMatch: 'host-preview.spec.ts',
      use: {
        baseURL: 'http://localhost:5175',
        browserName: 'chromium',
      },
    },
  ],
  outputDir: 'reports/e2e/output',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/e2e/playwright-report', open: 'never' }],
    ['json', { outputFile: 'reports/e2e/test-results.json' }],
  ],
});
