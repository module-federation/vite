import type {
  ConfigEnv,
  ConfigPluginContext,
  IndexHtmlTransformContext,
  IndexHtmlTransformResult,
  MinimalPluginContextWithoutEnvironment,
  Plugin,
  ResolvedConfig,
  Rollup,
  UserConfig,
} from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../utils/packageUtils', () => ({
  hasPackageDependency: () => true,
}));

import addEntry from '../pluginAddEntry';

type AddEntryPlugin = ReturnType<typeof addEntry>[number];

type HookLike<TThis, TArgs extends unknown[], TResult> =
  | ((this: TThis, ...args: TArgs) => TResult)
  | { handler: (this: TThis, ...args: TArgs) => TResult };

function callPluginHook<TThis, TArgs extends unknown[], TResult>(
  hook: HookLike<TThis, TArgs, TResult> | undefined,
  thisArg: TThis,
  ...args: TArgs
): TResult | undefined {
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  return handler?.call(thisArg, ...args);
}

function runConfig(
  plugin: AddEntryPlugin,
  ctx: ConfigPluginContext,
  config: UserConfig,
  env: ConfigEnv
): void {
  callPluginHook(plugin.config, ctx, config, env);
}

function runConfigResolved(plugin: AddEntryPlugin, config: ResolvedConfig): void {
  if (!plugin.configResolved) throw new Error(`${plugin.name} configResolved hook not found`);
  callPluginHook(plugin.configResolved, {} as MinimalPluginContextWithoutEnvironment, config);
}

async function runTransform(plugin: AddEntryPlugin, code: string, id: string) {
  if (!plugin.transform) throw new Error(`${plugin.name} transform hook not found`);
  return await callPluginHook(plugin.transform, {} as Rollup.TransformPluginContext, code, id);
}

async function runTransformIndexHtml(
  plugin: AddEntryPlugin,
  html: string,
  ctx: IndexHtmlTransformContext
): Promise<void | IndexHtmlTransformResult> {
  if (!plugin.transformIndexHtml)
    throw new Error(`${plugin.name} transformIndexHtml hook not found`);
  return await callPluginHook(
    plugin.transformIndexHtml,
    {} as MinimalPluginContextWithoutEnvironment,
    html,
    ctx
  );
}

async function runLoad(plugin: AddEntryPlugin, id: string) {
  if (!plugin.load) throw new Error(`${plugin.name} load hook not found`);
  return await callPluginHook(plugin.load, {} as Rollup.PluginContext, id);
}

function runBuildStart(
  plugin: AddEntryPlugin,
  ctx: Rollup.PluginContext,
  options: Rollup.NormalizedInputOptions
): void {
  if (!plugin.buildStart) throw new Error(`${plugin.name} buildStart hook not found`);
  callPluginHook(plugin.buildStart, ctx, options);
}

function runGenerateBundle(
  plugin: AddEntryPlugin,
  ctx: Rollup.PluginContext,
  outputOptions: Rollup.NormalizedOutputOptions,
  bundle: Rollup.OutputBundle,
  isWrite = false
): void {
  if (!plugin.generateBundle) throw new Error(`${plugin.name} generateBundle hook not found`);
  callPluginHook(plugin.generateBundle, ctx, outputOptions, bundle, isWrite);
}

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
      const result = (await runTransform(
        buildPlugin,
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
    const result = await runTransform(
      buildPlugin,
      originalCode,
      'virtual:vinext-app-browser-entry'
    );

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

    runConfig(
      servePlugin,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    runConfig(
      buildPlugin,
      {} as ConfigPluginContext,
      { build: { rollupOptions: {} } },
      { command: 'serve', mode: 'development' }
    );
    runConfigResolved(buildPlugin, {
      root: tempDir,
      base: '/',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = (await runTransform(
      buildPlugin,
      'export const browserEntry = true;',
      '/src/main.tsx'
    )) as { code: string } | undefined;

    expect(result?.code).toContain('const { initHost } = await import("/virtual/hostInit.js");');
    expect(result?.code).toContain('const runtime = await initHost();');
    expect(result?.code).toContain('})().then(() => import("/src/main.tsx?mf-entry-bootstrap"));');
  });

  it('rewrites dev html entry scripts to external proxy modules instead of inline scripts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-html-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<html></html>');

    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: 'virtual:mf-host-init',
      inject: 'html',
    });

    const servePlugin = plugins[0];
    const buildPlugin = plugins[1];
    runConfig(
      servePlugin,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    runConfig(
      buildPlugin,
      {} as ConfigPluginContext,
      { build: { rollupOptions: {} } },
      { command: 'serve', mode: 'development' }
    );
    runConfigResolved(servePlugin, {
      base: '/',
      root: tempDir,
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runConfigResolved(buildPlugin, {
      base: '/',
      root: tempDir,
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = await runTransformIndexHtml(
      servePlugin,
      '<html><head><script type="module" src="/@vite/client"></script></head><body><script type="module" src="/src/main.tsx"></script></body></html>',
      {
        filename: path.join(tempDir, 'index.html'),
        path: '/index.html',
        server: undefined,
        originalUrl: '/index.html',
      }
    );

    expect(typeof result).toBe('string');
    if (typeof result !== 'string') throw new Error('transformIndexHtml should return html string');

    expect(result).toContain('src="/@vite/client"');
    expect(result).toContain('src="/@id/virtual:mf-html-entry-proxy?');
    expect(result).not.toContain('await import(');
    expect(result).not.toContain('<script type="module">');
  });

  it('rewrites entry scripts and resolves proxy imports with non-root base (#590)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-html-base-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<html></html>');

    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: 'virtual:mf-host-init',
      inject: 'html',
    });

    const servePlugin = plugins[0];
    const buildPlugin = plugins[1];
    runConfig(
      servePlugin,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    runConfig(
      buildPlugin,
      {} as ConfigPluginContext,
      { build: { rollupOptions: {} } },
      { command: 'serve', mode: 'development' }
    );
    runConfigResolved(servePlugin, {
      base: '/foo/',
      root: tempDir,
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runConfigResolved(buildPlugin, {
      base: '/foo/',
      root: tempDir,
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    // User's HTML with a non-root base — entry src may or may not include base
    const result = await runTransformIndexHtml(
      servePlugin,
      '<html><head><script type="module" src="/foo/@vite/client"></script></head><body><script type="module" src="/foo/src/main.tsx"></script></body></html>',
      {
        filename: path.join(tempDir, 'index.html'),
        path: '/index.html',
        server: undefined,
        originalUrl: '/index.html',
      }
    );
    expect(typeof result).toBe('string');
    if (typeof result !== 'string') throw new Error('transformIndexHtml should return html string');

    // Vite client must not be rewritten
    expect(result).toContain('src="/foo/@vite/client"');
    // Entry script must be rewritten to use the proxy module
    expect(result).toContain('src="/@id/virtual:mf-html-entry-proxy?');

    // Extract the proxy module ID from the rewritten HTML and load it
    const proxyIdMatch = result.match(/src="\/@id\/(virtual:mf-html-entry-proxy\?[^"]+)"/);
    expect(proxyIdMatch).not.toBeNull();
    const proxyId = decodeURIComponent(proxyIdMatch![1]).replace(/&amp;/g, '&');
    const code = await runLoad(servePlugin, proxyId);
    expect(typeof code).toBe('string');
    if (typeof code !== 'string') throw new Error('load hook should return proxy module code');

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

    runConfig(buildPlugin, {} as ConfigPluginContext, {}, { command: 'build', mode: 'production' });
    runConfigResolved(buildPlugin, {
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
    } as unknown as ResolvedConfig);

    runBuildStart(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => (emitted.push(file), ''),
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedInputOptions
    );
    const result = await runTransform(
      buildPlugin,
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

    runConfig(
      servePlugin,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    runConfigResolved(servePlugin, {
      root: '/repo/svelte/host',
      base: '/',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runConfigResolved(buildPlugin, {
      root: '/repo/svelte/host',
      base: '/',
      command: 'serve',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = await runTransform(
      buildPlugin,
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

    runConfig(
      servePlugin,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    runConfig(
      buildPlugin,
      {} as ConfigPluginContext,
      { build: { rollupOptions: {} } },
      { command: 'serve', mode: 'development' }
    );
    runConfigResolved(servePlugin, {
      root: '/repo/nuxt/host',
      base: '/',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runConfigResolved(buildPlugin, {
      root: '/repo/nuxt/host',
      base: '/',
      command: 'serve',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = await runTransform(
      buildPlugin,
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

    runConfigResolved(buildPlugin, {
      root: '/repo/svelte/host',
      base: '/',
      command: 'build',
      build: { rollupOptions: { input: { client: '/repo/.svelte-kit/generated/client.js' } } },
    } as unknown as ResolvedConfig);
    runBuildStart(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => (emitted.push(file), 'host-init-ref'),
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedInputOptions
    );
    runGenerateBundle(
      buildPlugin,
      {
        getFileName: () => 'assets/hostInit.js',
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle,
      false
    );

    expect(bundle['index.html'].source).toContain(
      'await import("/assets/hostInit.js").then(({ initHost }) => initHost());'
    );
    expect(bundle['index.html'].source).toContain('kit.start(app, element);');
    expect(bundle['index.html'].source).not.toContain('type="module" src="/assets/hostInit.js"');
  });
});
