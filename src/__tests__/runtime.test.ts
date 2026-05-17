import { beforeEach, describe, expect, it, vi } from 'vitest';

const { initMock, loadRemoteMock, registerRemotesMock } = vi.hoisted(() => ({
  initMock: vi.fn((options: unknown) => ({ options })),
  loadRemoteMock: vi.fn(),
  registerRemotesMock: vi.fn(),
}));

vi.mock('@module-federation/runtime', () => ({
  getInstance: vi.fn(() => null),
  init: initMock,
  loadRemote: loadRemoteMock,
  registerRemotes: registerRemotesMock,
}));

import {
  createFederationRuntimeScope,
  createServerFederationInstance,
  fetchFederationManifest,
  loadRemoteFromManifest,
  registerManifestRemote,
} from '../runtime';

function makeManifest() {
  return {
    name: 'remote',
    metaData: {
      globalName: 'remote',
      publicPath: 'http://localhost:4174/assets/',
      remoteEntry: {
        name: 'remoteEntry.js',
        path: '',
        type: 'module',
      },
      ssrRemoteEntry: {
        name: 'remoteEntry.ssr.js',
        path: '',
        type: 'module',
      },
    },
  };
}

function makeFetch(manifest = makeManifest()) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => manifest,
  })) as unknown as typeof fetch;
}

describe('runtime helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and caches federation manifests', async () => {
    const fetch = makeFetch();
    const first = await fetchFederationManifest('http://localhost:4174/mf-manifest.json', {
      fetch,
      runtimeKey: 'cache-test',
    });
    const second = await fetchFederationManifest('http://localhost:4174/mf-manifest.json', {
      fetch,
      runtimeKey: 'cache-test',
    });

    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('registers browser remote entries from manifests', async () => {
    const fetch = makeFetch();

    await registerManifestRemote('catalog', 'http://localhost:4174/mf-manifest.json', {
      fetch,
      target: 'web',
    });

    expect(registerRemotesMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          alias: 'catalog',
          entry: 'http://localhost:4174/assets/remoteEntry.js',
          name: 'remote',
          type: 'module',
        }),
      ],
      { force: undefined }
    );
  });

  it('registers SSR remote entries for node targets', async () => {
    const fetch = makeFetch();

    await registerManifestRemote('catalog', 'http://localhost:4174/mf-manifest.json', {
      fetch,
      target: 'node',
    });

    expect(registerRemotesMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          alias: 'catalog',
          entry: 'http://localhost:4174/assets/remoteEntry.ssr.js',
          name: 'remote',
          type: 'module',
        }),
      ],
      { force: undefined }
    );
  });

  it('loads remotes after manifest registration', async () => {
    const fetch = makeFetch();
    loadRemoteMock.mockResolvedValue({ default: 'remote module' });

    const loaded = await loadRemoteFromManifest('catalog/Button', 'http://localhost/mf.json', {
      fetch,
      target: 'node',
    });

    expect(loaded).toEqual({ default: 'remote module' });
    expect(loadRemoteMock).toHaveBeenCalledWith('catalog/Button', { from: 'runtime' });
  });

  it('creates server runtimes with the SSR entry loader plugin installed first', () => {
    createServerFederationInstance({
      name: 'nuxt-host',
      remotes: [],
      shared: {},
      plugins: [{ name: 'user-plugin' }],
    });

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inBrowser: false,
        plugins: [
          expect.objectContaining({ name: 'mf-vite:ssr-entry-loader' }),
          expect.objectContaining({ name: 'user-plugin' }),
        ],
      })
    );
  });

  it('scopes manifest caches by runtime key', async () => {
    const fetch = makeFetch();
    const tenantA = createFederationRuntimeScope('tenant-a');
    const tenantB = createFederationRuntimeScope('tenant-b');

    await tenantA.fetchFederationManifest('http://localhost/mf-manifest.json', { fetch });
    await tenantB.fetchFederationManifest('http://localhost/mf-manifest.json', { fetch });
    await tenantA.fetchFederationManifest('http://localhost/mf-manifest.json', { fetch });

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
