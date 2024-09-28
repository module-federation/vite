import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 30 * 1000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  use: {
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Define different projects for each environment
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
        baseURL: 'http://localhost:3002',
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
      name: 'vite-webpack-rspack',
      testDir: 'e2e/vite-webpack-rspack',
      use: {
        baseURL: 'http://localhost:3004',
        browserName: 'chromium',
      },
    },
  ],
});
