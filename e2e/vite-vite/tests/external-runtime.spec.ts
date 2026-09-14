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

  // The host provides the runtime AND exposes `./EagerManifestFixture`: the
  // layout the plugin used to reject. It must own the global, keep every
  // container on one runtime-core, and still work as a remote entry itself.
  test('an exposing host provides one runtime-core for every container', async ({ page }) => {
    const notable: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        notable.push(message.text());
      }
    });
    page.on('pageerror', (error) => notable.push(error.message));

    await page.goto('/');
    await expect(page.getByTestId('shared-counter-[shared-lib] Remote')).toBeVisible();

    const state = await page.evaluate(() => {
      const federation = (
        globalThis as {
          __FEDERATION__?: { __INSTANCES__?: Array<{ name: string; constructor: unknown }> };
          _FEDERATION_RUNTIME_CORE_FROM?: { name: string };
        }
      ).__FEDERATION__;
      const instances = federation?.__INSTANCES__ ?? [];
      return {
        providerName: (globalThis as { _FEDERATION_RUNTIME_CORE_FROM?: { name: string } })
          ._FEDERATION_RUNTIME_CORE_FROM?.name,
        instanceNames: instances.map((instance) => instance.name),
        runtimeCoreCopies: new Set(instances.map((instance) => instance.constructor)).size,
      };
    });

    expect(state.providerName).toBe('viteViteHost');
    expect(state.instanceNames).toEqual(
      expect.arrayContaining(['viteViteHost', '@namespace/viteViteRemote'])
    );
    // Every instance was built by the same ModuleFederation class: the remote
    // (externalRuntime) did not evaluate a runtime-core copy of its own.
    expect(state.runtimeCoreCopies).toBe(1);
    expect(notable.filter((text) => /multiple module federation runtime/i.test(text))).toEqual(
      []
    );
    expect(notable.filter((text) => /_FEDERATION_RUNTIME_CORE is missing/.test(text))).toEqual(
      []
    );
  });

  test('the providing host is still consumable through its own remote entry', async ({
    page,
    request,
  }) => {
    const entry = await request.get('/hostRemoteEntry.js');
    expect(entry.ok()).toBe(true);

    await page.goto('/');
    await expect(page.getByTestId('shared-counter-[shared-lib] Remote')).toBeVisible();

    const result = await page.evaluate(async () => {
      const container = (await import('/hostRemoteEntry.js')) as {
        init: (shareScope: Record<string, unknown>) => Promise<unknown>;
        get: (id: string) => Promise<() => { default?: unknown }>;
      };
      await container.init({});
      const factory = await container.get('./EagerManifestFixture');
      const exposed = factory();
      const instances =
        (globalThis as { __FEDERATION__?: { __INSTANCES__?: Array<{ name: string }> } })
          .__FEDERATION__?.__INSTANCES__ ?? [];
      return {
        exposeType: typeof (exposed.default ?? exposed),
        hostInstances: instances.filter((instance) => instance.name === 'viteViteHost').length,
      };
    });

    expect(result.exposeType).toBe('function');
    // Re-entering the host through its remote entry reuses the running instance.
    expect(result.hostInstances).toBe(1);
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
