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
import { findSharedKey } from '../../plugins/pluginProxySharedModule_preBuild';
import { findVmSharedKey } from '../ssrVmStrategy';
import type { NormalizedShared } from '../normalizeModuleFederationOptions';

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

async function createFallbackSharedModule(prefix: string): Promise<string> {
  const { mkdtempSync, writeFileSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, 'fallback.mjs');
  writeFileSync(file, 'export const value = "fallback";', 'utf8');
  return file;
}

const baseOptions = {
  resolvedShared: {},
  shareScopeName: 'default',
  versionKey: 'v1',
  cacheContext: {},
};

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

function makeRuntimeShare(scope: string | string[] = 'default', shareConfig?: { import?: false }) {
  return shareConfig ? { scope, shareConfig } : { scope };
}

describe('ssrVmStrategy — findVmSharedKey (browser matcher twin)', () => {
  it('does not auto-map COMMON_SHARED_SUBPATHS when the parent uses import:false', () => {
    // Twin of pluginProxySharedModule_preBuild findSharedKey's import:false case.
    // Browser skips jsx-runtime after #1148; SSR findVmSharedKey must match.
    const shared: NormalizedShared = {
      react: {
        name: 'react',
        from: '',
        version: '19.2.4',
        scope: 'default',
        shareConfig: {
          singleton: true,
          import: false,
          requiredVersion: '^19.2.4',
          strictVersion: false,
        },
      },
    };

    expect(findSharedKey('react', shared)).toBe('react');
    expect(findSharedKey('react/jsx-runtime', shared)).toBeUndefined();
    expect(findVmSharedKey('react', shared)).toBe('react');
    expect(findVmSharedKey('react/jsx-runtime', shared)).toBeUndefined();

    const withExplicit = {
      ...shared,
      'react/jsx-runtime': { ...shared.react, name: 'react/jsx-runtime' },
    };
    expect(findSharedKey('react/jsx-runtime', withExplicit)).toBe('react/jsx-runtime');
    expect(findVmSharedKey('react/jsx-runtime', withExplicit)).toBe('react/jsx-runtime');
  });

  it('still auto-maps common subpaths when the parent is a local provider', () => {
    const shared = { react: makeRuntimeShare('default') };
    expect(findVmSharedKey('react/jsx-runtime', shared)).toBe('react');
  });

  it('prefers the longest trailing-slash wildcard prefix', () => {
    const shorterFirst = {
      '@scope/ui/': makeRuntimeShare('default'),
      '@scope/ui/forms/': makeRuntimeShare('default'),
    };
    expect(findVmSharedKey('@scope/ui/forms/Button', shorterFirst)).toBe('@scope/ui/forms/');
    expect(findVmSharedKey('@scope/ui/button', shorterFirst)).toBe('@scope/ui/');

    const longerFirst = {
      '@scope/ui/forms/': makeRuntimeShare('default'),
      '@scope/ui/': makeRuntimeShare('default'),
    };
    expect(findVmSharedKey('@scope/ui/forms/Button', longerFirst)).toBe('@scope/ui/forms/');
    expect(findVmSharedKey('@scope/ui/button', longerFirst)).toBe('@scope/ui/');
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

  it('negotiates static and dynamic common shared subpaths through the parent share', async () => {
    const fallbackFile = await createFallbackSharedModule('mf-vm-subpath-');

    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text:
          'import { value as staticValue } from "react/jsx-runtime";' +
          'export const value = staticValue;' +
          'export async function getDynamicValue() {' +
          '  const mod = await import("react/jsx-runtime");' +
          '  return mod.value;' +
          '}',
      },
    }) as unknown as typeof globalThis.fetch;

    const loadShare = vi.fn(async (specifier: string) => {
      expect(specifier).toBe('react/jsx-runtime');
      return () => ({ value: 'negotiated' });
    });
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [{ options: { shared: { react: { scope: 'default' } } }, loadShare }],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions, resolvedShared: { 'react/jsx-runtime': fallbackFile } }
    )) as { value: string; getDynamicValue: () => Promise<string> };

    expect(namespace.value).toBe('negotiated');
    await expect(namespace.getDynamicValue()).resolves.toBe('negotiated');
    expect(loadShare).toHaveBeenCalledWith('react/jsx-runtime');
    expect(loadShare).toHaveBeenCalledTimes(2);
  });

  it('prefers an explicit shared subpath configuration over its parent', async () => {
    const fallbackFile = await createFallbackSharedModule('mf-vm-explicit-subpath-');

    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { value } from "react/jsx-runtime"; export { value };',
      },
    }) as unknown as typeof globalThis.fetch;

    const loadShare = vi.fn(async () => () => ({ value: 'negotiated' }));
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [
        {
          options: {
            shared: {
              react: { scope: 'default' },
              'react/jsx-runtime': { scope: 'custom' },
            },
          },
          loadShare,
        },
      ],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions, resolvedShared: { 'react/jsx-runtime': fallbackFile } }
    )) as { value: string };

    expect(namespace.value).toBe('fallback');
    expect(loadShare).not.toHaveBeenCalled();
  });

  it('matches wildcard shared packages', async () => {
    const fallbackFile = await createFallbackSharedModule('mf-vm-wildcard-');

    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { value } from "@scope/ui/button"; export { value };',
      },
    }) as unknown as typeof globalThis.fetch;

    const loadShare = vi.fn(async () => () => ({ value: 'negotiated' }));
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [
        {
          options: { shared: { '@scope/ui/': { scope: 'default' } } },
          loadShare,
        },
      ],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions, resolvedShared: { '@scope/ui/button': fallbackFile } }
    )) as { value: string };

    expect(namespace.value).toBe('negotiated');
    expect(loadShare).toHaveBeenCalledWith('@scope/ui/button');
  });

  it('does not negotiate common shared subpaths when the parent uses import:false', async () => {
    const fallbackFile = await createFallbackSharedModule('mf-vm-import-false-subpath-');

    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { value } from "react/jsx-runtime"; export { value };',
      },
    }) as unknown as typeof globalThis.fetch;

    const loadShare = vi.fn(async () => () => ({ value: 'negotiated' }));
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [
        {
          options: {
            shared: { react: { scope: 'default', shareConfig: { import: false } } },
          },
          loadShare,
        },
      ],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions, resolvedShared: { 'react/jsx-runtime': fallbackFile } }
    )) as { value: string };

    expect(namespace.value).toBe('fallback');
    expect(loadShare).not.toHaveBeenCalled();
  });

  it('prefers the longest trailing-slash wildcard when scopes differ', async () => {
    const fallbackFile = await createFallbackSharedModule('mf-vm-wildcard-longest-');

    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { value } from "@scope/ui/forms/Button"; export { value };',
      },
    }) as unknown as typeof globalThis.fetch;

    const loadShare = vi.fn(async () => () => ({ value: 'forms-wildcard' }));
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [
        {
          options: {
            // Shorter prefix first: first-key-wins would select `@scope/ui/`
            // (scope "other") and skip this instance instead of matching forms/.
            shared: {
              '@scope/ui/': { scope: 'other' },
              '@scope/ui/forms/': { scope: 'default' },
            },
          },
          loadShare,
        },
      ],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions, resolvedShared: { '@scope/ui/forms/Button': fallbackFile } }
    )) as { value: string };

    expect(namespace.value).toBe('forms-wildcard');
    expect(loadShare).toHaveBeenCalledWith('@scope/ui/forms/Button');
  });

  it('does not treat arbitrary package subpaths as parent shared modules', async () => {
    const fallbackFile = await createFallbackSharedModule('mf-vm-unmatched-subpath-');

    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { value } from "react/not-a-common-subpath"; export { value };',
      },
    }) as unknown as typeof globalThis.fetch;

    const loadShare = vi.fn(async () => () => ({ value: 'negotiated' }));
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [{ options: { shared: { react: { scope: 'default' } } }, loadShare }],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions, resolvedShared: { 'react/not-a-common-subpath': fallbackFile } }
    )) as { value: string };

    expect(namespace.value).toBe('fallback');
    expect(loadShare).not.toHaveBeenCalled();
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

  it('selects federation instances from the requested named share scope', async () => {
    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { v } from "shared-lib"; export const val = v;',
      },
    }) as unknown as typeof globalThis.fetch;

    const defaultLoadShare = vi.fn(async () => () => ({ v: 'default' }));
    const customLoadShare = vi.fn(async () => () => ({ v: 'custom' }));
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [
        {
          options: { shared: { 'shared-lib': { scope: ['default'] } } },
          loadShare: defaultLoadShare,
        },
        {
          options: { shared: { 'shared-lib': { scope: ['custom'] } } },
          loadShare: customLoadShare,
        },
      ],
    };
    const strategy = await freshStrategy();

    const namespace = (await strategy.loadViaVmStrategy(
      'http://localhost:5001/remoteEntry.ssr.js',
      { ...baseOptions, shareScopeName: 'custom' }
    )) as { val: string };

    expect(defaultLoadShare).not.toHaveBeenCalled();
    expect(customLoadShare).toHaveBeenCalledWith('shared-lib');
    expect(namespace.val).toBe('custom');
  });

  it('isolates identical VM coordinates by owning federation instance', async () => {
    global.fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        text: 'import { v } from "shared-lib"; export const val = v;',
      },
    }) as unknown as typeof globalThis.fetch;
    const hostALoadShare = vi.fn(async () => () => ({ v: 'host-a' }));
    const hostBLoadShare = vi.fn(async () => () => ({ v: 'host-b' }));
    const hostA = {
      options: { shared: { 'shared-lib': { scope: ['default'] } } },
      loadShare: hostALoadShare,
    };
    const hostB = {
      options: { shared: { 'shared-lib': { scope: ['default'] } } },
      loadShare: hostBLoadShare,
    };
    const strategy = await freshStrategy();
    const entryUrl = 'http://localhost:5001/remoteEntry.ssr.js';

    const first = (await strategy.loadViaVmStrategy(entryUrl, {
      ...baseOptions,
      cacheContext: hostA,
      federationInstance: hostA,
    })) as { val: string };
    const second = (await strategy.loadViaVmStrategy(entryUrl, {
      ...baseOptions,
      cacheContext: hostB,
      federationInstance: hostB,
    })) as { val: string };

    expect(first.val).toBe('host-a');
    expect(second.val).toBe('host-b');
    expect(hostALoadShare).toHaveBeenCalledWith('shared-lib');
    expect(hostBLoadShare).toHaveBeenCalledWith('shared-lib');
    expect(global.fetch).toHaveBeenCalledTimes(2);
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

  it('partitions module and namespace caches by resolved shares and scope', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'mf-vm-cache-scope-'));
    const firstShared = join(dir, 'first.mjs');
    const secondShared = join(dir, 'second.mjs');
    writeFileSync(firstShared, 'export const v = "first";', 'utf8');
    writeFileSync(secondShared, 'export const v = "second";', 'utf8');

    const entryUrl = 'http://localhost:5001/remoteEntry.ssr.js';
    global.fetch = makeFetchMock({
      [entryUrl]: {
        ok: true,
        text: 'import { v } from "file-shared"; export const val = v;',
      },
    }) as unknown as typeof globalThis.fetch;
    const strategy = await freshStrategy();

    const first = (await strategy.loadViaVmStrategy(entryUrl, {
      ...baseOptions,
      resolvedShared: { 'file-shared': firstShared },
      shareScopeName: 'first-scope',
      cacheContext: {},
    })) as { val: string };
    const second = (await strategy.loadViaVmStrategy(entryUrl, {
      ...baseOptions,
      resolvedShared: { 'file-shared': secondShared },
      shareScopeName: 'second-scope',
      cacheContext: {},
    })) as { val: string };

    expect(first.val).toBe('first');
    expect(second.val).toBe('second');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
