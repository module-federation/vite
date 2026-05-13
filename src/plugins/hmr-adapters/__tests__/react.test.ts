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

function createCtx(): { ctx: AdapterContext; middlewares: Middleware[] } {
  const middlewares: Middleware[] = [];
  const ctx: AdapterContext = {
    server: {
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
    strategy: 'native',
  };
  return { ctx, middlewares };
}

describe('reactAdapter', () => {
  it('declares the React-specific plugin names', () => {
    expect(reactAdapter.pluginNames).toEqual(
      expect.arrayContaining(['vite:react-refresh', 'vite:react-swc:refresh'])
    );
  });

  it('serves the /@react-refresh proxy module', () => {
    const { ctx, middlewares } = createCtx();
    reactAdapter.configureRemote?.(ctx);
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

  it('passes other requests through', () => {
    const { ctx, middlewares } = createCtx();
    reactAdapter.configureRemote?.(ctx);

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

  it('does not provide a validate hook', () => {
    expect(reactAdapter.validate).toBeUndefined();
  });
});
