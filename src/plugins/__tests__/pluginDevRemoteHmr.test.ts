import type { IncomingMessage, ServerResponse } from 'http';
import type { MinimalPluginContextWithoutEnvironment } from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import pluginDevRemoteHmr from '../pluginDevRemoteHmr';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { callHook } from '../../utils/__tests__/viteHookHelpers';
const { mfWarn } = vi.hoisted(() => ({
  mfWarn: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  mfWarn,
}));

type WatcherEvent = 'change' | 'add' | 'unlink';

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  next: () => void
) => void;

type MockServer = {
  config: {
    base: string;
    webSocketToken: string;
    plugins: Array<{ name: string }>;
    server: {
      host: string;
      port: number;
      https: boolean;
      hmr:
        | undefined
        | {
            host?: string;
            clientPort?: number;
            path?: string;
          };
    };
  };
  middlewares: {
    use: ReturnType<typeof vi.fn<(handler: Middleware) => void>>;
  };
  watcher: {
    on: ReturnType<typeof vi.fn<(event: WatcherEvent, handler: (file: string) => void) => void>>;
    off: ReturnType<typeof vi.fn<(event: WatcherEvent, handler: (file: string) => void) => void>>;
  };
  ws: {
    send: ReturnType<typeof vi.fn>;
  };
  httpServer: {
    once: ReturnType<typeof vi.fn<(event: string, handler: () => void) => void>>;
  };
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function runConfigureServer(
  plugin: ReturnType<typeof pluginDevRemoteHmr>,
  server: MockServer
): void {
  callHook(
    plugin.configureServer,
    {} as MinimalPluginContextWithoutEnvironment,
    server as unknown as import('vite').ViteDevServer
  );
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CLOSING = 2;
  static CLOSED = 3;

  readonly CLOSING = MockWebSocket.CLOSING;
  readonly CLOSED = MockWebSocket.CLOSED;
  readonly close = vi.fn(() => {
    this.readyState = this.CLOSED;
  });

  readyState = 1;
  onmessage?: (event: { data: unknown }) => void;
  onopen?: () => void;
  onerror?: (error: unknown) => void;
  onclose?: () => void;

  constructor(
    readonly url: string,
    readonly protocol: string
  ) {
    MockWebSocket.instances.push(this);
  }
}

function createServer(overrides: DeepPartial<MockServer> = {}) {
  const watcherHandlers = new Map<WatcherEvent, Set<(file: string) => void>>();
  const closeHandlers: Array<() => void> = [];
  const middlewares: Middleware[] = [];

  const server: MockServer = {
    config: {
      base: overrides.config?.base ?? '/',
      webSocketToken: overrides.config?.webSocketToken ?? 'dev-token',
      plugins: overrides.config?.plugins ?? [],
      server: {
        host: overrides.config?.server?.host ?? 'localhost',
        port: overrides.config?.server?.port ?? 5173,
        https: overrides.config?.server?.https ?? false,
        hmr:
          overrides.config?.server?.hmr === undefined
            ? undefined
            : {
                host: overrides.config.server.hmr.host,
                clientPort: overrides.config.server.hmr.clientPort,
                path: overrides.config.server.hmr.path,
              },
      },
    },
    middlewares: {
      use: vi.fn((handler: Middleware) => {
        middlewares.push(handler);
      }),
    },
    watcher: {
      on: vi.fn((event: WatcherEvent, handler: (file: string) => void) => {
        const handlers = watcherHandlers.get(event) || new Set();
        handlers.add(handler);
        watcherHandlers.set(event, handlers);
      }),
      off: vi.fn((event: WatcherEvent, handler: (file: string) => void) => {
        watcherHandlers.get(event)?.delete(handler);
      }),
    },
    ws: {
      send: vi.fn(),
    },
    httpServer: {
      once: vi.fn((event: string, handler: () => void) => {
        if (event === 'close') closeHandlers.push(handler);
      }),
    },
  };

  return {
    server,
    middlewares,
    emit(event: WatcherEvent, file: string) {
      watcherHandlers.get(event)?.forEach((handler) => handler(file));
    },
    close() {
      closeHandlers.forEach((handler) => handler());
    },
  };
}

describe('pluginDevRemoteHmr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    MockWebSocket.instances = [];
  });

  it('serves remote metadata and broadcasts non-ignored file changes', () => {
    const { server, middlewares, emit, close } = createServer({
      config: {
        base: 'https://remote.example/app/',
        webSocketToken: 'token-123',
        server: {
          host: '0.0.0.0',
          port: 4173,
          https: true,
          hmr: {
            host: 'hmr.example',
            clientPort: 24678,
            path: '/hmr',
          },
        },
      },
    });

    const plugin = pluginDevRemoteHmr(
      normalizeModuleFederationOptions({
        name: 'remote-app',
        dev: { remoteHmr: true },
        exposes: { './Button': { import: './src/Button.tsx' } },
        remotes: {},
        virtualModuleDir: '__mf__virtual',
      })
    );

    runConfigureServer(plugin, server);

    expect(middlewares).toHaveLength(2);

    const res = {
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();
    middlewares[1](
      { url: '/app/__mf_hmr?x=1' } as IncomingMessage,
      res as unknown as ServerResponse<IncomingMessage>,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      remote: 'remote-app',
      event: 'mf:remote-update',
      wsUrl: 'wss://hmr.example:24678/app/hmr?token=token-123',
    });

    emit('change', '/src/Button.tsx');
    emit('change', '/node_modules/react/index.js');
    emit('add', '/src/other.tsx');
    emit('unlink', '/src/__mf__virtual/chunk.js');

    expect(server.ws.send).toHaveBeenCalledTimes(2);
    expect(server.ws.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'custom',
        event: 'mf:remote-update',
        data: expect.objectContaining({ remote: 'remote-app', file: '/src/Button.tsx' }),
      })
    );

    close();
    expect(server.watcher.off).toHaveBeenCalledTimes(3);
  });

  describe('react-refresh proxy middleware', () => {
    function makeRemotePlugin(opts: { exposes?: Record<string, unknown>; remoteHmr?: boolean }) {
      return pluginDevRemoteHmr(
        normalizeModuleFederationOptions({
          name: 'test-app',
          dev: opts.remoteHmr ? { remoteHmr: true } : undefined,
          exposes: opts.exposes ?? {},
          remotes: {},
          virtualModuleDir: '__mf__virtual',
        })
      );
    }

    it('should intercept /@react-refresh on remote dev servers', () => {
      const { server, middlewares } = createServer();
      const plugin = makeRemotePlugin({
        exposes: { './Foo': { import: './src/Foo.tsx' } },
        remoteHmr: true,
      });
      runConfigureServer(plugin, server);

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

    it('should pass through non-/@react-refresh requests', () => {
      const { server, middlewares } = createServer();
      const plugin = makeRemotePlugin({
        exposes: { './Foo': { import: './src/Foo.tsx' } },
        remoteHmr: true,
      });
      runConfigureServer(plugin, server);

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

    it('should strip query strings when matching /@react-refresh', () => {
      const { server, middlewares } = createServer();
      const plugin = makeRemotePlugin({
        exposes: { './Foo': { import: './src/Foo.tsx' } },
        remoteHmr: true,
      });
      runConfigureServer(plugin, server);

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

    it('should not intercept /@react-refresh when not a remote', () => {
      const { server, middlewares } = createServer();
      const plugin = makeRemotePlugin({
        exposes: {},
        remoteHmr: true,
      });
      runConfigureServer(plugin, server);

      expect(middlewares).toHaveLength(0);
    });
  });

  it('connects host to remote hmr websocket and triggers full reload', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        event: 'mf:remote-update',
        wsUrl: 'ws://remote.example:4174/app?token=abc',
      }),
    }));

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const { server, close } = createServer({
      config: {
        base: '/',
        webSocketToken: 'host-token',
        server: {
          host: '127.0.0.1',
          port: 5173,
          https: false,
          hmr: undefined,
        },
      },
    });

    const plugin = pluginDevRemoteHmr(
      normalizeModuleFederationOptions({
        name: 'host-app',
        dev: { remoteHmr: true },
        exposes: {},
        remotes: {
          remoteApp: 'remoteApp@http://remote.example/assets/remoteEntry.js?x=1#hash',
        },
        virtualModuleDir: '__mf__virtual',
      })
    );

    runConfigureServer(plugin, server);

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('http://remote.example/assets/__mf_hmr')
    );
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe('ws://remote.example:4174/app?token=abc');
    expect(socket.protocol).toBe('vite-hmr');

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'custom',
        event: 'mf:remote-update',
        data: { file: '/src/Button.tsx' },
      }),
    });

    expect(server.ws.send).toHaveBeenCalledWith({ type: 'full-reload' });

    close();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('triggers full reload for host local file changes', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        event: 'mf:remote-update',
        wsUrl: 'ws://remote.example:4174/app?token=abc',
      }),
    }));

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const { server, emit } = createServer();

    const plugin = pluginDevRemoteHmr(
      normalizeModuleFederationOptions({
        name: 'host-app',
        dev: { remoteHmr: true },
        exposes: {},
        remotes: {
          remoteApp: 'remoteApp@http://remote.example/assets/remoteEntry.js',
        },
        virtualModuleDir: '__mf__virtual',
      })
    );

    runConfigureServer(plugin, server);

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    emit('change', '/src/components/Counter.vue');
    emit('change', '/node_modules/vue/index.js');
    emit('change', '/src/__mf__virtual/chunk.js');

    expect(server.ws.send).toHaveBeenCalledWith({ type: 'full-reload' });
    expect(server.ws.send).toHaveBeenCalledTimes(1);
  });

  it('should ignore .mf output directory files', () => {
    const plugin = pluginDevRemoteHmr(
      normalizeModuleFederationOptions({
        name: 'remote-app',
        filename: 'remoteEntry.js',
        exposes: { './Button': './src/Button.tsx' },
        virtualModuleDir: '__mf__virtual',
      })
    );

    const { server, emit } = createServer();
    runConfigureServer(plugin, server);

    emit('change', '/project/.mf/diagnostics/latest.json');
    emit('change', 'C:\\project\\.mf\\diagnostics\\latest.json');

    expect(server.ws.send).not.toHaveBeenCalled();
  });

  it('should ignore mf-manifest.json and mf-stats.json', () => {
    const plugin = pluginDevRemoteHmr(
      normalizeModuleFederationOptions({
        name: 'remote-app',
        filename: 'remoteEntry.js',
        exposes: { './Button': './src/Button.tsx' },
        virtualModuleDir: '__mf__virtual',
      })
    );

    const { server, emit } = createServer();
    runConfigureServer(plugin, server);

    emit('change', '/project/mf-manifest.json');
    emit('change', 'C:\\project\\mf-manifest.json');
    emit('change', '/project/mf-stats.json');
    emit('change', 'C:\\project\\mf-stats.json');

    expect(server.ws.send).not.toHaveBeenCalled();
  });

  describe('remoteHmrStrategy', () => {
    const remoteOpts = {
      name: 'remote-app',
      exposes: { './Button': { import: './src/Button.tsx' } },
      remotes: {},
      virtualModuleDir: '__mf__virtual',
    } as const;

    it('suppresses broadcast when React plugin is detected', () => {
      const { server, emit } = createServer({
        config: { plugins: [{ name: 'vite:react-refresh' }] },
      });
      runConfigureServer(
        pluginDevRemoteHmr(
          normalizeModuleFederationOptions({ ...remoteOpts, dev: { remoteHmr: true } })
        ),
        server
      );
      emit('change', '/src/Button.tsx');
      expect(server.ws.send).not.toHaveBeenCalled();
    });

    it('broadcasts when no React plugin is detected', () => {
      const { server, emit } = createServer();
      runConfigureServer(
        pluginDevRemoteHmr(
          normalizeModuleFederationOptions({ ...remoteOpts, dev: { remoteHmr: true } })
        ),
        server
      );
      emit('change', '/src/Button.tsx');
      expect(server.ws.send).toHaveBeenCalled();
    });

    it('explicit remoteHmrStrategy overrides auto-detection', () => {
      const { server, emit } = createServer({
        config: { plugins: [{ name: 'vite:react-refresh' }] },
      });
      runConfigureServer(
        pluginDevRemoteHmr(
          normalizeModuleFederationOptions({
            ...remoteOpts,
            dev: { remoteHmr: true, remoteHmrStrategy: 'full-reload' },
          })
        ),
        server
      );
      emit('change', '/src/Button.tsx');
      expect(server.ws.send).toHaveBeenCalled();
    });
  });
});
