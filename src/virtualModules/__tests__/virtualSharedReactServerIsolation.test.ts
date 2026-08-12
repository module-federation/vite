import { describe, expect, it } from 'vitest';
import VirtualModule from '../../utils/VirtualModule';
import { getSharedCacheHelperCode } from '../../utils/packageUtils';
import {
  normalizeModuleFederationOptions,
  type ShareItem,
} from '../../utils/normalizeModuleFederationOptions';
import {
  getLoadShareModulePath,
  getPreBuildLibImportId,
  writeLoadShareModule,
  writePreBuildLibPath,
} from '../virtualShared_preBuild';
import {
  generateHostAutoInitCode,
  generateRemoteEntry,
  getHostAutoInitPath,
  isOwnedHostAutoInitId,
  writeHostAutoInit,
} from '../virtualRemoteEntry';
import {
  MODULE_CACHE_GLOBAL_KEY,
  REACT_SERVER_MODULE_CACHE_GLOBAL_KEY,
  getModuleCacheGlobalKey,
} from '../virtualRuntimeInitStatus';

const REACT_SERVER_CONDITIONS = ['react-server', 'node', 'import', 'default'];
const CLIENT_CONDITIONS = ['browser', 'import', 'default'];

function makeOptions(name: string) {
  return normalizeModuleFederationOptions({ name, shared: {} });
}

function makeReactShareItem(): ShareItem {
  return {
    name: 'react',
    from: 'rsc-host',
    version: '19.2.8',
    scope: 'default',
    shareConfig: {
      import: 'react',
      singleton: true,
      requiredVersion: '^19.0.0',
    },
  };
}

type CacheHelpers = {
  write: (
    cache: Record<string, unknown>,
    descriptor: { canonical: string; aliases?: string[] },
    value: unknown,
    owner?: string
  ) => unknown;
  read: (
    cache: Record<string, unknown>,
    descriptor: { canonical: string; aliases?: string[] }
  ) => unknown;
};

function instantiateCacheHelpers(exportConditions?: string[]): CacheHelpers {
  const code = getSharedCacheHelperCode(exportConditions);
  const factory = new Function(
    `${code}; return { write: __mfWriteSharedCache, read: __mfReadSharedCache };`
  );
  return factory() as CacheHelpers;
}

const REACT_DESCRIPTOR = { canonical: 'default:react', aliases: ['react'] };

const serverFlavorReact = {
  __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {},
  cache: () => undefined,
  version: '19.2.8',
};

const clientFlavorReact = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {},
  useState: () => undefined,
  version: '19.2.8',
};

describe('react-server environment share-cache isolation', () => {
  it('selects the react-server cache key only for react-server conditions', () => {
    expect(getModuleCacheGlobalKey()).toBe(MODULE_CACHE_GLOBAL_KEY);
    expect(getModuleCacheGlobalKey(CLIENT_CONDITIONS)).toBe(MODULE_CACHE_GLOBAL_KEY);
    expect(getModuleCacheGlobalKey(REACT_SERVER_CONDITIONS)).toBe(
      REACT_SERVER_MODULE_CACHE_GLOBAL_KEY
    );
    expect(REACT_SERVER_MODULE_CACHE_GLOBAL_KEY).not.toBe(MODULE_CACHE_GLOBAL_KEY);
  });

  it('stamps loadShare wrappers with the cache key of the requesting environment', () => {
    const options = makeOptions('rsc-loadshare-host');
    const share = makeReactShareItem();

    writeLoadShareModule('react', share, 'build', false, options, REACT_SERVER_CONDITIONS);
    const loadSharePath = getLoadShareModulePath('react', false, options);
    const reactServerCode = VirtualModule.findById(loadSharePath)?.code ?? '';
    expect(reactServerCode).toContain(REACT_SERVER_MODULE_CACHE_GLOBAL_KEY);
    expect(reactServerCode).not.toContain(`"${MODULE_CACHE_GLOBAL_KEY}"`);

    // A later environment (e.g. ssr) must refresh the same module back to the
    // default cache key.
    writeLoadShareModule('react', share, 'build', false, options, CLIENT_CONDITIONS);
    const clientCode = VirtualModule.findById(loadSharePath)?.code ?? '';
    expect(clientCode).toContain(`"${MODULE_CACHE_GLOBAL_KEY}"`);
    expect(clientCode).not.toContain(REACT_SERVER_MODULE_CACHE_GLOBAL_KEY);
  });

  it('stamps the react/compiler-runtime prebuild with the environment cache key', () => {
    const options = makeOptions('rsc-prebuild-host');
    const share = makeReactShareItem();

    writePreBuildLibPath('react/compiler-runtime', share, options, REACT_SERVER_CONDITIONS);
    const preBuildPath = getPreBuildLibImportId('react/compiler-runtime', options);
    const reactServerCode = VirtualModule.findById(preBuildPath)?.code ?? '';
    expect(reactServerCode).toContain(REACT_SERVER_MODULE_CACHE_GLOBAL_KEY);
    expect(reactServerCode).not.toContain(`"${MODULE_CACHE_GLOBAL_KEY}"`);

    writePreBuildLibPath('react/compiler-runtime', share, options, CLIENT_CONDITIONS);
    const clientCode = VirtualModule.findById(preBuildPath)?.code ?? '';
    expect(clientCode).toContain(`"${MODULE_CACHE_GLOBAL_KEY}"`);
  });

  it('stamps hostAutoInit with the environment cache key', () => {
    const options = makeOptions('rsc-autoinit-host');

    const reactServerCode = generateHostAutoInitCode(
      '"virtual:mf-REMOTE_ENTRY_ID"',
      'build',
      options,
      REACT_SERVER_CONDITIONS
    );
    expect(reactServerCode).toContain(REACT_SERVER_MODULE_CACHE_GLOBAL_KEY);
    expect(reactServerCode).not.toContain(`"${MODULE_CACHE_GLOBAL_KEY}"`);

    const defaultCode = generateHostAutoInitCode('"virtual:mf-REMOTE_ENTRY_ID"', 'build', options);
    expect(defaultCode).toContain(`"${MODULE_CACHE_GLOBAL_KEY}"`);
    expect(defaultCode).not.toContain(REACT_SERVER_MODULE_CACHE_GLOBAL_KEY);
  });

  it('stamps the generated remote entry with the environment cache key', () => {
    const options = makeOptions('rsc-remote-entry-host');

    const reactServerCode = generateRemoteEntry(
      options,
      undefined,
      'build',
      REACT_SERVER_CONDITIONS
    );
    expect(reactServerCode).toContain(REACT_SERVER_MODULE_CACHE_GLOBAL_KEY);
    expect(reactServerCode).not.toContain(`"${MODULE_CACHE_GLOBAL_KEY}"`);

    const defaultCode = generateRemoteEntry(options, undefined, 'build');
    expect(defaultCode).toContain(`"${MODULE_CACHE_GLOBAL_KEY}"`);
  });

  it('hostAutoInit republishes the local share when the runtime returns a wrong-flavor react', () => {
    const options = makeOptions('rsc-fallback-host');

    const code = generateHostAutoInitCode('"virtual:mf-REMOTE_ENTRY_ID"', 'build', options);
    expect(code).toContain('__mfSharedReactFlavorMismatch(cacheDescriptor, resolvedShare)');
    expect(code).toContain('share.get');
  });

  it('write helper refuses a react-server flavored react in the default bucket', () => {
    const { write, read } = instantiateCacheHelpers();
    const cache: Record<string, unknown> = {};

    write(cache, REACT_DESCRIPTOR, serverFlavorReact, 'host');
    expect(read(cache, REACT_DESCRIPTOR)).toBeUndefined();

    write(cache, REACT_DESCRIPTOR, clientFlavorReact, 'host');
    expect(read(cache, REACT_DESCRIPTOR)).toBe(clientFlavorReact);
  });

  it('write helper refuses a client flavored react in the react-server bucket', () => {
    const { write, read } = instantiateCacheHelpers(REACT_SERVER_CONDITIONS);
    const cache: Record<string, unknown> = {};

    write(cache, REACT_DESCRIPTOR, clientFlavorReact, 'host');
    expect(read(cache, REACT_DESCRIPTOR)).toBeUndefined();

    write(cache, REACT_DESCRIPTOR, serverFlavorReact, 'host');
    expect(read(cache, REACT_DESCRIPTOR)).toBe(serverFlavorReact);
  });

  it('write helper refuses a react-server flavored react-dom in the default bucket', () => {
    // React 19 ships __DOM_INTERNALS and the preload family in BOTH react-dom
    // flavors; only createPortal/flushSync distinguish the client build.
    const { write, read } = instantiateCacheHelpers();
    const cache: Record<string, unknown> = {};
    const descriptor = { canonical: 'default:react-dom', aliases: ['react-dom'] };
    const serverFlavorReactDom = {
      __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {},
      preload: () => undefined,
      preinit: () => undefined,
      version: '19.2.8',
    };
    const clientFlavorReactDom = {
      __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {},
      preload: () => undefined,
      createPortal: () => undefined,
      flushSync: () => undefined,
      version: '19.2.8',
    };

    write(cache, descriptor, serverFlavorReactDom, 'host');
    expect(read(cache, descriptor)).toBeUndefined();

    write(cache, descriptor, clientFlavorReactDom, 'host');
    expect(read(cache, descriptor)).toBe(clientFlavorReactDom);
  });

  it('write helper refuses a client flavored react-dom in the react-server bucket', () => {
    const { write, read } = instantiateCacheHelpers(REACT_SERVER_CONDITIONS);
    const cache: Record<string, unknown> = {};
    const descriptor = { canonical: 'default:react-dom', aliases: ['react-dom'] };
    const serverFlavorReactDom = {
      preload: () => undefined,
      version: '19.2.8',
    };
    const clientFlavorReactDom = {
      preload: () => undefined,
      createPortal: () => undefined,
      version: '19.2.8',
    };

    write(cache, descriptor, clientFlavorReactDom, 'host');
    expect(read(cache, descriptor)).toBeUndefined();

    write(cache, descriptor, serverFlavorReactDom, 'host');
    expect(read(cache, descriptor)).toBe(serverFlavorReactDom);
  });

  it('write helper keeps caching flavor-ambiguous react-dom subpaths', () => {
    // react-dom/client has no react-server variant; its client build exports
    // neither createPortal nor preload, so it must stay cacheable everywhere.
    const { write, read } = instantiateCacheHelpers();
    const cache: Record<string, unknown> = {};
    const descriptor = {
      canonical: 'default:react-dom/client',
      aliases: ['react-dom/client'],
    };
    const reactDomClient = {
      createRoot: () => undefined,
      hydrateRoot: () => undefined,
      version: '19.2.8',
    };

    write(cache, descriptor, reactDomClient, 'host');
    expect(read(cache, descriptor)).toBe(reactDomClient);
  });

  it('omits the flavor guard from client bundles', () => {
    // The react-server flavor can never appear in a browser process, so the
    // detection logic would be dead bytes in client bundles. Only a one-line
    // always-false stub remains, so references never break.
    const clientHelperCode = getSharedCacheHelperCode(CLIENT_CONDITIONS);
    expect(clientHelperCode).toContain('const __mfSharedReactFlavorMismatch = () => false;');
    expect(clientHelperCode).not.toContain('__SERVER_INTERNALS_DO_NOT_USE');
    expect(clientHelperCode).not.toContain('__mfWarnFlavorRejection');

    const { write, read } = instantiateCacheHelpers(CLIENT_CONDITIONS);
    const cache: Record<string, unknown> = {};
    write(cache, REACT_DESCRIPTOR, serverFlavorReact, 'host');
    expect(read(cache, REACT_DESCRIPTOR)).toBe(serverFlavorReact);

    const options = makeOptions('client-autoinit-host');
    const clientAutoInit = generateHostAutoInitCode(
      '"virtual:mf-REMOTE_ENTRY_ID"',
      'build',
      options,
      CLIENT_CONDITIONS
    );
    // The stub definition rides along via the embedded helper, but the
    // republish fallback (the only caller) is not emitted for client bundles.
    expect(clientAutoInit).toContain('const __mfSharedReactFlavorMismatch = () => false;');
    expect(clientAutoInit).not.toContain('__mfSharedReactFlavorMismatch(cacheDescriptor');
  });

  it('keeps the flavor guard for server bundles and unrefreshed writes', () => {
    expect(getSharedCacheHelperCode()).toContain('__mfSharedReactFlavorMismatch');
    expect(getSharedCacheHelperCode(['node', 'import', 'default'])).toContain(
      '__mfSharedReactFlavorMismatch'
    );
    expect(getSharedCacheHelperCode(REACT_SERVER_CONDITIONS)).toContain(
      '__mfSharedReactFlavorMismatch'
    );
  });

  it('write helper refuses wrong-flavor react under versioned canonicals', () => {
    // Non-singleton shares key the cache as "default:react@<version>"; the
    // guard must strip the version when matching react-family packages.
    const { write, read } = instantiateCacheHelpers();
    const cache: Record<string, unknown> = {};
    const descriptor = { canonical: 'default:react@19.2.8', aliases: ['react@19.2.8'] };

    write(cache, descriptor, serverFlavorReact, 'host');
    expect(read(cache, descriptor)).toBeUndefined();

    write(cache, descriptor, clientFlavorReact, 'host');
    expect(read(cache, descriptor)).toBe(clientFlavorReact);
  });

  it('write helper refuses wrong-flavor react-dom subpaths under versioned canonicals', () => {
    const { write, read } = instantiateCacheHelpers();
    const cache: Record<string, unknown> = {};
    const descriptor = {
      canonical: 'default:react-dom@19.2.8',
      aliases: ['react-dom@19.2.8'],
    };
    const serverFlavorReactDom = { preload: () => undefined, version: '19.2.8' };

    write(cache, descriptor, serverFlavorReactDom, 'host');
    expect(read(cache, descriptor)).toBeUndefined();
  });

  it('write helper keeps caching scoped packages with versioned canonicals', () => {
    // "@scope/pkg@1.0.0" must not be mangled by version stripping into a
    // react-family match or an empty name.
    const { write, read } = instantiateCacheHelpers();
    const cache: Record<string, unknown> = {};
    const descriptor = {
      canonical: 'default:@scope/react-widgets@1.0.0',
      aliases: ['@scope/react-widgets@1.0.0'],
    };
    const mod = { render: () => undefined };

    write(cache, descriptor, mod, 'host');
    expect(read(cache, descriptor)).toBe(mod);
  });

  it('defines the flavor-mismatch helper even when the guard is omitted', () => {
    // Client bundles skip the guard for size, but generated code paths that
    // reference __mfSharedReactFlavorMismatch must never hit a ReferenceError.
    const code = getSharedCacheHelperCode(CLIENT_CONDITIONS);
    const factory = new Function(`${code}; return __mfSharedReactFlavorMismatch;`);
    const mismatch = factory() as (d: unknown, v: unknown) => boolean;
    expect(typeof mismatch).toBe('function');
    expect(mismatch({ canonical: 'default:react' }, serverFlavorReact)).toBe(false);
  });

  it('warns once per canonical when the guard rejects a write outside production', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { write } = instantiateCacheHelpers();
      const cache: Record<string, unknown> = {};

      write(cache, REACT_DESCRIPTOR, serverFlavorReact, 'host');
      write(cache, REACT_DESCRIPTOR, serverFlavorReact, 'host');

      const flavorWarnings = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes('react')
      );
      expect(flavorWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('hostAutoInit republish fallback never runs for host-provided shares', () => {
    // share.get() for import:false shares is generated to throw; the fallback
    // must skip them and contain any local-provider failure instead of
    // rejecting hostInitPromise.
    const options = makeOptions('rsc-import-false-host');

    const code = generateHostAutoInitCode('"virtual:mf-REMOTE_ENTRY_ID"', 'build', options);
    expect(code).toContain('share.shareConfig?.import !== false');
    expect(code).toMatch(/try \{[\s\S]*?await share\.get\(\)[\s\S]*?\} catch/);
  });

  it('only the owning federation instance refreshes its hostAutoInit module', () => {
    // Multi-instance configs: every instance's load hook fires for every
    // __H_A_I__ id. Without an ownership check, instance A's hook would
    // regenerate A's module when B's id was requested and B's per-environment
    // refresh would never run (index.ts mirrors the loadShare 'not-owned'
    // bail using this predicate).
    const optionsA = makeOptions('hai-owner-a');
    const optionsB = makeOptions('hai-owner-b');
    writeHostAutoInit('virtual:mf-REMOTE_ENTRY_ID', 'build', optionsA);
    writeHostAutoInit('virtual:mf-REMOTE_ENTRY_ID', 'build', optionsB);

    const idA = getHostAutoInitPath(optionsA);
    const idB = getHostAutoInitPath(optionsB);
    expect(idA).not.toBe(idB);
    expect(isOwnedHostAutoInitId(idA, optionsA)).toBe(true);
    expect(isOwnedHostAutoInitId(idB, optionsA)).toBe(false);
    expect(isOwnedHostAutoInitId(idB, optionsB)).toBe(true);
    expect(isOwnedHostAutoInitId('/some/unrelated/module.js', optionsA)).toBe(false);
  });

  it('write helper keeps caching non-react shares regardless of flavor markers', () => {
    const { write, read } = instantiateCacheHelpers();
    const cache: Record<string, unknown> = {};
    const descriptor = { canonical: 'default:lodash', aliases: ['lodash'] };
    const lodash = { debounce: () => undefined };

    write(cache, descriptor, lodash, 'host');
    expect(read(cache, descriptor)).toBe(lodash);
  });
});
