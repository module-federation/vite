import { mkdir, rm, symlink } from 'fs/promises';
import { dirname, resolve } from 'path';
import { version as viteVersion } from 'vite';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture, FIXTURES } from './helpers/build';
import { findChunk, getAllChunkCode, getChunkNames, getHtmlAsset } from './helpers/matchers';

const HOST_BASE_MF_OPTIONS = {
  name: 'hostApp',
  filename: 'remoteEntry.js',
  remotes: {
    remote1: {
      name: 'remote1',
      entry: 'http://localhost:3001/remoteEntry.js',
      type: 'module',
    },
  },
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

const LOADED_FIRST_STATIC_MF_OPTIONS = {
  ...HOST_BASE_MF_OPTIONS,
  shareStrategy: 'loaded-first',
  hostInitInjectLocation: 'html',
} satisfies Partial<ModuleFederationOptions>;

const hostInitChunkRegex = /<script\s+type="module"\s+src="[^"]*hostInit[^"]*">/;
const bootstrapScriptRegex = /<script\s+type="module"[^>]+src="[^"]*mf-entry-bootstrap[^"]*">/;
// Vite 5 does not support the vite-ignore HTML attribute.
const itSupportsViteIgnore = it.skipIf(viteVersion.startsWith('5.'));

async function createWorkspaceFixture() {
  const root = resolve(FIXTURES, 'workspace-source-remote');
  const remotePackage = resolve(root, 'packages/remote-ui');
  const remotePackageLink = resolve(root, 'packages/host/node_modules/@repro/remote-ui');
  await rm(resolve(root, 'packages/host/node_modules'), { recursive: true, force: true });
  await mkdir(dirname(remotePackageLink), { recursive: true });
  await symlink(remotePackage, remotePackageLink, 'dir');

  return root;
}

describe('host build', () => {
  it.each([
    ['named', 'loaded-first-static-host'],
    ['namespace', 'loaded-first-namespace-host'],
  ])('preloads %s static remotes before a loaded-first host entry', async (_kind, fixture) => {
    const output = await buildFixture({
      fixture,
      mfOptions: LOADED_FIRST_STATIC_MF_OPTIONS,
    });

    const bootstrapAsset = output.output.find(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );
    expect(bootstrapAsset).toBeDefined();
    const bootstrapCode = (bootstrapAsset as unknown as { source: string }).source;
    const preloadIndex = bootstrapCode.indexOf('__mfPreloadRemote("');
    const entryImportIndex = bootstrapCode.indexOf('})().then(() =>');

    expect(preloadIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapCode).toContain('"remote1/Module"');
    expect(bootstrapCode).toContain('await Promise.all(__mfRemotePreloads);');
    expect(bootstrapCode).not.toContain('Promise.allSettled(__mfRemotePreloads)');
    expect(bootstrapCode).toContain('runtime.registerRemotes([registration]);');
    expect(preloadIndex).toBeLessThan(entryImportIndex);
    expect(bootstrapCode).not.toMatch(/^await /m);
  });

  it('keeps dynamic-only remotes lazy with loaded-first', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: LOADED_FIRST_STATIC_MF_OPTIONS,
    });
    const bootstrapAsset = output.output.find(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );

    expect(bootstrapAsset).toBeDefined();
    const bootstrapCode = (bootstrapAsset as unknown as { source: string }).source;
    expect(bootstrapCode).not.toContain('__mfPreloadRemote');
    expect(bootstrapCode).not.toContain('Promise.all(__mfRemotePreloads)');
    expect(bootstrapCode).toContain('await initHost();');
  });

  it('prefetches module remote entries before host init for version-first', async () => {
    const output = await buildFixture({
      fixture: 'loaded-first-static-host',
      mfOptions: { ...HOST_BASE_MF_OPTIONS, hostInitInjectLocation: 'html' },
    });
    const bootstrapAsset = output.output.find(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );

    expect(bootstrapAsset).toBeDefined();
    const bootstrapCode = (bootstrapAsset as unknown as { source: string }).source;
    const prefetchIndex = bootstrapCode.indexOf('"http://localhost:3001/remoteEntry.js"');

    // The remote entry download must start before initHost() so it overlaps
    // the shared preloads instead of queueing behind them.
    expect(prefetchIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapCode).toContain(
      'import(/* @vite-ignore */ __mfRemoteEntryPrefetchUrl).catch(() => {});'
    );
    expect(prefetchIndex).toBeLessThan(bootstrapCode.indexOf('await initHost()'));
    expect(bootstrapCode).toContain('__mfPreloadRemote(');
    expect(bootstrapCode).not.toMatch(/^await /m);
  });

  it('transforms remote module imports into federation loadRemote() calls', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: HOST_BASE_MF_OPTIONS,
    });
    const allCode = getAllChunkCode(output);
    expect(allCode).toContain('loadRemote');
    expect(allCode).toContain('remote1/Module');
    const localSharedImportMap = findChunk(output, 'localSharedImportMap');
    expect(localSharedImportMap).toBeDefined();
    expect(localSharedImportMap!.code).toMatch(
      /name: "__mfe_internal__hostApp__mf_owner__\d+__remote1"/
    );
    expect(localSharedImportMap!.code).toContain('entry: "http://localhost:3001/remoteEntry.js"');
  });

  it('adds federation bootstrap script to HTML <head> when hostInitInjectLocation is html', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: { ...HOST_BASE_MF_OPTIONS, hostInitInjectLocation: 'html' },
    });
    const htmlAsset = getHtmlAsset(output);
    expect(htmlAsset).toBeDefined();
    expect(htmlAsset!.source as string).toMatch(bootstrapScriptRegex);
    const bootstrapAsset = output.output.find(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );
    expect(bootstrapAsset?.source).toContain('const __mfHostInit = await __mfImport(');
    expect(bootstrapAsset?.source).toContain('await __mfHostInit.__tla;');
    expect(bootstrapAsset?.source).toContain('const { initHost } = __mfHostInit;');
    expect(bootstrapAsset?.source).toContain('const runtime = await initHost();');
    expect(bootstrapAsset?.source).toMatch(
      /__mfPreloadRemote\("__mfe_internal__hostApp__mf_owner__\d+__remote1", "remote1"\)/
    );
    expect(bootstrapAsset?.source).not.toContain('remote1/Module');
    expect(bootstrapAsset?.source).toContain('runtime.loadRemote(runtimeRemote)');
    expect(bootstrapAsset?.source).toContain('})().then(() => __mfImport(');
    expect(bootstrapAsset?.source).toContain('globalThis.System.import(src)');
    expect(bootstrapAsset?.source).toContain('hostInit');
  });

  itSupportsViteIgnore('leaves vite-ignore scripts unchanged in a Vite build', async () => {
    const output = await buildFixture({
      fixture: 'vite-ignore-host',
      mfOptions: { ...HOST_BASE_MF_OPTIONS, hostInitInjectLocation: 'html' },
    });
    const html = getHtmlAsset(output)?.source as string;
    const bootstrapAssets = output.output.filter(
      (item) => item.type === 'asset' && item.fileName.includes('mf-entry-bootstrap')
    );

    expect(html).toContain('src="/external/external.js"');
    expect(html).not.toContain('vite-ignore');
    expect(bootstrapAssets).toHaveLength(1);
    expect(bootstrapAssets[0].source).not.toContain('/external/external.js');
  });

  it('builds when rolldownOptions.input points at a named HTML entry', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: { ...HOST_BASE_MF_OPTIONS, hostInitInjectLocation: 'entry' },
      viteConfig: {
        build: {
          rolldownOptions: {
            input: {
              main: 'indexProd.html',
            },
          },
        },
      },
    });

    const htmlAsset = getHtmlAsset(output);
    expect(htmlAsset).toBeDefined();
    expect(getAllChunkCode(output)).toContain('loadRemote');
  });

  it('does not add bootstrap script to HTML when hostInitInjectLocation is entry', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: { ...HOST_BASE_MF_OPTIONS, hostInitInjectLocation: 'entry' },
    });
    const htmlAsset = getHtmlAsset(output);
    expect(htmlAsset).toBeDefined();
    // In entry mode, pluginAddEntry.transform prepends the federation bootstrap
    // import to entry modules instead of adding a script tag to the HTML
    expect(htmlAsset!.source as string).not.toMatch(hostInitChunkRegex);
    expect(htmlAsset!.source as string).not.toMatch(bootstrapScriptRegex);
    // The hostInit chunk is still emitted (federation init must still run),
    // but it's loaded through the module graph rather than an HTML script tag
    expect(getChunkNames(output).some((name) => name.includes('hostInit'))).toBe(true);
    expect(getAllChunkCode(output)).toContain('initializeSharing');
    const entryBootstrap = output.output.find(
      (item) => item.type === 'chunk' && item.code.includes('__mfRemotePreloads')
    );
    expect(entryBootstrap?.code).toMatch(
      /__mfPreloadRemote\("__mfe_internal__hostApp__mf_owner__\d+__remote1", "remote1"\)/
    );
    expect(entryBootstrap?.code).not.toMatch(/__mfPreloadRemote\([^)]*remote1\/Module/);
  });

  it('embeds configured federation name in remoteEntry chunk', async () => {
    const output = await buildFixture({
      fixture: 'basic-host',
      mfOptions: HOST_BASE_MF_OPTIONS,
    });
    const remoteEntry = findChunk(output, 'remoteEntry');
    expect(remoteEntry).toBeDefined();
    // virtualRemoteEntry.ts writes the federation name into the remoteEntry
    expect(remoteEntry!.code).toContain('hostApp');
  });

  it('builds named imports from workspace remote subpath exported to TSX source', async () => {
    const root = await createWorkspaceFixture();

    try {
      const output = await buildFixture({
        viteConfig: {
          root: resolve(root, 'packages/host'),
        },
        mfOptions: {
          name: 'host',
          remotes: {
            '@repro/remote-ui': {
              name: '@repro/remote-ui',
              entry: 'http://localhost:4173/assets/remoteEntry.js',
              type: 'module',
            },
          },
        },
      });

      expect(getAllChunkCode(output)).toContain('@repro/remote-ui/Foo');
    } finally {
      await rm(resolve(root, 'packages/host/node_modules'), { recursive: true, force: true });
    }
  });
});
