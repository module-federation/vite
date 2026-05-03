import { mkdir, rm, symlink } from 'fs/promises';
import { dirname, resolve } from 'path';
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

const hostInitChunkRegex = /<script\s+type="module"\s+src="[^"]*hostInit[^"]*">/;
const bootstrapScriptRegex = /<script\s+type="module"[^>]+src="[^"]*mf-entry-bootstrap[^"]*">/;

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
    expect(localSharedImportMap!.code).toContain('name: "remote1"');
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
    expect(bootstrapAsset?.source).toContain('const { initHost } = await import(');
    expect(bootstrapAsset?.source).toContain('const runtime = await initHost();');
    expect(bootstrapAsset?.source).toContain('runtime.loadRemote("remote1/Module")');
    expect(bootstrapAsset?.source).toContain('})().then(() => import(');
    expect(bootstrapAsset?.source).toContain('hostInit');
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
