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

  it('does not register a host-side hook namespace', () => {
    expect(reactAdapter.host).toBeUndefined();
  });
});
