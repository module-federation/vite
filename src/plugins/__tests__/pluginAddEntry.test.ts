import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../utils/packageUtils', () => ({
  hasPackageDependency: () => true,
}));

import addEntry from '../pluginAddEntry';

describe('pluginAddEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const testCase of [
    {
      name: 'injects host init into vinext browser entry during build',
      id: 'virtual:vinext-app-browser-entry',
      shouldInject: true,
    },
    {
      name: 'does not inject host init into unrelated virtual entries during build',
      id: 'virtual:some-other-entry',
      shouldInject: false,
    },
  ]) {
    it(testCase.name, async () => {
      const plugins = addEntry({
        entryName: 'hostInit',
        entryPath: '/virtual/hostInit.js',
        inject: 'html',
      });

      const buildPlugin = plugins[1];
      const result = (await buildPlugin.transform?.(
        'export const browserEntry = true;',
        testCase.id
      )) as { code: string } | undefined;

      if (testCase.shouldInject) {
        expect(result?.code).toContain('import "/virtual/hostInit.js";');
        expect(result?.code).toContain('export const browserEntry = true;');
        return;
      }

      expect(result).toBeUndefined();
    });
  }

  it('does not inject twice when the import already exists', async () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const originalCode = 'import "/virtual/hostInit.js";\nexport const browserEntry = true;';
    const result = await buildPlugin.transform?.(originalCode, 'virtual:vinext-app-browser-entry');

    expect(result).toBeUndefined();
  });

  it('injects host init into html-script entry during serve when inject is entry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-'));
    const htmlFile = path.join(tempDir, 'index.html');
    fs.writeFileSync(
      htmlFile,
      [
        '<!doctype html>',
        '<html>',
        '  <body>',
        '    <script type="module" src="/src/main.tsx"></script>',
        '  </body>',
        '</html>',
      ].join('\n')
    );

    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'entry',
    });

    const servePlugin = plugins[0];
    const buildPlugin = plugins[1];

    servePlugin.config?.({}, { command: 'serve', mode: 'development' });
    buildPlugin.config?.(
      { build: { rollupOptions: {} } },
      { command: 'serve', mode: 'development' }
    );
    buildPlugin.configResolved?.({
      root: tempDir,
      base: '/',
      build: { rollupOptions: {} },
    } as any);

    const result = (await buildPlugin.transform?.(
      'export const browserEntry = true;',
      '/src/main.tsx'
    )) as { code: string } | undefined;

    expect(result?.code).toContain('const { initHost } = await import("/virtual/hostInit.js");');
    expect(result?.code).toContain('const runtime = await initHost();');
    expect(result?.code).toContain('})().then(() => import("/src/main.tsx?mf-entry-bootstrap"));');
  });

  it('rewrites dev html entry scripts to external proxy modules instead of inline scripts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-html-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<html></html>');

    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: 'virtual:mf-host-init',
      inject: 'html',
    });

    const servePlugin = plugins[0];
    const buildPlugin = plugins[1];
    servePlugin.config?.({}, { command: 'serve', mode: 'development' });
    buildPlugin.config?.(
      { build: { rollupOptions: {} } },
      { command: 'serve', mode: 'development' }
    );
    servePlugin.configResolved?.({
      base: '/',
      root: tempDir,
      build: { rollupOptions: {} },
    } as any);
    buildPlugin.configResolved?.({
      base: '/',
      root: tempDir,
      build: { rollupOptions: {} },
    } as any);

    const hook = servePlugin.transformIndexHtml;
    const handler = typeof hook === 'object' ? hook.handler : hook;
    const result = handler?.(
      '<html><head><script type="module" src="/@vite/client"></script></head><body><script type="module" src="/src/main.tsx"></script></body></html>'
    );

    expect(result).toContain('src="/@vite/client"');
    expect(result).toContain('src="/@id/virtual:mf-html-entry-proxy?');
    expect(result).not.toContain('await import(');
    expect(result).not.toContain('<script type="module">');
  });

  it('rewrites entry scripts and resolves proxy imports with non-root base (#590)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-html-base-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<html></html>');

    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: 'virtual:mf-host-init',
      inject: 'html',
    });

    const servePlugin = plugins[0];
    const buildPlugin = plugins[1];
    servePlugin.config?.({}, { command: 'serve', mode: 'development' });
    buildPlugin.config?.(
      { build: { rollupOptions: {} } },
      { command: 'serve', mode: 'development' }
    );
    servePlugin.configResolved?.({
      base: '/foo/',
      root: tempDir,
      build: { rollupOptions: {} },
    } as any);
    buildPlugin.configResolved?.({
      base: '/foo/',
      root: tempDir,
      build: { rollupOptions: {} },
    } as any);

    // User's HTML with a non-root base — entry src may or may not include base
    const hook = servePlugin.transformIndexHtml;
    const handler = typeof hook === 'object' ? hook.handler : hook;
    const result = handler?.(
      '<html><head><script type="module" src="/foo/@vite/client"></script></head><body><script type="module" src="/foo/src/main.tsx"></script></body></html>'
    ) as string;

    // Vite client must not be rewritten
    expect(result).toContain('src="/foo/@vite/client"');
    // Entry script must be rewritten to use the proxy module
    expect(result).toContain('src="/@id/virtual:mf-html-entry-proxy?');

    // Extract the proxy module ID from the rewritten HTML and load it
    const proxyIdMatch = result.match(/src="\/@id\/(virtual:mf-html-entry-proxy\?[^"]+)"/);
    expect(proxyIdMatch).not.toBeNull();
    const proxyId = decodeURIComponent(proxyIdMatch![1]).replace(/&amp;/g, '&');
    const code = servePlugin.load?.(proxyId) as string;

    // The proxy module must import both init and entry as resolvable paths
    // (no base prefix — Vite's server-side resolver handles base itself)
    expect(code).toContain('const { initHost } = await import("/@id/virtual:mf-host-init");');
    expect(code).toContain('const runtime = await initHost();');
    expect(code).toContain('})().then(() => import("/src/main.tsx"));');
    expect(code).not.toContain('/foo/');
  });

  it('skips entry emission and bootstrap transforms during SvelteKit SSR builds', async () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const emitted: unknown[] = [];

    buildPlugin.config?.({}, { command: 'build', mode: 'production' });
    buildPlugin.configResolved?.({
      root: '/repo/svelte/host',
      base: '/',
      command: 'build',
      build: {
        ssr: true,
        rollupOptions: {
          input: {
            server: '/repo/svelte/host/.svelte-kit/generated/server/index.js',
          },
        },
      },
    } as any);

    buildPlugin.buildStart?.call(
      { emitFile: (file: unknown) => emitted.push(file) } as any,
      {} as any
    );
    const result = await buildPlugin.transform?.(
      'export const server = true;',
      '/repo/node_modules/@sveltejs/kit/src/runtime/server/index.js'
    );

    expect(emitted).toEqual([]);
    expect(result).toBeUndefined();
  });

  it('does not inject bootstrap imports into SvelteKit server modules during dev', async () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const servePlugin = plugins[0];
    const buildPlugin = plugins[1];

    servePlugin.config?.({}, { command: 'serve', mode: 'development' });
    servePlugin.configResolved?.({
      root: '/repo/svelte/host',
      base: '/',
      build: { rollupOptions: {} },
    } as any);
    buildPlugin.configResolved?.({
      root: '/repo/svelte/host',
      base: '/',
      command: 'serve',
      build: { rollupOptions: {} },
    } as any);

    const result = await buildPlugin.transform?.(
      'export const server = true;',
      '/repo/svelte/host/.svelte-kit/generated/server/internal.js'
    );

    expect(result).toBeUndefined();
  });

  it('does not inject host init into Vite internal virtual modules during dev fallback', async () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const servePlugin = plugins[0];
    const buildPlugin = plugins[1];

    servePlugin.config?.({}, { command: 'serve', mode: 'development' });
    buildPlugin.config?.(
      { build: { rollupOptions: {} } },
      { command: 'serve', mode: 'development' }
    );
    servePlugin.configResolved?.({
      root: '/repo/nuxt/host',
      base: '/',
      build: { rollupOptions: {} },
    } as any);
    buildPlugin.configResolved?.({
      root: '/repo/nuxt/host',
      base: '/',
      command: 'serve',
      build: { rollupOptions: {} },
    } as any);

    const result = await buildPlugin.transform?.(
      'export const polyfill = true;',
      '\0vite/modulepreload-polyfill.js'
    );

    expect(result).toBeUndefined();
  });

  it('wraps SvelteKit static inline startup behind host init during build', () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const emitted: unknown[] = [];
    const bundle: any = {
      'index.html': {
        type: 'asset',
        source: `<html><head></head><body><div><script>
{
  __sveltekit_test = { base: new URL(".", location).pathname.slice(0, -1) };
  const element = document.currentScript.parentElement;
  Promise.all([
    import("./_app/immutable/entry/start.js"),
    import("./_app/immutable/entry/app.js")
  ]).then(([kit, app]) => {
    kit.start(app, element);
  });
}
</script></div></body></html>`,
      },
    };

    buildPlugin.configResolved?.({
      root: '/repo/svelte/host',
      base: '/',
      command: 'build',
      build: { rollupOptions: { input: { client: '/repo/.svelte-kit/generated/client.js' } } },
    } as any);
    buildPlugin.buildStart?.call(
      { emitFile: (file: unknown) => (emitted.push(file), 'host-init-ref') } as any,
      {} as any
    );
    buildPlugin.generateBundle?.call(
      { getFileName: () => 'assets/hostInit.js' } as any,
      {} as any,
      bundle,
      false
    );

    expect(bundle['index.html'].source).toContain(
      'await import("/assets/hostInit.js").then(({ initHost }) => initHost());'
    );
    expect(bundle['index.html'].source).toContain('kit.start(app, element);');
    expect(bundle['index.html'].source).not.toContain('type="module" src="/assets/hostInit.js"');
  });
});
