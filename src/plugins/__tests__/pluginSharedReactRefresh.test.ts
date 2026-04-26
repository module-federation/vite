import type { IncomingMessage, ServerResponse } from 'http';
import type { MinimalPluginContextWithoutEnvironment } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import pluginSharedReactRefresh from '../pluginSharedReactRefresh';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  next: () => void
) => void;

function createServer() {
  const middlewares: Middleware[] = [];
  const server = {
    middlewares: {
      use: vi.fn((handler: Middleware) => {
        middlewares.push(handler);
      }),
    },
  };
  return { server, middlewares };
}

function makePlugin(opts: { exposes?: Record<string, unknown>; remoteHmr?: boolean }) {
  return pluginSharedReactRefresh(
    normalizeModuleFederationOptions({
      name: 'test-app',
      dev: opts.remoteHmr ? { remoteHmr: true } : undefined,
      exposes: opts.exposes ?? {},
      remotes: {},
      virtualModuleDir: '__mf__virtual',
    })
  );
}

describe('pluginSharedReactRefresh', () => {
  it('returns plugin with correct name and apply mode', () => {
    const plugin = makePlugin({
      exposes: { './Foo': { import: './src/Foo.tsx' } },
      remoteHmr: true,
    });
    expect(plugin.name).toBe('module-federation-shared-react-refresh');
    expect(plugin.apply).toBe('serve');
  });

  it('does not add middleware when not a remote', () => {
    const plugin = makePlugin({ exposes: {}, remoteHmr: true });
    const { server, middlewares } = createServer();
    callHook(
      plugin.configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      server as unknown as import('vite').ViteDevServer
    );
    expect(middlewares).toHaveLength(0);
  });

  it('does not add middleware when remoteHmr is disabled', () => {
    const plugin = makePlugin({
      exposes: { './Foo': { import: './src/Foo.tsx' } },
      remoteHmr: false,
    });
    const { server, middlewares } = createServer();
    callHook(
      plugin.configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      server as unknown as import('vite').ViteDevServer
    );
    expect(middlewares).toHaveLength(0);
  });

  it('adds middleware when remote with remoteHmr enabled', () => {
    const plugin = makePlugin({
      exposes: { './Foo': { import: './src/Foo.tsx' } },
      remoteHmr: true,
    });
    const { server, middlewares } = createServer();
    callHook(
      plugin.configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      server as unknown as import('vite').ViteDevServer
    );
    expect(middlewares).toHaveLength(1);
  });

  it('middleware intercepts /@react-refresh requests', () => {
    const plugin = makePlugin({
      exposes: { './Foo': { import: './src/Foo.tsx' } },
      remoteHmr: true,
    });
    const { server, middlewares } = createServer();
    callHook(
      plugin.configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      server as unknown as import('vite').ViteDevServer
    );

    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    middlewares[0](
      { url: '/@react-refresh' } as IncomingMessage,
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

  it('middleware passes through non-/@react-refresh requests', () => {
    const plugin = makePlugin({
      exposes: { './Foo': { import: './src/Foo.tsx' } },
      remoteHmr: true,
    });
    const { server, middlewares } = createServer();
    callHook(
      plugin.configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      server as unknown as import('vite').ViteDevServer
    );

    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    middlewares[0](
      { url: '/other-path' } as IncomingMessage,
      res as unknown as ServerResponse<IncomingMessage>,
      next
    );

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('middleware strips query strings when matching', () => {
    const plugin = makePlugin({
      exposes: { './Foo': { import: './src/Foo.tsx' } },
      remoteHmr: true,
    });
    const { server, middlewares } = createServer();
    callHook(
      plugin.configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      server as unknown as import('vite').ViteDevServer
    );

    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    middlewares[0](
      { url: '/@react-refresh?v=123' } as IncomingMessage,
      res as unknown as ServerResponse<IncomingMessage>,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('window.location.origin'));
  });
});
