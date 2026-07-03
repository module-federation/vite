/**
 * ssrVmStrategy tests.
 *
 * The vm strategy depends on the experimental `vm.SourceTextModule` /
 * `vm.SyntheticModule` APIs, which only exist when Node runs with
 * `--experimental-vm-modules` (enabled through vitest's execArgv option).
 * Every evaluation test is guarded with skipIf so the suite still passes when
 * the flag is unavailable; the fallback test asserts the graceful null return
 * in that case.
 *
 * Like ssrEntryLoader, ssrVmStrategy keeps module-level caches, so tests use
 * vi.resetModules() + dynamic import for a fresh instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hasVmModules = await (async () => {
  const vm = (await import('vm')) as { SourceTextModule?: unknown };
  return typeof vm.SourceTextModule === 'function';
})();

type FetchEntry = { ok: boolean; status?: number; statusText?: string; text?: string };

function makeFetchMock(responses: Record<string, FetchEntry>) {
  return vi.fn(async (url: string) => {
    const entry = responses[url] ?? { ok: false };
    return {
      ok: entry.ok,
      status: entry.status ?? (entry.ok ? 200 : 404),
      statusText: entry.statusText ?? (entry.ok ? 'OK' : 'Not Found'),
      text: async () => entry.text ?? '',
    };
  });
}

async function freshStrategy() {
  vi.resetModules();
  return await import('../ssrVmStrategy');
}

const baseOptions = { resolvedShared: {}, shareScopeName: 'default', versionKey: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as Record<string, unknown>).__FEDERATION__;
});

describe('ssrVmStrategy — availability', () => {
  it('reports availability matching the runtime environment', async () => {
    const strategy = await freshStrategy();
    expect(await strategy.isVmStrategyAvailable()).toBe(hasVmModules);
  });

  it.skipIf(hasVmModules)('loadViaVmStrategy returns null without SourceTextModule', async () => {
    const strategy = await freshStrategy();
    const result = await strategy.loadViaVmStrategy('http://localhost:5001/remoteEntry.ssr.js', {
      ...baseOptions,
    });
    expect(result).toBeNull();
  });
});

describe.skipIf(!hasVmModules)('ssrVmStrategy — module graph evaluation', () => {
  it('evaluates an entry with relative imports resolved over HTTP', async () => {
    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { msg } from "./chunks/chunk.js"; export const got = msg;',
      },
      'http://localhost:5001/chunks/chunk.js': {
        ok: true,
        text: 'export const msg = "hello-from-chunk";',
      },
    }) as unknown as typeof globalThis.fetch;
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions }
    )) as { got: string };

    expect(namespace.got).toBe('hello-from-chunk');
  });

  it('links bare shared imports through the host federation share scope', async () => {
    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text:
          'import lib, { v } from "shared-lib";' + 'export const val = v; export const def = lib;',
      },
    }) as unknown as typeof globalThis.fetch;

    const loadShare = vi.fn(async () => () => ({ v: 42, default: { name: 'host-shared' } }));
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [{ options: { shared: { 'shared-lib': {} } }, loadShare }],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions }
    )) as { val: number; def: { name: string } };

    expect(loadShare).toHaveBeenCalledWith('shared-lib');
    expect(namespace.val).toBe(42);
    expect(namespace.def.name).toBe('host-shared');
  });

  it('skips instances that do not declare the package as shared', async () => {
    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { v } from "shared-lib"; export const val = v;',
      },
    }) as unknown as typeof globalThis.fetch;

    const wrongLoadShare = vi.fn(async () => () => ({ v: -1 }));
    const rightLoadShare = vi.fn(async () => () => ({ v: 7 }));
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [
        { options: { shared: { 'other-lib': {} } }, loadShare: wrongLoadShare },
        { options: { shared: { 'shared-lib': {} } }, loadShare: rightLoadShare },
      ],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions }
    )) as { val: number };

    expect(wrongLoadShare).not.toHaveBeenCalled();
    expect(namespace.val).toBe(7);
  });

  it('falls back to the resolvedShared file map when no instance shares the package', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'mf-vm-shared-'));
    const sharedFile = join(dir, 'file-shared.mjs');
    writeFileSync(sharedFile, 'export const v = "from-file";', 'utf8');

    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { v } from "file-shared"; export const val = v;',
      },
    }) as unknown as typeof globalThis.fetch;
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions, resolvedShared: { 'file-shared': sharedFile } }
    )) as { val: string };

    expect(namespace.val).toBe('from-file');
  });

  it('neutralizes Vite preload-helper imports before evaluation', async () => {
    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text:
          'import { _ as __vitePreload } from "./assets/preload-helper-abc.js";' +
          'export const r = await __vitePreload(() => "preloaded");',
      },
    }) as unknown as typeof globalThis.fetch;
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions }
    )) as { r: string };

    expect(namespace.r).toBe('preloaded');
  });

  it('throws HTTP status details for non-ok module responses', async () => {
    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { t } from "./missing.js"; export const val = t;',
      },
      'http://localhost:5001/missing.js': {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: 'missing chunk',
      },
    }) as unknown as typeof globalThis.fetch;
    const strategy = await freshStrategy();

    await expect(
      strategy.loadViaVmStrategy('http://localhost:5001/remoteEntry.ssr.js', { ...baseOptions })
    ).rejects.toThrow(
      'Failed to fetch SSR module "http://localhost:5001/missing.js": 500 Internal Server Error'
    );
  });

  it('keys the module cache by versionKey so redeploys load fresh code', async () => {
    const responses: Record<string, FetchEntry> = {
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'export const marker = "v1";',
      },
    };
    global.fetch = makeFetchMock(responses) as unknown as typeof globalThis.fetch;
    const strategy = await freshStrategy();
    const entryUrl = 'http://localhost:5001/remoteEntry.ssr.js';

    const first = (await strategy.loadViaVmStrategy(entryUrl, {
      ...baseOptions,
      versionKey: 'v1',
    })) as { marker: string };
    expect(first.marker).toBe('v1');

    responses[entryUrl] = { ok: true, text: 'export const marker = "v2";' };

    // Same version key → cached namespace, no re-fetch.
    const cached = (await strategy.loadViaVmStrategy(entryUrl, {
      ...baseOptions,
      versionKey: 'v1',
    })) as { marker: string };
    expect(cached.marker).toBe('v1');

    // New version key → fresh fetch and evaluation.
    const next = (await strategy.loadViaVmStrategy(entryUrl, {
      ...baseOptions,
      versionKey: 'v2',
    })) as { marker: string };
    expect(next.marker).toBe('v2');
  });
});
