import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Rollup, ResolvedConfig } from 'vite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callHook } from '../../utils/__tests__/viteHookHelpers';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';

const { getIsRolldownMock, hasPackageDependencyMock, isNuxtProjectRootMock } = vi.hoisted(() => ({
  getIsRolldownMock: vi.fn<(ctx: unknown) => boolean>(() => false),
  hasPackageDependencyMock: vi.fn<(pkg: string, cwd?: string) => boolean>(() => false),
  isNuxtProjectRootMock: vi.fn<(root: string) => boolean>(() => false),
}));

vi.mock('../../utils/packageUtils', () => ({
  getIsRolldown: getIsRolldownMock,
  hasPackageDependency: hasPackageDependencyMock,
  isNuxtProjectRoot: isNuxtProjectRootMock,
  getPackageDetectionCwd: vi.fn(() => '/mock/cwd'),
  setPackageDetectionCwd: vi.fn(),
  resolveImportPath: vi.fn((specifier: string) => `/mock/cwd/node_modules/${specifier}/index.js`),
  getPackageName: vi.fn((s: string) => s.split('/')[0]),
  getPackageNameFromNodeModulePath: vi.fn(),
  packageNameEncode: vi.fn((s: string) => s),
  packageNameDecode: vi.fn((s: string) => s),
  getInstalledPackageJson: vi.fn(),
  getInstalledPackageEntry: vi.fn(),
  getExtFromNpmPackage: vi.fn(() => '.js'),
}));

vi.mock('../../virtualModules/virtualExposesSSR', () => ({
  generateExposesSSR: vi.fn(() => 'export default {}'),
  getVirtualExposesSSRId: vi.fn(
    (opts: { internalName: string }) => `virtual:mf-exposes-ssr:${opts.internalName}`
  ),
}));

vi.mock('../../virtualModules/virtualRemoteEntrySSR', () => ({
  generateRemoteEntrySSR: vi.fn(() => 'export { init, get }'),
  getRemoteEntrySSRId: vi.fn(
    (opts: { internalName: string; filename: string }) =>
      `virtual:mf-REMOTE_ENTRY_SSR_ID:${opts.internalName}__${opts.filename.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  ),
  getSsrRemoteEntryFileName: vi.fn((filename: string) => {
    const base = filename.replace(/\.[^.]+$/, '');
    return `${base}.ssr.js`;
  }),
}));

import { pluginSSRRemoteEntry } from '../pluginSSRRemoteEntry';
import { generateRemoteEntrySSR } from '../../virtualModules/virtualRemoteEntrySSR';

function makeOptions(overrides: Record<string, unknown> = {}) {
  return normalizeModuleFederationOptions({
    name: 'remote',
    filename: 'remoteEntry.js',
    exposes: { './Widget': './src/Widget.tsx' },
    shared: { react: { singleton: true } },
    ...overrides,
  });
}

function makePluginMeta(rolldown = false): Rollup.PluginContext['meta'] {
  return {
    rollupVersion: '4.0.0',
    ...(rolldown ? { viteVersion: '8.0.0', rolldownVersion: '1.0.0' } : {}),
    watchMode: false,
  } as Rollup.PluginContext['meta'];
}

function makeEmitFile() {
  return vi.fn<Rollup.PluginContext['emitFile']>();
}

function createMockRequest(method: string, payload?: unknown, rawPayload?: string) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string };
  req.method = method;
  req.url = '/__mf_runner__';
  queueMicrotask(() => {
    if (rawPayload !== undefined) req.emit('data', Buffer.from(rawPayload));
    else if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  });
  return req;
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    writableEnded: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(message = '') {
      this.writableEnded = true;
      this.body = message;
    },
  };
}

async function invokeRunnerMiddleware(
  payload: unknown,
  env: { fetchModule?: unknown; hot?: { handleInvoke?: (payload: unknown) => Promise<unknown> } },
  rawPayload?: string,
  serverConfig: Record<string, unknown> = { root: '/mock/cwd' },
  method = 'POST'
) {
  const plugins = pluginSSRRemoteEntry(makeOptions());
  const mainPlugin = plugins[1];
  const handlers: { path: string; handler: (req: unknown, res: unknown) => unknown }[] = [];

  callHook(
    mainPlugin.configResolved,
    {} as Rollup.PluginContext,
    {
      base: '/',
      root: '/mock/cwd',
    } as unknown as ResolvedConfig
  );
  callHook(
    mainPlugin.configureServer,
    {} as Rollup.PluginContext,
    {
      config: serverConfig,
      environments: { ssr: env },
      middlewares: {
        use(pathOrHandler: string | ((req: unknown, res: unknown) => unknown), handler?: unknown) {
          if (typeof pathOrHandler === 'string') {
            handlers.push({
              path: pathOrHandler,
              handler: handler as (req: unknown, res: unknown) => unknown,
            });
          }
        },
      },
    } as never
  );

  const runner = handlers.find((entry) => entry.path === '/__mf_runner__')?.handler;
  expect(runner).toBeDefined();

  const req = createMockRequest(method, payload, rawPayload);
  const res = createMockResponse();
  await runner!(req, res);
  return res;
}

describe('pluginSSRRemoteEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIsRolldownMock.mockReturnValue(false);
    hasPackageDependencyMock.mockReturnValue(false);
    isNuxtProjectRootMock.mockReturnValue(false);
  });

  it('returns two plugins with correct names and enforce', () => {
    const plugins = pluginSSRRemoteEntry(makeOptions());
    expect(plugins).toHaveLength(2);
    expect(plugins[0].name).toBe('mf:ssr-remote-entry:pre');
    expect(plugins[0].enforce).toBe('pre');
    // apply is intentionally absent — resolveId/load must run in both serve and build
    // so the Vite dev server can respond to virtual SSR module requests.
    expect(plugins[0].apply).toBeUndefined();
    expect(plugins[1].name).toBe('mf:ssr-remote-entry');
    expect(plugins[1].sharedDuringBuild).toBe(true);
    expect(plugins[1].apply).toBeUndefined();
  });

  describe('pre-plugin — configResolved', () => {
    it('maps alias replacement path to bare package name', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];

      const config = {
        resolve: {
          alias: [{ find: '@module-federation/runtime', replacement: '/abs/path/to/runtime.js' }],
        },
      } as unknown as ResolvedConfig;

      callHook(prePlugin.configResolved, {} as Rollup.PluginContext, config);

      // After configResolved, resolveId should re-externalise the abs path
      const result = callHook(
        prePlugin.resolveId,
        { resolve: vi.fn() } as unknown as Rollup.PluginContext,
        '/abs/path/to/runtime.js',
        `virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js`,
        { isEntry: false }
      );

      expect(result).toEqual({ id: '@module-federation/runtime', external: true });
    });

    it('handles regex aliases', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];

      const config = {
        resolve: {
          alias: [
            { find: /^@module-federation\/runtime$/, replacement: '/abs/path/to/runtime.js' },
          ],
        },
      } as unknown as ResolvedConfig;

      callHook(prePlugin.configResolved, {} as Rollup.PluginContext, config);

      const result = callHook(
        prePlugin.resolveId,
        { resolve: vi.fn() } as unknown as Rollup.PluginContext,
        '/abs/path/to/runtime.js',
        `virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js`,
        { isEntry: false }
      );

      expect(result).toEqual({ id: '@module-federation/runtime', external: true });
    });
  });

  describe('pre-plugin — resolveId', () => {
    it('returns virtual SSR remote entry ID as-is', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      const result = callHook(prePlugin.resolveId, {} as Rollup.PluginContext, ssrId, undefined, {
        isEntry: false,
      });

      expect(result).toBe(ssrId);
    });

    it('returns virtual exposes SSR ID as-is', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const exposesId = 'virtual:mf-exposes-ssr:__mfe_internal__remote';

      const result = callHook(
        prePlugin.resolveId,
        {} as Rollup.PluginContext,
        exposesId,
        undefined,
        { isEntry: false }
      );

      expect(result).toBe(exposesId);
    });

    it('returns undefined when importer is not in SSR graph', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];

      const result = callHook(
        prePlugin.resolveId,
        {} as Rollup.PluginContext,
        '@module-federation/runtime',
        '/some/browser/file.js',
        { isEntry: false }
      );

      expect(result).toBeUndefined();
    });

    it('externalises SSR-only bare specifiers when importer is in SSR graph', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      const result = callHook(
        prePlugin.resolveId,
        {} as Rollup.PluginContext,
        '@module-federation/runtime',
        ssrId,
        { isEntry: false }
      );

      expect(result).toEqual({ id: '@module-federation/runtime', external: true });
    });

    it('externalises @module-federation/runtime-core and sdk', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      expect(
        callHook(
          prePlugin.resolveId,
          {} as Rollup.PluginContext,
          '@module-federation/runtime-core',
          ssrId,
          { isEntry: false }
        )
      ).toEqual({ id: '@module-federation/runtime-core', external: true });

      expect(
        callHook(prePlugin.resolveId, {} as Rollup.PluginContext, '@module-federation/sdk', ssrId, {
          isEntry: false,
        })
      ).toEqual({ id: '@module-federation/sdk', external: true });
    });

    it('externalises user-provided ssrExternals', () => {
      const base = makeOptions();
      const options = { ...base, ssrExternals: ['my-server-only-pkg'] };
      const plugins = pluginSSRRemoteEntry(options);
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      const result = callHook(
        prePlugin.resolveId,
        {} as Rollup.PluginContext,
        'my-server-only-pkg',
        ssrId,
        { isEntry: false }
      );

      expect(result).toEqual({ id: 'my-server-only-pkg', external: true });
    });

    it('does not track bare specifiers into the SSR graph', () => {
      const resolveMock = vi.fn();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      callHook(
        prePlugin.resolveId,
        { resolve: resolveMock } as unknown as Rollup.PluginContext,
        'react',
        ssrId,
        { isEntry: false }
      );

      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('tracks relative imports into the SSR graph', async () => {
      const resolved = { id: '/abs/path/to/dep.js' };
      const resolveMock = vi.fn().mockResolvedValue(resolved);
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      await callHook(
        prePlugin.resolveId,
        { resolve: resolveMock } as unknown as Rollup.PluginContext,
        './assets/helper.js',
        ssrId,
        { isEntry: false }
      );

      expect(resolveMock).toHaveBeenCalledWith('./assets/helper.js', ssrId, { skipSelf: true });
    });
  });

  describe('main plugin — resolveId', () => {
    it('returns virtual SSR remote entry ID as-is', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      expect(
        callHook(mainPlugin.resolveId, {} as Rollup.PluginContext, ssrId, undefined, {
          isEntry: false,
        })
      ).toBe(ssrId);
    });

    it('returns virtual exposes SSR ID as-is', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const exposesId = 'virtual:mf-exposes-ssr:__mfe_internal__remote';

      expect(
        callHook(mainPlugin.resolveId, {} as Rollup.PluginContext, exposesId, undefined, {
          isEntry: false,
        })
      ).toBe(exposesId);
    });
  });

  describe('main plugin — load', () => {
    it('returns SSR remote entry code for SSR entry ID', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      const result = callHook(mainPlugin.load, {} as Rollup.PluginContext, ssrId);

      expect(result).toBe('export { init, get }');
      expect(generateRemoteEntrySSR).toHaveBeenCalledWith(
        expect.objectContaining({
          internalName: '__mfe_internal__remote',
          name: 'remote',
        })
      );
    });

    it('returns SSR exposes map for exposes ID', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const exposesId = 'virtual:mf-exposes-ssr:__mfe_internal__remote';

      const result = callHook(mainPlugin.load, {} as Rollup.PluginContext, exposesId);

      expect(result).toBe('export default {}');
    });

    it('returns undefined for unknown IDs', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      expect(
        callHook(mainPlugin.load, {} as Rollup.PluginContext, '/some/other/file.js')
      ).toBeUndefined();
    });
  });

  describe('main plugin — configureServer runner endpoint', () => {
    it('delegates supported Vite runner invokes to the environment hot channel', async () => {
      const payload = {
        type: 'custom',
        event: 'vite:invoke',
        data: {
          id: 'send',
          name: 'fetchModule',
          data: ['virtual:some-plugin-module', null, { cached: false }],
        },
      };
      const handleInvoke = vi.fn().mockResolvedValue({ result: { code: 'export default 1' } });

      const res = await invokeRunnerMiddleware(payload, {
        fetchModule: vi.fn(),
        hot: { handleInvoke },
      });

      expect(handleInvoke).toHaveBeenCalledWith(payload);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(JSON.parse(res.body)).toEqual({ result: { code: 'export default 1' } });
    });

    it('leaves CORS and preflight policy to Vite middleware', async () => {
      const handleInvoke = vi.fn();
      const res = await invokeRunnerMiddleware(
        undefined,
        { fetchModule: vi.fn(), hot: { handleInvoke } },
        undefined,
        { root: '/mock/cwd' },
        'OPTIONS'
      );

      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(405);
      expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(res.headers['Access-Control-Allow-Methods']).toBeUndefined();
    });

    it.each([
      { startOffset: -1 },
      { startOffset: 1.5 },
      { startOffset: Number.MAX_SAFE_INTEGER },
      { startOffset: '10' },
      { cached: 'yes' },
      { inlineSourceMap: 1 },
      { unknown: true },
    ])('rejects unsafe fetchModule options: %j', async (opts) => {
      const handleInvoke = vi.fn();
      const res = await invokeRunnerMiddleware(
        {
          type: 'custom',
          event: 'vite:invoke',
          data: { id: 'send', name: 'fetchModule', data: ['virtual:safe', null, opts] },
        },
        { fetchModule: vi.fn(), hot: { handleInvoke } }
      );

      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid runner invoke' } });
    });

    it('accepts bounded supported fetchModule options', async () => {
      const handleInvoke = vi.fn().mockResolvedValue({ result: { code: 'export default 1' } });
      const payload = {
        type: 'custom',
        event: 'vite:invoke',
        data: {
          id: 'send',
          name: 'fetchModule',
          data: [
            'virtual:safe',
            null,
            { cached: false, inlineSourceMap: true, startOffset: 1024 * 1024 },
          ],
        },
      };

      const res = await invokeRunnerMiddleware(payload, {
        fetchModule: vi.fn(),
        hot: { handleInvoke },
      });

      expect(handleInvoke).toHaveBeenCalledWith(payload);
      expect(res.statusCode).toBe(200);
    });

    it('rejects malformed or unsupported runner invokes before calling Vite', async () => {
      const handleInvoke = vi.fn();

      const res = await invokeRunnerMiddleware(
        { name: 'fetchModule', data: ['/src/App.tsx'] },
        {
          fetchModule: vi.fn(),
          hot: { handleInvoke },
        }
      );

      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid runner invoke' } });
    });

    it('rejects invalid runner argument shapes before calling Vite', async () => {
      const handleInvoke = vi.fn();

      const res = await invokeRunnerMiddleware(
        {
          type: 'custom',
          event: 'vite:invoke',
          data: { id: 'send', name: 'fetchModule', data: [123] },
        },
        {
          fetchModule: vi.fn(),
          hot: { handleInvoke },
        }
      );

      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid runner invoke' } });
    });

    it('rejects filesystem escape module ids before calling Vite', async () => {
      const outsideRoot = path.join(os.tmpdir(), `mf-runner-secret-${Date.now()}.txt`);
      fs.writeFileSync(outsideRoot, 'secret');
      const unsafeIds = [
        `${pathToFileURL(outsideRoot).href}?raw`,
        `/@fs/${outsideRoot}?raw`,
        `${outsideRoot}?raw`,
      ];

      try {
        for (const id of unsafeIds) {
          const handleInvoke = vi.fn();
          const res = await invokeRunnerMiddleware(
            {
              type: 'custom',
              event: 'vite:invoke',
              data: { id: 'send', name: 'fetchModule', data: [id] },
            },
            {
              fetchModule: vi.fn(),
              hot: { handleInvoke },
            }
          );

          expect(handleInvoke).not.toHaveBeenCalled();
          expect(res.statusCode).toBe(400);
          expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid runner invoke' } });
        }
      } finally {
        fs.rmSync(outsideRoot, { force: true });
      }
    });

    it('allows filesystem ids inside Vite fs.allow before calling Vite', async () => {
      const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-runner-allowed-'));
      const allowedFile = path.join(allowedDir, 'Widget.tsx');
      fs.writeFileSync(allowedFile, 'export default function Widget() {}');
      const handleInvoke = vi.fn().mockResolvedValue({ result: { code: 'export default 1' } });

      try {
        const res = await invokeRunnerMiddleware(
          {
            type: 'custom',
            event: 'vite:invoke',
            data: { id: 'send', name: 'fetchModule', data: [`/@fs/${allowedFile}`] },
          },
          {
            fetchModule: vi.fn(),
            hot: { handleInvoke },
          },
          undefined,
          { root: '/mock/cwd', server: { fs: { allow: [allowedDir] } } }
        );

        expect(handleInvoke).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ result: { code: 'export default 1' } });
      } finally {
        fs.rmSync(allowedDir, { recursive: true, force: true });
      }
    });

    it('rejects percent-encoded relative traversal before calling Vite', async () => {
      const handleInvoke = vi.fn();

      const res = await invokeRunnerMiddleware(
        {
          type: 'custom',
          event: 'vite:invoke',
          data: { id: 'send', name: 'fetchModule', data: ['..%2F..%2Foutside-root.txt'] },
        },
        {
          fetchModule: vi.fn(),
          hot: { handleInvoke },
        }
      );

      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid runner invoke' } });
    });

    it('rejects relative traversal module ids before calling Vite', async () => {
      const handleInvoke = vi.fn().mockResolvedValue({ result: { code: 'escaped' } });

      const res = await invokeRunnerMiddleware(
        {
          type: 'custom',
          event: 'vite:invoke',
          data: { id: 'send', name: 'fetchModule', data: ['../../outside-root.txt'] },
        },
        {
          fetchModule: vi.fn(),
          hot: { handleInvoke },
        }
      );

      // `../` specifiers should be rejected by this endpoint instead of being
      // forwarded to Vite, otherwise path traversal validation depends on Vite.
      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid runner invoke' } });
    });

    it('returns 400 for malformed encoded /@fs/ ids before calling Vite', async () => {
      const handleInvoke = vi.fn();

      const res = await invokeRunnerMiddleware(
        {
          type: 'custom',
          event: 'vite:invoke',
          data: { id: 'send', name: 'fetchModule', data: ['/@fs/%'] },
        },
        {
          fetchModule: vi.fn(),
          hot: { handleInvoke },
        }
      );

      // Malformed URI encoding should stay on the validation failure path.
      // If decodeURIComponent throws into the outer catch, this becomes a 200.
      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid runner invoke' } });
    });

    it('rejects getBuiltins invokes without the Vite invoke envelope', async () => {
      const handleInvoke = vi.fn();

      const res = await invokeRunnerMiddleware(
        { data: { id: 'send', name: 'getBuiltins', data: [] } },
        {
          fetchModule: vi.fn(),
          hot: { handleInvoke },
        }
      );

      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid runner invoke' } });
    });

    it('returns 400 for invalid JSON before calling Vite', async () => {
      const handleInvoke = vi.fn();

      const res = await invokeRunnerMiddleware(
        undefined,
        {
          fetchModule: vi.fn(),
          hot: { handleInvoke },
        },
        '{bad json'
      );

      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid JSON' } });
    });

    it('rejects oversized runner invoke bodies before calling Vite', async () => {
      const handleInvoke = vi.fn();

      const res = await invokeRunnerMiddleware('x'.repeat(1024 * 1024), {
        fetchModule: vi.fn(),
        hot: { handleInvoke },
      });

      expect(handleInvoke).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(413);
      expect(res.body).toBe('Payload too large');
    });
  });

  describe('main plugin — buildStart', () => {
    it('emits SSR entry as a pre-generated ESM asset for Rollup (avoids code-splitting side effects)', () => {
      getIsRolldownMock.mockReturnValue(false);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(false),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'asset',
          fileName: 'remoteEntry.ssr.js',
        })
      );
    });

    it('emits SSR entry chunk for Rolldown (ESM output)', () => {
      getIsRolldownMock.mockReturnValue(true);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(true),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chunk',
          name: 'ssrRemoteEntry',
          fileName: 'remoteEntry.ssr.js',
        })
      );
    });

    it('skips emit when no exposes are configured', () => {
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions({ exposes: {} }));
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).not.toHaveBeenCalled();
    });

    it('emits in the ssr environment when environments.ssr is configured', () => {
      getIsRolldownMock.mockReturnValue(true);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const configResolved = mainPlugin.configResolved as (config: ResolvedConfig) => void;
      configResolved?.({
        environments: { client: {}, ssr: {} },
      } as unknown as ResolvedConfig);

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(true),
          emitFile,
          environment: { name: 'ssr' },
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chunk',
          fileName: 'remoteEntry.ssr.js',
        })
      );
    });

    it('skips emit in the client environment when environments.ssr is configured', () => {
      getIsRolldownMock.mockReturnValue(true);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const configResolved = mainPlugin.configResolved as (config: ResolvedConfig) => void;
      configResolved?.({
        environments: { client: {}, ssr: {} },
      } as unknown as ResolvedConfig);

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(true),
          emitFile,
          environment: { name: 'client' },
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).not.toHaveBeenCalled();
    });

    it('still emits in the client environment for Nuxt when environments.ssr is configured', () => {
      isNuxtProjectRootMock.mockReturnValue(true);
      getIsRolldownMock.mockReturnValue(true);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const configResolved = mainPlugin.configResolved as (config: ResolvedConfig) => void;
      configResolved?.({
        root: '/app',
        environments: { client: {}, ssr: {} },
      } as unknown as ResolvedConfig);

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(true),
          emitFile,
          environment: { name: 'client' },
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chunk',
          fileName: 'remoteEntry.ssr.js',
        })
      );
    });

    it('skips emit in the ssr environment when only a client environment exists', () => {
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(),
          emitFile,
          environment: { name: 'ssr' },
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).not.toHaveBeenCalled();
    });

    it('emits in client environment', () => {
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(),
          emitFile,
          environment: { name: 'client' },
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalled();
    });

    it('emits when environment name is absent (Rollup)', () => {
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalled();
    });
  });

  describe('main plugin — buildStart (Rollup ESM asset generation)', () => {
    function getEmittedAssetSource() {
      getIsRolldownMock.mockReturnValue(false);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        { meta: makePluginMeta(false), emitFile } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      const call = emitFile.mock.calls[0]?.[0] as { source?: string } | undefined;
      return call?.source ?? '';
    }

    it('emits asset with ESM export syntax from mock ESM source', () => {
      const source = getEmittedAssetSource();
      expect(source).toBe(`export { init, get }`);
    });
  });

  describe('main plugin — generateBundle', () => {
    it('leaves Rolldown (ESM) bundle unchanged', () => {
      getIsRolldownMock.mockReturnValue(true);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        { meta: makePluginMeta(true), emitFile } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      const originalCode = `import { init } from "@module-federation/runtime"; export { init };`;
      const chunk = {
        type: 'chunk' as const,
        code: originalCode,
        fileName: 'remoteEntry.ssr.js',
      };
      const bundle = { 'remoteEntry.ssr.js': chunk };

      callHook(
        mainPlugin.generateBundle,
        {} as Rollup.PluginContext,
        {} as Rollup.NormalizedOutputOptions,
        bundle as unknown as Rollup.OutputBundle,
        false
      );

      expect(chunk.code).toBe(originalCode);
    });

    it('does not throw when SSR chunk is not in bundle', () => {
      getIsRolldownMock.mockReturnValue(false);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        { meta: makePluginMeta(false), emitFile } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(() =>
        callHook(
          mainPlugin.generateBundle,
          {} as Rollup.PluginContext,
          {} as Rollup.NormalizedOutputOptions,
          {} as unknown as Rollup.OutputBundle,
          false
        )
      ).not.toThrow();
    });

    it('rewrites Nuxt Rollup SSR asset to import the emitted _nuxt exposes chunk', () => {
      getIsRolldownMock.mockReturnValue(false);
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.configResolved,
        {} as Rollup.PluginContext,
        { command: 'build', base: '/_nuxt/' } as ResolvedConfig
      );
      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(false),
          emitFile: makeEmitFile(),
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      const asset = {
        type: 'asset' as const,
        fileName: 'remoteEntry.ssr.js',
        source: 'const map = import("virtual:mf-exposes-ssr:remote");',
      };
      const exposesChunk = {
        type: 'chunk' as const,
        fileName: '_nuxt/virtualExposes-abc.js',
        code: 'export default {"./Widget": () => import("./Widget.js")}',
      };
      const bundle = {
        'remoteEntry.ssr.js': asset,
        '_nuxt/virtualExposes-abc.js': exposesChunk,
      };

      callHook(
        mainPlugin.generateBundle,
        {} as Rollup.PluginContext,
        {} as Rollup.NormalizedOutputOptions,
        bundle as unknown as Rollup.OutputBundle,
        false
      );

      expect(asset.source).toBe('const map = import("./_nuxt/virtualExposes-abc.js");');
    });
  });

  describe('main plugin — writeBundle', () => {
    function prepareSsrPublish(
      mainPlugin: NonNullable<ReturnType<typeof pluginSSRRemoteEntry>[1]>,
      root: string,
      clientDir: string
    ) {
      const configResolved = mainPlugin.configResolved as (config: ResolvedConfig) => void;
      configResolved?.({
        root,
        environments: { client: { build: { outDir: clientDir } } },
      } as unknown as ResolvedConfig);
      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(false),
          emitFile: makeEmitFile(),
          environment: { name: 'ssr' },
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      const outputBundle = {
        'remoteEntry.ssr.js': {
          type: 'chunk',
          fileName: 'remoteEntry.ssr.js',
          imports: ['mf-assets/exposes-map.js', 'mf-assets/ssr-only.js', 'mf-assets/shared.js'],
          dynamicImports: [],
          implicitlyLoadedBefore: [],
          referencedFiles: [],
        },
        'mf-assets/exposes-map.js': {
          type: 'asset',
          fileName: 'mf-assets/exposes-map.js',
          source: 'export default { Widget: () => import("./Widget.js") };',
        },
        'mf-assets/ssr-only.js': { type: 'chunk', fileName: 'mf-assets/ssr-only.js' },
        'mf-assets/Widget.js': { type: 'chunk', fileName: 'mf-assets/Widget.js' },
        'mf-assets/shared.js': { type: 'chunk', fileName: 'mf-assets/shared.js' },
      } as unknown as Rollup.OutputBundle;
      callHook(
        mainPlugin.generateBundle,
        { environment: { name: 'ssr' } } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedOutputOptions,
        outputBundle,
        true
      );

      return outputBundle;
    }

    it('publishes the SSR entry graph without exposing unrelated server files', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-vite-'));
      const ssrDir = path.join(root, 'dist', 'ssr');
      const clientDir = path.join(root, 'dist', 'client');
      fs.mkdirSync(path.join(ssrDir, 'mf-assets'), { recursive: true });
      fs.mkdirSync(path.join(clientDir, 'mf-assets'), { recursive: true });
      fs.writeFileSync(path.join(ssrDir, 'remoteEntry.ssr.js'), 'ssr entry');
      fs.writeFileSync(path.join(ssrDir, 'mf-assets', 'exposes-map.js'), 'exposes map');
      fs.writeFileSync(path.join(ssrDir, 'mf-assets', 'ssr-only.js'), 'ssr asset');
      fs.writeFileSync(path.join(ssrDir, 'mf-assets', 'Widget.js'), 'exposed widget');
      fs.writeFileSync(path.join(ssrDir, 'mf-assets', 'shared.js'), 'ssr shared');
      fs.writeFileSync(path.join(ssrDir, 'server-only.js'), 'private server code');
      fs.writeFileSync(path.join(clientDir, 'mf-assets', 'shared.js'), 'client shared');

      try {
        const plugins = pluginSSRRemoteEntry(makeOptions());
        const mainPlugin = plugins[1];
        const outputBundle = prepareSsrPublish(mainPlugin, root, clientDir);
        callHook(
          mainPlugin.writeBundle,
          { environment: { name: 'ssr' } } as unknown as Rollup.PluginContext,
          { dir: ssrDir } as Rollup.NormalizedOutputOptions,
          outputBundle
        );

        expect(fs.readFileSync(path.join(clientDir, 'remoteEntry.ssr.js'), 'utf8')).toBe(
          'ssr entry'
        );
        expect(fs.readFileSync(path.join(clientDir, 'mf-assets', 'ssr-only.js'), 'utf8')).toBe(
          'ssr asset'
        );
        expect(fs.readFileSync(path.join(clientDir, 'mf-assets', 'Widget.js'), 'utf8')).toBe(
          'exposed widget'
        );
        expect(fs.readFileSync(path.join(clientDir, 'mf-assets', 'shared.js'), 'utf8')).toBe(
          'client shared'
        );
        expect(fs.existsSync(path.join(clientDir, 'server-only.js'))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('defers SSR graph publication until the client output directory is available', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-vite-'));
      const ssrDir = path.join(root, 'dist', 'ssr');
      const clientDir = path.join(root, 'dist', 'client');
      fs.mkdirSync(path.join(ssrDir, 'mf-assets'), { recursive: true });
      fs.writeFileSync(path.join(ssrDir, 'remoteEntry.ssr.js'), 'ssr entry');
      fs.writeFileSync(path.join(ssrDir, 'mf-assets', 'exposes-map.js'), 'exposes map');
      fs.writeFileSync(path.join(ssrDir, 'mf-assets', 'ssr-only.js'), 'ssr asset');
      fs.writeFileSync(path.join(ssrDir, 'mf-assets', 'Widget.js'), 'exposed widget');
      fs.writeFileSync(path.join(ssrDir, 'mf-assets', 'shared.js'), 'ssr shared');

      try {
        const plugins = pluginSSRRemoteEntry(makeOptions());
        const mainPlugin = plugins[1];
        const outputBundle = prepareSsrPublish(mainPlugin, root, clientDir);

        callHook(
          mainPlugin.writeBundle,
          { environment: { name: 'ssr' } } as unknown as Rollup.PluginContext,
          { dir: ssrDir } as Rollup.NormalizedOutputOptions,
          outputBundle
        );
        fs.rmSync(clientDir, { recursive: true, force: true });

        callHook(
          mainPlugin.writeBundle,
          { environment: { name: 'client' } } as unknown as Rollup.PluginContext,
          { dir: clientDir } as Rollup.NormalizedOutputOptions,
          outputBundle
        );

        expect(fs.readFileSync(path.join(clientDir, 'remoteEntry.ssr.js'), 'utf8')).toBe(
          'ssr entry'
        );
        expect(fs.readFileSync(path.join(clientDir, 'mf-assets', 'Widget.js'), 'utf8')).toBe(
          'exposed widget'
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
