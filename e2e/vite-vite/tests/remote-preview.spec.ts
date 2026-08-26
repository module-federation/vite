import { expect, test } from '@playwright/test';

test.describe('vite-vite remote preview', () => {
  test('renders the remote app', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', { name: 'Vite + React', exact: true });
    await expect(heading).toBeVisible();
  });

  test('keeps a user manualChunks chunk alongside federation chunks', async ({ page }) => {
    // The remote runs Vite 7 (Rollup). Its user `manualChunks` function emits
    // deployInfo as a stable-named chunk, composed behind the federation chunks
    // the plugin claims first.
    const scriptUrls: string[] = [];
    page.on('response', (response) => {
      if (response.request().resourceType() === 'script') {
        scriptUrls.push(response.url());
      }
    });

    await page.goto('/');
    // Federation still starts: the app renders, including the isolated module.
    await expect(page.getByTestId('remote-deploy-info')).toHaveText('remote-deploy-info');

    // The user chunk is emitted and loaded with the app.
    await expect
      .poll(() => scriptUrls.some((url) => /user-remote-chunk/.test(url)))
      .toBe(true);
  });

  test('renders shared-lib component', async ({ page }) => {
    await page.goto('/');
    const counter = page.getByTestId('shared-counter-[shared-lib] Remote');
    await expect(counter).toBeVisible();
    await expect(counter.locator('strong')).toHaveText('[shared-lib] Remote');
    const button = counter.getByRole('button');
    await expect(button).toHaveText('count: 0');
    await button.click();
    await button.click();
    await button.click();
    await expect(button).toHaveText('count: 3');
  });
});

test('generates var entries from both captured federation configs', async ({ page }) => {
  await page.goto('/');
  await page.addScriptTag({ url: '/testbase/varRemoteEntry.js' });
  await page.addScriptTag({ url: '/testbase/secondaryVarRemoteEntry.js' });

  await expect
    .poll(() =>
      page.evaluate(() => ({
        primary: typeof globalThis['@namespace/viteViteRemote'],
        secondary: typeof globalThis['@namespace/viteViteRemoteSecondary'],
      }))
    )
    .toEqual({ primary: 'object', secondary: 'object' });
});
