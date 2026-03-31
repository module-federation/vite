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

    expect(result?.code).toContain('import "/virtual/hostInit.js";');
    expect(result?.code).toContain('export const browserEntry = true;');
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

    const result = servePlugin.transformIndexHtml?.(
      '<html><head><script type="module" src="/@vite/client"></script></head><body><script type="module" src="/src/main.tsx"></script></body></html>'
    );

    expect(result).toContain('src="/@vite/client"');
    expect(result).toContain('src="/@id/virtual:mf-html-entry-proxy?');
    expect(result).not.toContain('await import(');
    expect(result).not.toContain('<script type="module">');
  });

  it('returns proxy module content with ordered static imports and no await', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-proxy-'));
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

    const html = '<html><body><script type="module" src="/src/main.tsx"></script></body></html>';
    const transformed = servePlugin.transformIndexHtml?.(html, { path: '/index.html' } as any) as
      | string
      | undefined;

    const proxyMatch = transformed?.match(/src="([^"]*@id\/virtual:mf-html-entry-proxy\?[^"]+)"/);
    expect(proxyMatch).toBeTruthy();

    const proxyId = proxyMatch?.[1] as string;
    const virtualSource = servePlugin.load?.(proxyId) as string | undefined;

    expect(virtualSource).toContain('import "/@id/virtual:mf-host-init";');
    expect(virtualSource).toContain('import "/src/main.tsx";');
    expect(virtualSource).not.toContain('await import(');
    expect(virtualSource).not.toContain('new URL');
    expect(virtualSource).not.toContain('document.baseURI');
  });
});
