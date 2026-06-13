import type {
  ConfigEnv,
  ConfigPluginContext,
  IndexHtmlTransformContext,
  IndexHtmlTransformResult,
  MinimalPluginContextWithoutEnvironment,
  ResolvedConfig,
  Rollup,
  UserConfig,
} from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { toViteEncodedId, VITE_ID_PREFIX } from '../../utils/VirtualModule';

vi.mock('../../utils/packageUtils', () => ({
  hasPackageDependency: () => true,
}));

const mockMfOptions = vi.hoisted(() => ({
  shareStrategy: 'version-first' as 'version-first' | 'loaded-first',
}));

vi.mock('../../utils/normalizeModuleFederationOptions', async () => {
  const actual = await vi.importActual<
    typeof import('../../utils/normalizeModuleFederationOptions')
  >('../../utils/normalizeModuleFederationOptions');
  return {
    ...actual,
    getNormalizeModuleFederationOptions: () => ({
      shareStrategy: mockMfOptions.shareStrategy,
      shared: {},
      remotes: {},
      internalName: 'host',
      name: 'host',
    }),
  };
});

import addEntry from '../pluginAddEntry';
import { callHook } from '../../utils/__tests__/viteHookHelpers';
import { addUsedRemote, getUsedRemotesMap } from '../../virtualModules/virtualRemotes';

type AddEntryPlugin = ReturnType<typeof addEntry>[number];

function runConfig(
  plugin: AddEntryPlugin,
  ctx: ConfigPluginContext,
  config: UserConfig,
  env: ConfigEnv
): void {
  callHook(plugin.config, ctx, config, env);
}

function runConfigResolved(plugin: AddEntryPlugin, config: ResolvedConfig): void {
  if (!plugin.configResolved) throw new Error(`${plugin.name} configResolved hook not found`);
  callHook(plugin.configResolved, {} as MinimalPluginContextWithoutEnvironment, config);
}

async function runTransform(plugin: AddEntryPlugin, code: string, id: string) {
  if (!plugin.transform) throw new Error(`${plugin.name} transform hook not found`);
  return await callHook(plugin.transform, {} as Rollup.TransformPluginContext, code, id);
}

async function runTransformIndexHtml(
  plugin: AddEntryPlugin,
  html: string,
  ctx: IndexHtmlTransformContext
): Promise<void | IndexHtmlTransformResult> {
  if (!plugin.transformIndexHtml)
    throw new Error(`${plugin.name} transformIndexHtml hook not found`);
  return await callHook(
    plugin.transformIndexHtml,
    {} as MinimalPluginContextWithoutEnvironment,
    html,
    ctx
  );
}

async function runLoad(plugin: AddEntryPlugin, id: string) {
  if (!plugin.load) throw new Error(`${plugin.name} load hook not found`);
  return await callHook(plugin.load, {} as Rollup.PluginContext, id);
}

function runBuildStart(
  plugin: AddEntryPlugin,
  ctx: Rollup.PluginContext,
  options: Rollup.NormalizedInputOptions
): void {
  if (!plugin.buildStart) throw new Error(`${plugin.name} buildStart hook not found`);
  callHook(plugin.buildStart, ctx, options);
}

function runGenerateBundle(
  plugin: AddEntryPlugin,
  ctx: Rollup.PluginContext,
  outputOptions: Rollup.NormalizedOutputOptions,
  bundle: Rollup.OutputBundle,
  isWrite = false
): void {
  if (!plugin.generateBundle) throw new Error(`${plugin.name} generateBundle hook not found`);
  callHook(plugin.generateBundle, ctx, outputOptions, bundle, isWrite);
}

function clearUsedRemotes() {
  const usedRemotesMap = getUsedRemotesMap();
  for (const remoteKey of Object.keys(usedRemotesMap)) {
    delete usedRemotesMap[remoteKey];
  }
}

describe('pluginAddEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMfOptions.shareStrategy = 'version-first';
    clearUsedRemotes();
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

    expect(result?.code).toContain('const __mfHostInit = await import("/virtual/hostInit.js");');
    expect(result?.code).toContain('await __mfHostInit.__tla;');
    expect(result?.code).toContain('const { initHost } = __mfHostInit;');
    expect(result?.code).toContain('await initHost();');
    // Regression (Safari TLA-lowering race): the emulated `__tla` promise must
    // be awaited BEFORE initHost() runs, or `initHost` reads undefined.
    const bootstrap = result?.code ?? '';
    expect(bootstrap.indexOf('await __mfHostInit.__tla;')).toBeLessThan(
      bootstrap.indexOf('await initHost();')
    );
    expect(result?.code).toContain('})().then(() => import("/src/main.tsx?mf-entry-bootstrap"));');
    expect(result?.code).not.toContain('globalThis.System.import(src)');
  });

  it('wraps hydration entry fallback behind host init during build', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-build-hydration-'));
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'entry',
    });
    const buildPlugin = plugins[1];

    runConfig(
      buildPlugin,
      {} as ConfigPluginContext,
      { build: { rollupOptions: {} } },
      { command: 'build', mode: 'production' }
    );
    runConfigResolved(buildPlugin, {
      root: tempDir,
      base: '/',
      command: 'build',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = (await runTransform(
      buildPlugin,
      'import { hydrateRoot } from "react-dom/client";\nhydrateRoot(document, app);',
      '/virtual/client-entry.tsx'
    )) as { code: string } | undefined;

    expect(result?.code).toContain('const __mfHostInit = await import("/virtual/hostInit.js");');
    expect(result?.code).toContain('await __mfHostInit.__tla;');
    expect(result?.code).toContain('const { initHost } = __mfHostInit;');
    expect(result?.code).toContain('await initHost();');
    expect(result?.code).toContain(
      '})().then(() => import("/virtual/client-entry.tsx?mf-entry-bootstrap"));'
    );
  });

  it('does not wrap Nuxt dev entry.async (mount hook handles host init)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-nuxt-dev-'));
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
      command: 'serve',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = await runTransform(
      buildPlugin,
      'const entry = () => import("#app/entry").then((m) => m.default);\nif (true) {\n  entry();\n}\nexport default entry;',
      '/repo/node_modules/.pnpm/nuxt@4.3.1/node_modules/nuxt/dist/app/entry.async.js?v=123'
    );

    expect(result).toBeUndefined();
  });

  it('does not rewrap Nuxt dev client entry bootstrap request', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-nuxt-dev-'));
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
      command: 'serve',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = await runTransform(
      buildPlugin,
      'const entry = () => import("#app/entry").then((m) => m.default);\nif (true) {\n  entry();\n}\nexport default entry;',
      '/repo/node_modules/.pnpm/nuxt@4.3.1/node_modules/nuxt/dist/app/entry.async.js?v=123&mf-entry-bootstrap'
    );

    expect(result).toBeUndefined();
  });

  it('injects host init before Nuxt dev mount', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-nuxt-mount-'));
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
      command: 'serve',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = (await runTransform(
      buildPlugin,
      'await nuxt.hooks.callHook("app:beforeMount", vueApp);\n      vueApp.mount(vueAppRootContainer);\n      await nuxt.hooks.callHook("app:mounted", vueApp);',
      '/repo/node_modules/.pnpm/nuxt@4.3.1/node_modules/nuxt/dist/app/entry.js?v=123'
    )) as { code: string } | undefined;

    expect(result?.code).toContain(
      'await import("/virtual/hostInit.js").then(({ initHost }) => initHost());'
    );
    expect(result?.code).toContain('vueApp.mount(vueAppRootContainer);');
  });

  it('rewrites dev html entry scripts when host init inject is entry', async () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: 'virtual:mf-host-init',
      inject: 'entry',
    });
    const servePlugin = plugins[0];

    runConfig(
      servePlugin,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    runConfigResolved(servePlugin, {
      root: '/repo',
      base: '/',
      command: 'serve',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    const result = (await runTransformIndexHtml(
      servePlugin,
      '<html><head><script type="module" src="/_nuxt/entry.async.js"></script></head></html>',
      {} as IndexHtmlTransformContext
    )) as string;

    expect(result).toContain(toViteEncodedId('virtual:mf-html-entry-proxy?'));
    expect(result).toContain('init=%2F%40id%2Fvirtual%3Amf-host-init');
    expect(result).toContain('entry=%2F_nuxt%2Fentry.async.js');
  });

  it('preloads scoped remote subpaths but skips the bare scoped remote key', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-scoped-'));
    const htmlFile = path.join(tempDir, 'index.html');
    fs.writeFileSync(
      htmlFile,
      [
        '<!doctype html>',
        '<html>',
        '  <body>',
        '    <script type="module" src="/src/main.ts"></script>',
        '  </body>',
        '</html>',
      ].join('\n')
    );
    addUsedRemote('@scope/remote', '@scope/remote');
    addUsedRemote('@scope/remote', '@scope/remote/Button');

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

    const result = (await runTransform(buildPlugin, 'export const app = true;', '/src/main.ts')) as
      | { code: string }
      | undefined;

    expect(result?.code).toContain('__mfPreloadRemote("@scope/remote/Button")');
    expect(result?.code).not.toContain('__mfPreloadRemote("@scope/remote")');
    expect(result?.code).toContain('runtime.loadRemote(remote)');
    // A preload failure must not abort host bootstrap.
    expect(result?.code).toContain('await Promise.allSettled(__mfRemotePreloads);');
    expect(result?.code).not.toContain('Promise.all(__mfRemotePreloads)');
  });

  it('skips remote preload in the host bootstrap when shareStrategy is loaded-first', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-loaded-first-'));
    fs.writeFileSync(
      path.join(tempDir, 'index.html'),
      [
        '<!doctype html>',
        '<html>',
        '  <body>',
        '    <script type="module" src="/src/main.ts"></script>',
        '  </body>',
        '</html>',
      ].join('\n')
    );
    addUsedRemote('employees', 'employees/staff');
    mockMfOptions.shareStrategy = 'loaded-first';

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

    const result = (await runTransform(buildPlugin, 'export const app = true;', '/src/main.ts')) as
      | { code: string }
      | undefined;

    // loaded-first defers remote loading to the runtime — the host bootstrap
    // must not preload, so an offline remote can never blank the host.
    expect(result?.code).not.toContain('__mfPreloadRemote');
    expect(result?.code).not.toContain('loadRemote');
    expect(result?.code).not.toContain('__mfRemotePreloads');
    expect(result?.code).toContain('await initHost();');
    expect(result?.code).toContain('})().then(() => import("/src/main.ts?mf-entry-bootstrap"));');
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
    expect(result).toContain(`src="${toViteEncodedId('virtual:mf-html-entry-proxy?')}`);
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
    expect(result).toContain(`src="${toViteEncodedId('virtual:mf-html-entry-proxy?')}`);

    // Extract the proxy module ID from the rewritten HTML and load it
    const proxyPrefix = toViteEncodedId('virtual:mf-html-entry-proxy?');
    const proxyIdMatch = result.match(
      new RegExp(`src="(${proxyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*)"`)
    );
    expect(proxyIdMatch).not.toBeNull();
    const proxyId = decodeURIComponent(proxyIdMatch![1]).replace(/&amp;/g, '&');
    const code = await runLoad(servePlugin, proxyId);
    expect(typeof code).toBe('string');
    if (typeof code !== 'string') throw new Error('load hook should return proxy module code');

    // The proxy module must import both init and entry as resolvable paths
    // (no base prefix — Vite's server-side resolver handles base itself)
    expect(code).toContain(
      `const __mfHostInit = await import("${VITE_ID_PREFIX}virtual:mf-host-init");`
    );
    expect(code).toContain('await __mfHostInit.__tla;');
    expect(code).toContain('const { initHost } = __mfHostInit;');
    expect(code).toContain('await initHost();');
    expect(code).toContain('})().then(() => import("/src/main.tsx"));');
    expect(code).not.toContain('globalThis.System.import(src)');
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

  it('skips SSR fallback bootstrap when forceClientInjected is true', async () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
      forceClientInjected: true,
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
      root: '/repo/remote-app',
      base: '/',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runConfigResolved(buildPlugin, {
      root: '/repo/remote-app',
      base: '/',
      command: 'serve',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);

    // This module would normally trigger the SSR fallback injection path
    const result = await runTransform(
      buildPlugin,
      'export const app = true;',
      '/repo/remote-app/src/main.ts'
    );

    // With forceClientInjected, the fallback path is skipped
    expect(result).toBeUndefined();
  });

  it('does not replace exposed modules that are also rollup inputs', async () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      skipTransformFor: ['./src/expose.ts'],
    });
    const buildPlugin = plugins[1];

    runConfigResolved(buildPlugin, {
      root: '/repo/remote-app',
      base: '/',
      command: 'build',
      build: { rollupOptions: { input: '/repo/remote-app/src/expose.ts' } },
    } as unknown as ResolvedConfig);

    const result = await runTransform(
      buildPlugin,
      'export function render() {}',
      '/repo/remote-app/src/expose.ts'
    );

    expect(result).toBeUndefined();
  });

  it('uses Vite 8 rolldownOptions.input to detect HTML entries', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-add-entry-rolldown-input-'));
    const htmlFile = path.join(tempDir, 'indexProd.html');
    fs.writeFileSync(
      htmlFile,
      '<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>'
    );

    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const emitted: Rollup.EmittedFile[] = [];
    const bundle: any = {
      'indexProd.html': {
        type: 'asset',
        source:
          '<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>',
      },
    };

    runConfig(buildPlugin, {} as ConfigPluginContext, {}, { command: 'build', mode: 'production' });
    runConfigResolved(buildPlugin, {
      root: tempDir,
      base: '/',
      command: 'build',
      build: {
        rollupOptions: {},
        rolldownOptions: {
          input: {
            main: htmlFile,
          },
        },
      },
    } as unknown as ResolvedConfig);
    runBuildStart(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'host-init-ref';
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedInputOptions
    );
    runGenerateBundle(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return file.type === 'asset' ? file.fileName! : `bootstrap-${emitted.length}`;
        },
        getFileName: (ref: string) => (ref === 'host-init-ref' ? 'assets/hostInit.js' : ref),
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    const bootstrapAsset = (emitted as Rollup.EmittedFile[]).find(
      (item) =>
        item.type === 'asset' &&
        typeof item.fileName === 'string' &&
        item.fileName.includes('mf-entry-bootstrap-')
    ) as Rollup.EmittedAsset | undefined;
    expect(bootstrapAsset?.fileName).toMatch(/^assets\/mf-entry-bootstrap-0-[a-f0-9]{8}\.js$/);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'chunk', id: '/virtual/hostInit.js' }),
      ])
    );
    expect(bundle['indexProd.html'].source).toContain(bootstrapAsset!.fileName);
  });

  it('emits bootstrap file with directory prefix from entryFileNames pattern', () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const emitted: Rollup.EmittedFile[] = [];
    const bundle: any = {
      'index.html': {
        type: 'asset',
        source:
          '<html><head><script type="module" src="./src/main.tsx"></script></head><body></body></html>',
      },
    };

    runConfigResolved(buildPlugin, {
      root: '/repo/host',
      base: '',
      command: 'build',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runBuildStart(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'host-init-ref';
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedInputOptions
    );
    runGenerateBundle(
      buildPlugin,
      {
        getFileName: () => 'static/js/hostInit-abc.js',
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'bootstrap-ref-' + emitted.length;
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle,
      false
    );

    const bootstrapFile = emitted.find((f) =>
      (f as Rollup.EmittedAsset).fileName?.includes('mf-entry-bootstrap')
    ) as Rollup.EmittedAsset | undefined;
    expect(bootstrapFile).toBeDefined();
    expect(bootstrapFile!.fileName).toMatch(/^static\/js\/mf-entry-bootstrap-0-[a-f0-9]{8}\.js$/);
    expect(bootstrapFile!.source as string).toContain('__mfImport("./hostInit-abc.js")');
    expect(bootstrapFile!.source as string).toContain('__mfImport("../../src/main.tsx")');
  });

  it('emits bootstrap file at root when entryFileNames is not set', () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const emitted: Rollup.EmittedFile[] = [];
    const bundle: any = {
      'index.html': {
        type: 'asset',
        source:
          '<html><head><script type="module" src="./src/main.tsx"></script></head><body></body></html>',
      },
    };

    runConfigResolved(buildPlugin, {
      root: '/repo/host',
      base: '',
      command: 'build',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runBuildStart(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'host-init-ref';
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedInputOptions
    );
    runGenerateBundle(
      buildPlugin,
      {
        getFileName: () => 'hostInit-abc.js',
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'bootstrap-ref-' + emitted.length;
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle,
      false
    );

    const bootstrapFile = emitted.find((f) =>
      (f as Rollup.EmittedAsset).fileName?.includes('mf-entry-bootstrap')
    ) as Rollup.EmittedAsset | undefined;
    expect(bootstrapFile).toBeDefined();
    expect(bootstrapFile!.fileName).toMatch(/^mf-entry-bootstrap-0-[a-f0-9]{8}\.js$/);
  });

  it('strips Vite base before rebasing bootstrap imports (base: /app/)', () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const emitted: Rollup.EmittedFile[] = [];
    const bundle: any = {
      'index.html': {
        type: 'asset',
        source:
          '<html><head><script type="module" src="/app/src/main.tsx"></script></head><body></body></html>',
      },
    };

    runConfigResolved(buildPlugin, {
      root: '/repo/host',
      base: '/app/',
      command: 'build',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runBuildStart(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'host-init-ref';
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedInputOptions
    );
    runGenerateBundle(
      buildPlugin,
      {
        getFileName: () => 'static/js/hostInit-abc.js',
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'bootstrap-ref-' + emitted.length;
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle,
      false
    );

    const bootstrapFile = emitted.find((f) =>
      (f as Rollup.EmittedAsset).fileName?.includes('mf-entry-bootstrap')
    ) as Rollup.EmittedAsset | undefined;
    expect(bootstrapFile).toBeDefined();
    expect(bootstrapFile!.fileName).toMatch(/^static\/js\/mf-entry-bootstrap-0-[a-f0-9]{8}\.js$/);
    expect(bootstrapFile!.source as string).toContain('__mfImport("./hostInit-abc.js")');
    expect(bootstrapFile!.source as string).toContain('__mfImport("../../src/main.tsx")');
  });

  it('does not rebase absolute URLs from renderBuiltUrl in bootstrap', () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const emitted: Rollup.EmittedFile[] = [];
    const bundle: any = {
      'index.html': {
        type: 'asset',
        source:
          '<html><head><script type="module" src="/src/main.tsx"></script></head><body></body></html>',
      },
      'static/js/hostInit-abc.js': {
        type: 'chunk',
        name: 'hostInit',
        fileName: 'static/js/hostInit-abc.js',
      },
    };

    runConfigResolved(buildPlugin, {
      root: '/repo/host',
      base: '/',
      command: 'build',
      experimental: {
        renderBuiltUrl(filename: string) {
          if (filename.includes('hostInit')) {
            return 'https://cdn.example.com/hostInit-abc.js';
          }
          return { relative: true };
        },
      },
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runBuildStart(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'host-init-ref';
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedInputOptions
    );
    runGenerateBundle(
      buildPlugin,
      {
        getFileName: () => 'static/js/hostInit-abc.js',
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'bootstrap-ref-' + emitted.length;
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle,
      false
    );

    const bootstrapFile = emitted.find((f) =>
      (f as Rollup.EmittedAsset).fileName?.includes('mf-entry-bootstrap')
    ) as Rollup.EmittedAsset | undefined;
    expect(bootstrapFile).toBeDefined();
    expect(bootstrapFile!.source as string).toContain(
      '__mfImport("https://cdn.example.com/hostInit-abc.js")'
    );
    expect(bundle['index.html'].source).toContain(
      '<link rel="modulepreload" crossorigin href="https://cdn.example.com/hostInit-abc.js">'
    );
  });

  it('injects host init chunk-chain modulepreloads during build', () => {
    const plugins = addEntry({
      entryName: 'hostInit',
      entryPath: '/virtual/hostInit.js',
      inject: 'html',
    });
    const buildPlugin = plugins[1];
    const emitted: Rollup.EmittedFile[] = [];
    const bundle: any = {
      'index.html': {
        type: 'asset',
        source:
          '<html><head><script type="module" src="/app/src/main.tsx"></script><link rel="modulepreload" crossorigin href="/app/assets/chunk-index.B_.js"></head><body></body></html>',
      },
      'assets/chunk-hostInit.D8.js': {
        type: 'chunk',
        name: 'hostInit',
        fileName: 'assets/chunk-hostInit.D8.js',
      },
      'assets/chunk-remoteEntry.u3.js': {
        type: 'chunk',
        name: 'remoteEntry',
        fileName: 'assets/chunk-remoteEntry.u3.js',
      },
      'assets/chunk-_virtual_mf-localSharedImportMap___app.Bl.js': {
        type: 'chunk',
        name: '_virtual_mf-localSharedImportMap___app',
        fileName: 'assets/chunk-_virtual_mf-localSharedImportMap___app.Bl.js',
      },
      'assets/chunk-index.B_.js': {
        type: 'chunk',
        name: 'index',
        fileName: 'assets/chunk-index.B_.js',
      },
      'assets/index.AA.css': {
        type: 'asset',
        name: 'index',
        fileName: 'assets/index.AA.css',
      },
    };

    runConfigResolved(buildPlugin, {
      root: '/repo/host',
      base: '/app/',
      command: 'build',
      build: { rollupOptions: {} },
    } as unknown as ResolvedConfig);
    runBuildStart(
      buildPlugin,
      {
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'host-init-ref';
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedInputOptions
    );
    runGenerateBundle(
      buildPlugin,
      {
        getFileName: () => 'assets/hostInit.js',
        emitFile: (file: Rollup.EmittedFile) => {
          emitted.push(file);
          return 'bootstrap-ref-' + emitted.length;
        },
      } as unknown as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle,
      false
    );

    const html = String(bundle['index.html'].source);
    expect(html).toContain(
      '<link rel="modulepreload" crossorigin href="/app/assets/chunk-hostInit.D8.js">'
    );
    expect(html).toContain(
      '<link rel="modulepreload" crossorigin href="/app/assets/chunk-remoteEntry.u3.js">'
    );
    expect(html).toContain(
      '<link rel="modulepreload" crossorigin href="/app/assets/chunk-_virtual_mf-localSharedImportMap___app.Bl.js">'
    );
    expect(html.match(/chunk-index\.B_\.js/g)?.length).toBe(1);
    expect(html).not.toContain('index.AA.css');
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
    expect(
      bundle['index.html'].source.match(
        /await import\([^)]+\)\.then\(\(\{ initHost \}\) => initHost\(\)\)/g
      )?.length
    ).toBe(1);
  });
});
