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
import { generateHostAutoInitCode, generateRemoteEntry } from '../virtualRemoteEntry';
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

  it('write helper keeps caching non-react shares regardless of flavor markers', () => {
    const { write, read } = instantiateCacheHelpers();
    const cache: Record<string, unknown> = {};
    const descriptor = { canonical: 'default:lodash', aliases: ['lodash'] };
    const lodash = { debounce: () => undefined };

    write(cache, descriptor, lodash, 'host');
    expect(read(cache, descriptor)).toBe(lodash);
  });
});
