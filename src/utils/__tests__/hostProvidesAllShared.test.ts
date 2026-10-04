import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectRemoteImports,
  exposeEntryName,
  getIgnoredOptionWarning,
  type HostProvidesAllSharedManifest,
  isRemoteSpecifier,
  readHostProvidesAllSharedManifest,
  remotePublicPath,
  remoteSpecifier,
  shareChunkName,
  sharedKeyOwning,
} from '../hostProvidesAllShared';

const expose = (path: string, file: string) => ({
  id: `remote:${exposeEntryName(path)}`,
  name: exposeEntryName(path),
  path,
  assets: { js: { sync: [file], async: [] }, css: { sync: [], async: [] } },
});

const manifest: HostProvidesAllSharedManifest = {
  id: 'remote',
  name: 'remote',
  metaData: {
    name: 'remote',
    type: 'app',
    globalName: 'remote',
    buildInfo: { buildVersion: '1.0.0', buildName: 'remote' },
    publicPath: 'http://cdn.test/remote/',
  },
  shared: [],
  remotes: [],
  exposes: [
    expose('.', 'index.js'),
    expose('./Button', 'Button.js'),
    expose('./ui/Card', 'ui/Card.js'),
  ],
};

describe('hostProvidesAllShared specifiers', () => {
  it('maps expose keys to fixed entry names and host specifiers', () => {
    expect(exposeEntryName('.')).toBe('index');
    expect(exposeEntryName('./Button')).toBe('Button');
    expect(exposeEntryName('./ui/Card')).toBe('ui/Card');
    expect(remoteSpecifier('remote', '.')).toBe('remote');
    expect(remoteSpecifier('remote', './ui/Card')).toBe('remote/ui/Card');
  });

  it('recognizes a remote alias and its subpaths only', () => {
    expect(isRemoteSpecifier('remote', ['remote'])).toBe(true);
    expect(isRemoteSpecifier('remote/Button', ['remote'])).toBe(true);
    expect(isRemoteSpecifier('remote-ui/Button', ['remote'])).toBe(false);
    expect(isRemoteSpecifier('react', ['remote'])).toBe(false);
  });

  it('finds the longest shared key owning a subpath', () => {
    const keys = ['rxjs', 'lodash-es', 'lodash-es/fp'];
    expect(sharedKeyOwning('rxjs', keys)).toBe('rxjs');
    expect(sharedKeyOwning('rxjs/operators', keys)).toBe('rxjs');
    expect(sharedKeyOwning('lodash-es/fp/map', keys)).toBe('lodash-es/fp');
    expect(sharedKeyOwning('rxjs-compat', keys)).toBeUndefined();
  });

  it('derives a file-safe chunk name per shared key', () => {
    expect(shareChunkName('react')).toBe('shared/react');
    expect(shareChunkName('@angular/core')).toBe('shared/angular-core');
    expect(shareChunkName('react/jsx-runtime')).toBe('shared/react-jsx-runtime');
  });
});

describe('hostProvidesAllShared manifest', () => {
  const withPublicPath = (publicPath: string | undefined): HostProvidesAllSharedManifest => ({
    ...manifest,
    metaData: { ...manifest.metaData, publicPath },
  });

  it('uses metaData.publicPath and infers "auto" from the manifest URL', () => {
    const url = 'http://cdn.test/remote/mf-manifest.json';
    expect(remotePublicPath(manifest, url)).toBe('http://cdn.test/remote/');
    expect(remotePublicPath(withPublicPath('/static'), url)).toBe('/static/');
    expect(remotePublicPath(withPublicPath('auto'), url)).toBe('http://cdn.test/remote/');
    expect(remotePublicPath(withPublicPath(undefined), url)).toBe('http://cdn.test/remote/');
    expect(() =>
      remotePublicPath(withPublicPath('auto'), '../remote/dist/mf-manifest.json')
    ).toThrow(/publicPath is "auto"/);
  });

  it('reads a manifest from disk and rejects a runtime remote', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-importmap-'));
    writeFileSync(path.join(root, 'mf-manifest.json'), JSON.stringify(manifest));
    writeFileSync(
      path.join(root, 'runtime-manifest.json'),
      JSON.stringify({
        ...manifest,
        metaData: {
          ...manifest.metaData,
          remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
        },
      })
    );
    writeFileSync(path.join(root, 'other.json'), JSON.stringify({ name: 'x' }));

    await expect(readHostProvidesAllSharedManifest('mf-manifest.json', root)).resolves.toEqual(
      manifest
    );
    await expect(readHostProvidesAllSharedManifest('runtime-manifest.json', root)).rejects.toThrow(
      /runtime remote/
    );
    await expect(readHostProvidesAllSharedManifest('other.json', root)).rejects.toThrow(
      /not a Module Federation manifest/
    );
  });

  it('collects one import-map entry per expose, resolved against the manifest location', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-importmap-'));
    writeFileSync(
      path.join(root, 'mf-manifest.json'),
      JSON.stringify(withPublicPath('http://cdn.test/remote/'))
    );

    await expect(
      collectRemoteImports({ r: { name: 'r', entry: 'mf-manifest.json' } }, root)
    ).resolves.toEqual({
      r: 'http://cdn.test/remote/index.js',
      'r/Button': 'http://cdn.test/remote/Button.js',
      'r/ui/Card': 'http://cdn.test/remote/ui/Card.js',
    });
  });
});

describe('ignored option warning', () => {
  it('is silent for a plain import-map config', () => {
    expect(
      getIgnoredOptionWarning({
        name: 'host',
        shared: { react: { singleton: true } },
        experiments: { hostProvidesAllShared: true },
      })
    ).toBeUndefined();
  });

  it('names every ignored option, top-level and per share, in one message', () => {
    expect(
      getIgnoredOptionWarning({
        name: 'host',
        filename: 'remoteEntry.js',
        shareStrategy: 'loaded-first',
        runtimePlugins: ['./plugin.ts'],
        manifest: true,
        ignoreOrigin: false,
        experiments: { hostProvidesAllShared: true, provideExternalRuntime: true },
        shared: {
          react: { eager: true, singleton: true },
          rxjs: { requiredVersion: '^7', import: false },
          vue: { strictVersion: true, shareKey: 'vue3' },
          zod: {},
        },
      })
    ).toBe(
      'experiments.hostProvidesAllShared: `filename`, `shareStrategy`, `runtimePlugins`, ' +
        '`experiments.provideExternalRuntime`, `shared.react.eager`, `shared.rxjs.requiredVersion`, ' +
        '`shared.rxjs.import`, `shared.vue.strictVersion`, `shared.vue.shareKey` ignored. ' +
        'The Module Federation runtime is not used and the host provides the only copy of every shared key.'
    );
  });
});
