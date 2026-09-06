import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultMockOptions } from '../../utils/__tests__/helpers';
import { addUsedShares, getUsedShares } from '../virtualRemoteEntry';
import {
  generateRemoteEntrySSR,
  getRemoteEntrySSRId,
  getSsrExposesFileName,
  getSsrRemoteEntryFileName,
} from '../virtualRemoteEntrySSR';
import { MODULE_CACHE_SHARE_SCOPE_KEY } from '../virtualRuntimeInitStatus';

type SsrEntry = {
  init: (shared?: Record<string, unknown>, initScope?: unknown[]) => Promise<unknown>;
};

function singleton(name: string) {
  return {
    name,
    version: '19.0.0',
    scope: 'default',
    from: '',
    shareConfig: { singleton: true, requiredVersion: '^19.0.0' },
  };
}

function evaluateGeneratedEntry(
  code: string,
  runtimeInit: () => Record<string, unknown>,
  dynamicImport: (id: string) => Promise<unknown> = () =>
    Promise.reject(new Error('unexpected import'))
): SsrEntry {
  const runnable = code
    .replace('import { init as runtimeInit } from "@module-federation/runtime";', '')
    .replace(
      'const sharedSingletons =',
      'const runtimeInitImpl = __runtimeInit;\n  const sharedSingletons ='
    )
    .replace(/runtimeInit\(/g, 'runtimeInitImpl(')
    .replace(/import\(("virtual:[^"]+")\)/, '__dynamicImport($1)')
    .replace('export { init, getExposes as get };', 'return { init, get: getExposes };');

  return new Function('__runtimeInit', '__dynamicImport', runnable)(
    runtimeInit,
    dynamicImport
  ) as SsrEntry;
}

function createEntry(
  runtimeInit: () => Record<string, unknown>,
  options: Record<string, unknown> = {},
  dynamicImport?: (id: string) => Promise<unknown>
) {
  return evaluateGeneratedEntry(
    generateRemoteEntrySSR(getDefaultMockOptions({ name: 'remote', ...options } as any)),
    runtimeInit,
    dynamicImport
  );
}

function createRuntime(
  initializeSharing: unknown = vi.fn(async () => []),
  loadShare: unknown = vi.fn(),
  runtime?: unknown
) {
  return vi.fn(() => ({
    initShareScopeMap: vi.fn(),
    initializeSharing,
    loadShare,
    runtime,
  }));
}

beforeEach(() => {
  getUsedShares().clear();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__mf_module_cache__;
  getUsedShares().clear();
});

describe('virtualRemoteEntrySSR', () => {
  describe('getSsrRemoteEntryFileName', () => {
    it('maps remoteEntry.js to remoteEntry.ssr.js', () => {
      expect(getSsrRemoteEntryFileName('remoteEntry.js')).toBe('remoteEntry.ssr.js');
    });

    it('strips [hash] placeholders to a stable SSR companion', () => {
      expect(getSsrRemoteEntryFileName('remoteEntry-[hash]')).toBe('remoteEntry.ssr.js');
      expect(getSsrRemoteEntryFileName('remoteEntry-[hash].js')).toBe('remoteEntry.ssr.js');
      expect(getSsrRemoteEntryFileName('remote-entry-[hash:8].js')).toBe('remote-entry.ssr.js');
    });

    it('never leaves a literal [hash] in the SSR filename', () => {
      expect(getSsrRemoteEntryFileName('remoteEntry-[hash].js')).not.toContain('[hash');
      expect(getSsrRemoteEntryFileName('mf-[hash:8]')).not.toContain('[hash');
    });
  });

  describe('getSsrExposesFileName', () => {
    it('maps remoteEntry.js to remoteEntry.exposes.js', () => {
      expect(getSsrExposesFileName('remoteEntry.js')).toBe('remoteEntry.exposes.js');
    });

    it('strips [hash] placeholders to a stable exposes companion', () => {
      expect(getSsrExposesFileName('remoteEntry-[hash]')).toBe('remoteEntry.exposes.js');
      expect(getSsrExposesFileName('remoteEntry-[hash].js')).toBe('remoteEntry.exposes.js');
      expect(getSsrExposesFileName('remote-entry-[hash:8].js')).toBe('remote-entry.exposes.js');
    });

    it('never leaves a literal [hash] in the exposes filename', () => {
      expect(getSsrExposesFileName('remoteEntry-[hash].js')).not.toContain('[hash');
      expect(getSsrExposesFileName('mf-[hash:8]')).not.toContain('[hash');
    });
  });

  it('uses public runtime name while keeping internal virtual IDs', () => {
    const options = getDefaultMockOptions({
      internalName: '__mfe_internal__remote',
      name: 'remote',
      filename: 'remoteEntry.js',
      shareStrategy: 'version-first',
    });

    const code = generateRemoteEntrySSR(options);

    expect(code).toContain('name: "remote"');
    expect(code).toContain('const initToken = { from: "remote" }');
    expect(code).toContain(
      'import("virtual:mf-exposes-ssr:__mfe_internal__remote__remoteEntry_js")'
    );
    expect(getRemoteEntrySSRId(options)).toBe(
      'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js'
    );
    expect(code).not.toContain('name: "__mfe_internal__remote"');
    expect(code).not.toContain('from: "__mfe_internal__remote"');
  });

  it('initializes all configured SSR provider share scopes', () => {
    const options = getDefaultMockOptions({
      name: 'remote',
      shareScope: ['default', 'scope1'],
      shareStrategy: 'version-first',
    } as any);

    const code = generateRemoteEntrySSR(options);

    expect(code).toContain('const shareScopeNames = Array.isArray(["default","scope1"])');
    expect(code).toContain('for (const scopeName of shareScopeNames)');
    expect(code).not.toContain("console.error('[Module Federation SSR]', e);");
    expect(code).toContain('const shareInitErrors = []');
    expect(code).toContain('throw createShareInitError(shareInitErrors)');
    expect(code).toContain('initRes.initShareScopeMap(scopeName, scopeShare)');
    expect(code).toContain('initRes.initializeSharing(scopeName');
  });

  it('caches host-provided SSR singletons during container init', () => {
    const options = getDefaultMockOptions({
      name: 'remote',
      shared: {
        react: {
          name: 'react',
          version: '19.0.0',
          scope: 'default',
          from: '',
          shareConfig: { singleton: true, requiredVersion: '^19.0.0' },
        },
        lodash: {
          name: 'lodash',
          version: '4.17.21',
          scope: 'default',
          from: '',
          shareConfig: { singleton: false, requiredVersion: '^4.17.21' },
        },
      },
    } as any);

    const code = generateRemoteEntrySSR(options);

    expect(code).toContain('const sharedSingletons = {"react"');
    expect(code).not.toContain('"lodash"');
    expect(code).toContain('const factory = await initRes.loadShare(pkg');
    expect(code).toContain('cacheEntries.push({ scopeName, pkg, module })');
    expect(code.slice(0, code.indexOf('async function'))).not.toContain('await ');
  });

  it('rejects init when initializeSharing fails before evaluating exposes', async () => {
    const initializeSharing = vi.fn(async () => {
      throw new Error('share negotiation failed');
    });
    const runtimeInit = createRuntime(initializeSharing);
    const dynamicImport = vi.fn(async () => ({ default: {} }));
    const entry = createEntry(
      runtimeInit,
      { exposes: { './Widget': { import: './Widget.ts' } as any } },
      dynamicImport
    );

    await expect(entry.init({})).rejects.toThrow(
      '[Module Federation SSR] Shared initialization failed: scope "default": share negotiation failed'
    );

    expect(initializeSharing).toHaveBeenCalledOnce();
    expect(dynamicImport).not.toHaveBeenCalled();
  });

  it('allows the SSR local fallback when a singleton is absent from the host share scope', async () => {
    const loadShare = vi.fn();
    const runtimeInit = createRuntime(undefined, loadShare);
    const entry = createEntry(runtimeInit, { shared: { react: singleton('react') } });

    await expect(entry.init({})).resolves.toBeDefined();
    expect(loadShare).not.toHaveBeenCalled();
  });

  it('rejects init when runtime cannot select a compatible singleton provider', async () => {
    const loadShare = vi.fn(async () => false);
    const runtimeInit = createRuntime(undefined, loadShare);
    const entry = createEntry(runtimeInit, { shared: { react: singleton('react') } });

    await expect(entry.init({ react: {} })).rejects.toThrow(
      'scope "default" package "react": No compatible host provider was selected'
    );
  });

  it('aggregates failures from multiple scopes and singleton packages', async () => {
    const initializeSharing = vi.fn(async (scopeName: string) => {
      if (scopeName === 'scope1') throw new Error('scope initialization failed');
      return [];
    });
    const loadShare = vi.fn(async (pkg: string) => {
      throw new Error(`${pkg} negotiation failed`);
    });
    const runtimeInit = createRuntime(initializeSharing, loadShare);
    const entry = createEntry(runtimeInit, {
      shareScope: ['default', 'scope1'],
      shared: {
        react: singleton('react'),
        'react-dom': singleton('react-dom'),
      },
    });

    let failure: unknown;
    try {
      await entry.init({ default: { react: {}, 'react-dom': {} }, scope1: {} });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'AggregateError',
      message: expect.stringContaining('scope "default" package "react"'),
    });
    expect((failure as Error).message).toContain('scope "default" package "react-dom"');
    expect((failure as Error).message).toContain('scope "scope1": scope initialization failed');
    expect(initializeSharing).toHaveBeenCalledWith('scope1', expect.any(Object));
    expect(loadShare).toHaveBeenCalledTimes(2);
  });

  it('does not write cache entries when init fails', async () => {
    const existing = { marker: 'existing' };
    (globalThis as any).__mf_module_cache__ = {
      share: { 'default:existing': existing },
      remote: {},
    };
    const loadShare = vi.fn(async (pkg: string) => {
      if (pkg === 'react-dom') throw new Error('react-dom negotiation failed');
      return () => ({ marker: 'react' });
    });
    const runtimeInit = createRuntime(undefined, loadShare);
    const entry = createEntry(runtimeInit, {
      shared: {
        react: singleton('react'),
        'react-dom': singleton('react-dom'),
      },
    });

    await expect(entry.init({ react: {}, 'react-dom': {} })).rejects.toThrow(
      'scope "default" package "react-dom"'
    );

    expect((globalThis as any).__mf_module_cache__.share).toEqual({
      'default:existing': existing,
    });
  });

  it('keeps normal host singleton initialization successful', async () => {
    const loadShare = vi.fn(async () => () => ({ marker: 'host-react' }));
    const runtime = { marker: 'runtime' };
    const runtimeInit = createRuntime(undefined, loadShare, runtime);
    const entry = createEntry(runtimeInit, { shared: { react: singleton('react') } });

    await expect(entry.init({ react: {} })).resolves.toMatchObject({ runtime });
    expect(loadShare).toHaveBeenCalledWith('react', expect.any(Object));
    expect((globalThis as any).__mf_module_cache__.share).toMatchObject({
      'default:react': { marker: 'host-react' },
      react: { marker: 'host-react' },
    });
  });

  it('writes negotiated singletons only to the requesting environment cache', async () => {
    const module = { marker: 'react-server' };
    const environmentCache = { share: {}, remote: {} };
    const entry = createEntry(
      createRuntime(
        undefined,
        vi.fn(async () => () => module)
      ),
      {
        shared: { react: singleton('react') },
      }
    );

    const shared = { react: {} } as Record<PropertyKey, unknown>;
    shared[Symbol.for(MODULE_CACHE_SHARE_SCOPE_KEY)] = environmentCache;
    await entry.init(shared as Record<string, unknown>);

    expect(environmentCache.share).toMatchObject({
      'default:react': module,
      react: module,
    });
    expect((globalThis as any).__mf_module_cache__).toBeUndefined();
  });

  it('expands react/ prefix into concrete SSR loadShare targets, never the prefix string', async () => {
    const reactNamespace = {
      name: 'react/',
      version: '19.0.0',
      scope: 'default',
      from: '',
      shareConfig: { singleton: true, import: false, requiredVersion: '^19.0.0' },
    };
    const options = getDefaultMockOptions({
      name: 'remote',
      shared: { 'react/': reactNamespace },
    } as any);

    addUsedShares('react', options);
    addUsedShares('react/jsx-runtime', options);

    const code = generateRemoteEntrySSR(options);
    expect(code).toContain('"react"');
    expect(code).toContain('"react/jsx-runtime"');
    expect(code).not.toContain('"react/"');

    const loadShare = vi.fn(async (pkg: string) => () => ({ marker: pkg }));
    const entry = evaluateGeneratedEntry(code, createRuntime(undefined, loadShare));

    await expect(entry.init({ react: {}, 'react/jsx-runtime': {} })).resolves.toBeDefined();

    expect(loadShare.mock.calls.map(([pkg]) => pkg).sort()).toEqual(['react', 'react/jsx-runtime']);
    expect(loadShare.mock.calls.some(([pkg]) => pkg === 'react/')).toBe(false);
  });
});
