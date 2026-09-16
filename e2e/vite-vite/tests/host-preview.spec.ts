import { expect, test, type APIRequestContext } from '@playwright/test';

async function getSharedProviderUrls(
  request: APIRequestContext,
  manifestUrl: string,
  dependency: string
) {
  const response = await request.get(manifestUrl);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  const shared = manifest.shared.find((entry: { name: string }) => entry.name === dependency);
  expect(shared).toBeDefined();
  return [...shared.assets.js.sync, ...shared.assets.js.async].map(
    (asset: string) => new URL(asset, manifest.metaData.publicPath).href
  );
}

/**
 * These tests run against the host preview (port 5175) which loads remote
 * modules from the remote preview (port 5176). Both must be running.
 *
 * This exercises the full Module Federation pipeline in build mode:
 * shared deps, default imports, named imports, CJS interop, etc.
 */
test.describe('vite-vite host preview', () => {
  test('renders host app with React shared dep', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', { name: 'MF HOST Demo', exact: true });
    await expect(heading).toBeVisible();
  });

  test('downloads a compatible non-singleton fallback once', async ({ page }) => {
    const scriptResponses: Promise<{ url: string; body: string }>[] = [];
    page.on('response', (response) => {
      if (response.request().resourceType() === 'script') {
        scriptResponses.push(
          response.text().then((body) => ({ url: response.url(), body }))
        );
      }
    });

    await page.goto('/');
    await expect(page.getByTestId('shared-counter-[shared-lib] Host')).toBeVisible();
    await expect(page.getByTestId('shared-counter-[shared-lib] Remote')).toBeVisible();

    const sharedLibResponses = (await Promise.all(scriptResponses)).filter(({ body }) =>
      body.includes('[Shared Lib] Initialized')
    );
    expect(sharedLibResponses.map(({ url }) => url)).toHaveLength(1);
  });

  test('reuses a non-eager provider loaded by another remote', async ({ page, request }) => {
    const primaryProviders = await getSharedProviderUrls(
      request,
      'http://localhost:5176/testbase/mf-manifest.json',
      'styled-components'
    );
    const secondaryManifestUrl =
      'http://localhost:5177/testbase/secondary-mf-manifest.json';
    const secondaryProviders = await getSharedProviderUrls(
      request,
      secondaryManifestUrl,
      'styled-components'
    );
    expect(primaryProviders.length).toBeGreaterThan(0);
    expect(secondaryProviders.length).toBeGreaterThan(0);

    const requested = new Set<string>();
    page.on('response', (response) => requested.add(response.url()));

    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Styled Components Demo', exact: true })
    ).toBeVisible();
    await expect.poll(() => primaryProviders.some((url) => requested.has(url))).toBe(true);

    await page.getByRole('button', { name: 'Preload secondary remote' }).click();
    await expect(page.getByText('Secondary remote preloaded')).toBeVisible();
    await expect.poll(() => requested.has(secondaryManifestUrl)).toBe(true);
    expect(secondaryProviders.filter((url) => requested.has(url))).toEqual([]);
  });

  test('renders Emotion styled component from remote', async ({ page }) => {
    await page.goto('/');
    // EmotionDemo uses `import styled from '@emotion/styled'` (default import).
    // This breaks if the ESM shims plugin doesn't handle default export interop.
    const emotionText = page.getByText('Heading with a green background and yellow text.');
    await expect(emotionText).toBeVisible();
  });

  test('renders Styled Components demo from remote', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', {
      name: 'Styled Components Demo',
      exact: true,
    });
    await expect(heading).toBeVisible();
  });

  test('renders shared-lib component on host', async ({ page }) => {
    await page.goto('/');
    const counter = page.getByTestId('shared-counter-[shared-lib] Host');
    await expect(counter).toBeVisible();
    await expect(counter.locator('strong')).toHaveText('[shared-lib] Host');
  });

  test('shared-lib counter increments on host', async ({ page }) => {
    await page.goto('/');
    const counter = page.getByTestId('shared-counter-[shared-lib] Host');
    const button = counter.getByRole('button');
    await expect(button).toHaveText('count: 0');
    await button.click();
    await button.click();
    await expect(button).toHaveText('count: 2');
  });

  test('renders shared-lib component from remote', async ({ page }) => {
    await page.goto('/');
    const counter = page.getByTestId('shared-counter-[shared-lib] Remote');
    await expect(counter).toBeVisible();
    await expect(counter.locator('strong')).toHaveText('[shared-lib] Remote');
    const button = counter.getByRole('button');
    await expect(button).toHaveText('count: 0');
    await button.click();
    await expect(button).toHaveText('count: 1');
  });

  test('shared-lib is initialized exactly once (singleton)', async ({ page }) => {
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('[Shared Lib] Initialized')) {
        consoleLogs.push(msg.text());
      }
    });

    await page.goto('/');
    // Wait for all remote modules to load and render
    await expect(page.getByTestId('shared-consumer-event')).toHaveText('CurrentRowChangedEvent');
    await expect(page.getByTestId('shared-counter-[shared-lib] Host')).toBeVisible();
    await expect(page.getByTestId('shared-counter-[shared-lib] Remote')).toBeVisible();

    expect(consoleLogs).toHaveLength(1);
  });

  test('keeps a user codeSplitting.groups chunk alongside federation chunks', async ({
    page,
  }) => {
    // The host runs Vite 8 (Rolldown). Its user `codeSplitting.groups` entry
    // isolates PrimaryFederationMarker into a stable-named chunk. The plugin's
    // federation groups keep the highest priority, so this only proves user
    // groups survive alongside them.
    const scriptUrls: string[] = [];
    page.on('response', (response) => {
      if (response.request().resourceType() === 'script') {
        scriptUrls.push(response.url());
      }
    });

    await page.goto('/');
    // Federation still starts: the remote-backed marker renders.
    await expect(page.getByTestId('primary-federation-marker')).toHaveText(
      'primary federation instance'
    );

    // The user chunk is emitted and loaded on startup.
    await expect
      .poll(() => scriptUrls.some((url) => /user-host-chunk/.test(url)))
      .toBe(true);
  });

  test('isolates identical remote ids across two federation configs', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('primary-federation-marker')).toHaveText(
      'primary federation instance'
    );
    await page.waitForFunction(() => {
      const cache = (globalThis as any).__mf_module_cache__?.remote ?? {};
      return Object.keys(cache).filter(
        (key) => !key.startsWith('__mf_pending__') && key.endsWith('::@namespace/viteViteRemote/InstanceMarker')
      ).length === 2;
    });
    const cachedMarkers = await page.evaluate(() => {
      const cache = (globalThis as any).__mf_module_cache__.remote;
      return Object.entries(cache)
        .filter(
          ([key]) =>
            !key.startsWith('__mf_pending__') &&
            key.endsWith('::@namespace/viteViteRemote/InstanceMarker')
        )
        .map(([key, value]: [string, any]) => ({ key, marker: value.default }));
    });

    expect(cachedMarkers).toHaveLength(2);
    expect(new Set(cachedMarkers.map(({ key }) => key)).size).toBe(2);
    expect(cachedMarkers.map(({ marker }) => marker).sort()).toEqual([
      'primary federation instance',
      'secondary federation instance',
    ]);
  });
});
