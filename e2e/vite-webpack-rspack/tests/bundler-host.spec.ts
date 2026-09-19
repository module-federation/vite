import { expect, test } from '@playwright/test';

// webpack / rspack (@module-federation/enhanced) hosts consuming the Vite dev remote
// with the same shared React version (examples/vite-webpack-rspack/bundler-host).
for (const host of [
  { bundler: 'webpack', url: 'http://localhost:8082/' },
  { bundler: 'rspack', url: 'http://localhost:8083/' },
]) {
  test.describe(`${host.bundler} host`, () => {
    // module-federation/vite#1326 / #1064: the remote's init() must not re-enter the
    // host's loadShare() while initializeSharing() awaits it. On a deadlock the host's
    // bootstrap never runs and the page stays blank.
    test('bootstraps without deadlocking on the remote init', async ({ page }) => {
      await page.goto(host.url);
      await expect(page.getByTestId('host-ready')).toBeVisible({ timeout: 15_000 });
    });

    // The remote expose must run on the host's React: Product calls useState, which
    // throws "Cannot read properties of null" on a second React copy.
    test('renders the remote expose on the host React', async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));

      await page.goto(host.url);

      await expect(page.getByRole('heading', { level: 1, name: 'Basic Tee' })).toBeVisible({
        timeout: 15_000,
      });
      expect(pageErrors).toEqual([]);
    });
  });
}
