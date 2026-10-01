import { resolve } from 'path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { federation } from '../src';
import { FIXTURES } from './helpers/build';

const FIXTURE = 'importmap-host';
const root = resolve(FIXTURES, FIXTURE);
const vendor = (name: string) => resolve(root, 'vendor', name, 'index.js');
const shareUrl = (key: string) => `/@id/__x00__mf-importmap-share:${key}`;
// transformRequest takes a module id; the browser URL `/@id/__x00__…` decodes to `\0…`.
const shareId = (key: string) => `\0mf-importmap-share:${key}`;

describe('experiments.importMap — dev server', () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false },
      // The fixture deps are aliased source files, not installed packages: nothing to pre-bundle.
      optimizeDeps: { noDiscovery: true, include: [] },
      resolve: {
        alias: {
          'esm-dep': vendor('esm-dep'),
          'esm-default-dep': vendor('esm-default-dep'),
          'cjs-dep': vendor('cjs-dep'),
        },
      },
      plugins: [
        federation({
          name: 'importMapHost',
          remotes: {
            importMapRemote: resolve(root, 'remote', 'importmap-manifest.json'),
          },
          shared: { 'esm-dep': {}, 'esm-default-dep': {}, 'cjs-dep': {} },
          experiments: { importMap: true },
        }),
      ],
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('injects an import map pointing shared keys at dev share modules and remotes at their entries', async () => {
    const html = await server.transformIndexHtml(
      '/index.html',
      '<html><head></head><body></body></html>'
    );
    const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]).imports).toEqual({
      'esm-dep': shareUrl('esm-dep'),
      'esm-default-dep': shareUrl('esm-default-dep'),
      'cjs-dep': shareUrl('cjs-dep'),
      'importMapRemote/Widget': 'https://remote.example.com/Widget.js',
    });
  });

  it('serves a share module that forwards default only when the module has one', async () => {
    const esm = await server.transformRequest(shareId('esm-dep'));
    const esmDefault = await server.transformRequest(shareId('esm-default-dep'));
    expect(esm?.code).toContain('export *');
    expect(esm?.code).not.toMatch(/export\s*\{\s*default\s*\}/);
    expect(esmDefault?.code).toMatch(/export\s*\{\s*default\s*\}/);
  });

  it('rewrites remote imports in host code to the URL from the remote manifest', async () => {
    const entry = await server.transformRequest('/entry.js');
    expect(entry?.code).toContain('https://remote.example.com/Widget.js');
    expect(entry?.code).not.toMatch(/import\(\s*["']importMapRemote\/Widget["']\s*\)/);
  });
});
