import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadModule } from '../blobLoad';
import { createInstance } from '@module-federation/runtime';
import {
  assetRequestContextProducerPlugin,
  hasAssetRequestContext,
  installAssetRequestContext,
  loadCssWithAssetRequestContext,
  loadEntryWithRequest,
  registerProducerModule,
  resetAssetRequestContext,
  type AssetRequestContext,
} from '../assetRequestContext';

const ENTRY_URL = 'https://remote.example/remoteEntry.js';
const EXPOSES_URL = 'https://remote.example/assets/exposes.js';

function getContexts(): Map<string, { customFetch?: unknown }> {
  return (globalThis as Record<string, any>).__mfDynImport.blobLoaderContexts;
}

function okResponse(text: string) {
  return { ok: true, text: () => Promise.resolve(text) } as unknown as Response;
}

beforeEach(() => {
  resetAssetRequestContext();
  loadModule.clearCache();
  delete (globalThis as Record<string, unknown>).__mfDynImport;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('producer assetRequestContext', () => {
  it('registers producer chunk urls only once a context is installed', () => {
    registerProducerModule(ENTRY_URL);
    expect(getContexts().has(ENTRY_URL)).toBe(false);
    expect(hasAssetRequestContext()).toBe(false);

    const request = vi.fn();
    installAssetRequestContext({ consumerId: 'host', request });
    registerProducerModule(EXPOSES_URL);

    expect(hasAssetRequestContext()).toBe(true);
    expect(getContexts().get(ENTRY_URL)?.customFetch).toBe(request);
    expect(getContexts().get(EXPOSES_URL)?.customFetch).toBe(request);
  });

  it('ignores a context without request', () => {
    expect(installAssetRequestContext({ consumerId: 'host' })).toBeUndefined();
    expect(installAssetRequestContext(undefined)).toBeUndefined();
    expect(hasAssetRequestContext()).toBe(false);
  });

  it('refuses a context from a different consumer and keeps the first', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerProducerModule(ENTRY_URL);
    const first: AssetRequestContext = { consumerId: 'host-a', request: vi.fn() };
    const second: AssetRequestContext = { consumerId: 'host-b', request: vi.fn() };

    expect(installAssetRequestContext(first)).toBe(first);
    expect(installAssetRequestContext(second)).toBe(first);
    expect(getContexts().get(ENTRY_URL)?.customFetch).toBe(first.request);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('consumer "host-b"'));
  });

  it('lets the same consumer replace its context', () => {
    registerProducerModule(ENTRY_URL);
    const first: AssetRequestContext = { consumerId: 'host', request: vi.fn() };
    const refreshed: AssetRequestContext = { consumerId: 'host', request: vi.fn() };

    installAssetRequestContext(first);
    expect(installAssetRequestContext(refreshed)).toBe(refreshed);
    expect(getContexts().get(ENTRY_URL)?.customFetch).toBe(refreshed.request);
  });

  it('loads css through request only when a context is installed', async () => {
    expect(loadCssWithAssetRequestContext('https://remote.example/a.css')).toBeUndefined();

    const appended: Array<{ rel?: string; href?: string }> = [];
    (globalThis as Record<string, unknown>).document = {
      head: { appendChild: (link: { rel?: string; href?: string }) => appended.push(link) },
      createElement: () => ({}),
    };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:css');
    const request = vi.fn().mockResolvedValue(okResponse('.a{}'));
    installAssetRequestContext({ consumerId: 'host', request });
    try {
      await loadCssWithAssetRequestContext('https://remote.example/a.css');
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }

    expect(request).toHaveBeenCalledWith('https://remote.example/a.css', { headers: {} });
    expect(appended).toEqual([{ rel: 'stylesheet', href: 'blob:css' }]);
  });
});

describe('assetRequestContextProducerPlugin', () => {
  it('ignores init options without a context', () => {
    const plugin = assetRequestContextProducerPlugin();
    const args = { userOptions: { name: 'remote' } } as any;
    expect(plugin.beforeInit!(args)).toBe(args);
    expect(args.userOptions).toEqual({ name: 'remote' });
    expect(hasAssetRequestContext()).toBe(false);
  });

  it('installs the context from userOptions in beforeInit', () => {
    registerProducerModule(ENTRY_URL);
    const context: AssetRequestContext = { consumerId: 'host', request: vi.fn() };
    const plugin = assetRequestContextProducerPlugin();
    plugin.beforeInit!({ userOptions: { name: 'remote', assetRequestContext: context } } as any);
    expect(getContexts().get(ENTRY_URL)?.customFetch).toBe(context.request);
  });

  it('drops a context without request from userOptions', () => {
    const userOptions = { name: 'remote', assetRequestContext: { consumerId: 'host' } };
    assetRequestContextProducerPlugin().beforeInit!({ userOptions } as any);
    expect('assetRequestContext' in userOptions).toBe(false);
  });

  it('keeps the first consumer context on the federation instance', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first: AssetRequestContext = { consumerId: 'host-a', request: vi.fn() };
    const second: AssetRequestContext = { consumerId: 'host-b', request: vi.fn() };
    const name = `asset-request-context-${Date.now()}`;
    const instance = createInstance({
      name,
      remotes: [],
      plugins: [assetRequestContextProducerPlugin()],
      assetRequestContext: first,
    } as any);
    instance.initOptions({ name, assetRequestContext: second } as any);
    expect((instance.options as any).assetRequestContext).toBe(first);

    const refreshed: AssetRequestContext = { consumerId: 'host-a', request: vi.fn() };
    instance.initOptions({ name, assetRequestContext: refreshed } as any);
    expect((instance.options as any).assetRequestContext).toBe(refreshed);
  });
});

describe('loadEntryWithRequest', () => {
  it('fetches the entry through request', async () => {
    const request = vi.fn().mockResolvedValue(okResponse('export const init = () => {};'));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('data:text/javascript,export const init = 1;');

    const exports = await loadEntryWithRequest({ entry: ENTRY_URL, name: 'remote', request });
    expect(request).toHaveBeenCalledWith(ENTRY_URL, { headers: {} });
    expect(exports).toMatchObject({ init: 1 });
  });

  it('reports failures as RUNTIME-008', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' } as Response);

    await expect(
      loadEntryWithRequest({ entry: ENTRY_URL, name: 'remote', request })
    ).rejects.toThrow(/#RUNTIME-008/);
    expect(request).toHaveBeenCalledWith(ENTRY_URL, { headers: {} });
  });
});
