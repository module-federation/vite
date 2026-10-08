import type { IncomingMessage, ServerResponse } from 'http';
import type { ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { normalizeModuleFederationOptions } from '../../../utils/normalizeModuleFederationOptions';
import type { AdapterContext } from '../../pluginDevRemoteHmr';
import { reactAdapter } from '../react';

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  next: () => void
) => void;

function createCtx(base = '/'): { ctx: AdapterContext; middlewares: Middleware[] } {
  const middlewares: Middleware[] = [];
  const ctx: AdapterContext = {
    server: {
      config: { base, root: process.cwd() },
      middlewares: {
        use: (handler: Middleware) => {
          middlewares.push(handler);
        },
      },
    } as unknown as ViteDevServer,
    options: normalizeModuleFederationOptions({
      name: 'remote-app',
      exposes: { './Foo': { import: './src/Foo.tsx' } },
      remotes: {},
      virtualModuleDir: '__mf__virtual',
    }),
  };
  return { ctx, middlewares };
}

describe('reactAdapter', () => {
  it('declares the React-specific plugin names', () => {
    expect(reactAdapter.pluginNames).toEqual(
      expect.arrayContaining(['vite:react-refresh', 'vite:react-swc'])
    );
  });

  it('serves the /@react-refresh proxy module', () => {
    const { ctx, middlewares } = createCtx();
    reactAdapter.remote?.configureServer?.(ctx);
    expect(middlewares).toHaveLength(1);

    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    middlewares[0](
      { url: '/@react-refresh?v=abc' } as IncomingMessage,
      res as unknown as ServerResponse<IncomingMessage>,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/javascript; charset=utf-8'
    );
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('window.location.origin'));
    expect(res.end).toHaveBeenCalledWith(
      expect.stringContaining('export const getRefreshReg = __rt.getRefreshReg;')
    );
  });

  it('serves the React refresh proxy under the configured base path', () => {
    const { ctx, middlewares } = createCtx('/aaa/');
    reactAdapter.remote?.configureServer?.(ctx);

    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    middlewares[0](
      { url: '/aaa/@react-refresh?v=abc' } as IncomingMessage,
      res as unknown as ServerResponse<IncomingMessage>,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('window.location.origin'));
    expect(res.end).toHaveBeenCalledWith(
      expect.stringContaining("new URL('./@mf-react-refresh-local', __remoteUrl).href")
    );
  });

  it('serves the local React refresh runtime under the configured base path', () => {
    const { ctx, middlewares } = createCtx('/aaa/');
    reactAdapter.remote?.configureServer?.(ctx);

    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    middlewares[0](
      { url: '/aaa/@mf-react-refresh-local' } as IncomingMessage,
      res as unknown as ServerResponse<IncomingMessage>,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('injectIntoGlobalHook'));
  });

  it('passes other requests through', () => {
    const { ctx, middlewares } = createCtx();
    reactAdapter.remote?.configureServer?.(ctx);

    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    middlewares[0](
      { url: '/some-other-path' } as IncomingMessage,
      res as unknown as ServerResponse<IncomingMessage>,
      next
    );

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('injects the host React refresh URL with the configured base path', () => {
    const { ctx } = createCtx('/bbb/');
    const tags = reactAdapter.host?.transformIndexHtml?.(ctx);

    expect(tags).toEqual([
      expect.objectContaining({
        tag: 'script',
        injectTo: 'head-prepend',
        children: expect.stringContaining(
          'globalThis.__MF_REACT_REFRESH_URL__ = new URL("/bbb/@react-refresh"'
        ),
      }),
      expect.objectContaining({
        tag: 'script',
        attrs: { type: 'module' },
        injectTo: 'head-prepend',
        children: expect.stringContaining('import * as rt from "/bbb/@react-refresh"'),
      }),
    ]);
  });

  it('publishes the bundledDev host runtime from the unprefixed preamble path', () => {
    const { ctx } = createCtx('/bbb/');
    (ctx.server.config as { experimental?: { bundledDev?: boolean } }).experimental = {
      bundledDev: true,
    };
    const tags = reactAdapter.host?.transformIndexHtml?.(ctx) ?? [];

    expect(tags[1].children).toContain('import * as rt from "/@react-refresh"');
    expect(tags[1].children).toContain(
      'globalThis.__MF_REACT_REFRESH_RUNTIME__ ??= rt.__mfLocalRuntime || rt;'
    );
  });

  it('lets the unbundled remote proxy prefer the published host runtime', () => {
    const { ctx, middlewares } = createCtx();
    reactAdapter.remote?.configureServer?.(ctx);
    const res = { setHeader: vi.fn(), end: vi.fn() };
    middlewares[0](
      { url: '/@react-refresh' } as IncomingMessage,
      res as unknown as ServerResponse<IncomingMessage>,
      vi.fn()
    );

    expect(res.end).toHaveBeenCalledWith(
      expect.stringContaining(
        'const __rt = (__isHost && globalThis.__MF_REACT_REFRESH_RUNTIME__) || await import(__target);'
      )
    );
  });

  it('delegates a bundledDev remote /@react-refresh to the host runtime', () => {
    const root = process.cwd();
    expect(reactAdapter.remote?.load?.('/@react-refresh', { root, isBundled: false })).toBe(
      undefined
    );

    const code = reactAdapter.remote?.load?.('/@react-refresh', { root, isBundled: true });
    expect(code).toContain("import * as __local from 'virtual:mf-react-refresh-local';");
    expect(code).toContain(
      'const __rt = () => globalThis.__MF_REACT_REFRESH_RUNTIME__ || __local;'
    );
    expect(code).toContain(
      'export function register(...args) { return __rt().register(...args); }'
    );
    expect(code).not.toContain('await');

    const localId = reactAdapter.remote?.resolveId?.('virtual:mf-react-refresh-local');
    expect(localId).toBe('\0virtual:mf-react-refresh-local');
    expect(reactAdapter.remote?.load?.(localId!, { root, isBundled: true })).toContain(
      'injectIntoGlobalHook'
    );
  });
});
