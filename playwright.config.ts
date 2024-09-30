import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 30 * 1000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'nuxt-vite',
      testDir: 'e2e/nuxt-vite',
      use: {
        baseURL: 'http://localhost:3001',
        browserName: 'chromium',
      },
    },
    {
      name: 'vite-vite',
      testDir: 'e2e/vite-vite',
      use: {
        baseURL: 'http://localhost:5175',
        browserName: 'chromium',
      },
    },
    {
      name: 'rust-vite',
      testDir: 'e2e/rust-vite',
      use: {
        baseURL: 'http://localhost:5172',
        browserName: 'chromium',
      },
    },
    {
      name: 'multi-example',
      testDir: 'e2e/vite-webpack-rspack',
      use: {
        baseURL: 'http://localhost:5173',
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
