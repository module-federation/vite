import { expect, test } from '@playwright/test';

/**
 * Host (provideExternalRuntime) + remote (externalRuntime) preview smoke.
 * Started via playwright.external-runtime.config.ts with EXTERNAL_RUNTIME=1.
 */
test.describe('vite-vite external runtime preview', () => {
  test('renders host and remote modules with a shared runtime-core global', async ({ page }) => {
    await page.goto('/');

    const heading = page.getByRole('heading', { name: 'MF HOST Demo', exact: true });
    await expect(heading).toBeVisible();

    const emotionText = page.getByText('Heading with a green background and yellow text.');
    await expect(emotionText).toBeVisible();

    await expect(page.getByTestId('shared-counter-[shared-lib] Host')).toBeVisible();
    await expect(page.getByTestId('shared-counter-[shared-lib] Remote')).toBeVisible();

    const hasRuntimeCore = await page.evaluate(() =>
      Boolean((globalThis as { _FEDERATION_RUNTIME_CORE?: unknown })._FEDERATION_RUNTIME_CORE)
    );
    expect(hasRuntimeCore).toBe(true);
  });

  test('remote mf-manifest.json remains valid under externalRuntime', async ({ request }) => {
    const response = await request.get('http://localhost:5176/testbase/mf-manifest.json');
    expect(response.ok()).toBe(true);

    const manifest = (await response.json()) as {
      id?: string;
      name?: string;
      metaData?: unknown;
      exposes?: unknown[];
    };

    expect(manifest.id || manifest.name).toBeTruthy();
    expect(manifest.metaData).toBeDefined();
    expect(Array.isArray(manifest.exposes)).toBe(true);
    expect(manifest.exposes!.length).toBeGreaterThan(0);
  });
});
