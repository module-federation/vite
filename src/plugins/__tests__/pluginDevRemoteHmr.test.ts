import { beforeEach, describe, expect, it, vi } from 'vitest';
import pluginDevRemoteHmr from '../pluginDevRemoteHmr';

const { mfWarn } = vi.hoisted(() => ({
  mfWarn: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  mfWarn,
}));

type WatcherEvent = 'change' | 'add' | 'unlink';

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

function createServer(overrides: Record<string, any> = {}) {
  const watcherHandlers = new Map<WatcherEvent, Set<(file: string) => void>>();
  const closeHandlers: Array<() => void> = [];
  const middlewares: Array<(req: any, res: any, next: () => void) => void> = [];

  const server = {
    config: {
      base: '/',
      webSocketToken: 'dev-token',
      server: {
        host: 'localhost',
        port: 5173,
        https: false,
        hmr: undefined,
      },
    },
    middlewares: {
      use: vi.fn((handler: (req: any, res: any, next: () => void) => void) => {
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
    ...overrides,
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

    const plugin = pluginDevRemoteHmr({
      name: 'remote-app',
      dev: { remoteHmr: true },
      exposes: { './Button': { import: './src/Button.tsx' } },
      remotes: {},
      virtualModuleDir: '__mf__virtual',
    } as any);

    plugin.configureServer?.(server as any);

    expect(middlewares).toHaveLength(1);

    const res = {
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();
    middlewares[0]({ url: '/app/__mf_hmr?x=1' }, res, next);

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

  it('connects host to remote hmr websocket and triggers full reload', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        event: 'mf:remote-update',
        wsUrl: 'ws://remote.example:4174/app?token=abc',
      }),
    }));

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket as any);

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

    const plugin = pluginDevRemoteHmr({
      name: 'host-app',
      dev: { remoteHmr: true },
      exposes: {},
      remotes: {
        remoteApp: {
          entry: 'http://remote.example/assets/remoteEntry.js?x=1#hash',
        },
      },
      virtualModuleDir: '__mf__virtual',
    } as any);

    plugin.configureServer?.(server as any);

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
    vi.stubGlobal('WebSocket', MockWebSocket as any);

    const { server, emit } = createServer();

    const plugin = pluginDevRemoteHmr({
      name: 'host-app',
      dev: { remoteHmr: true },
      exposes: {},
      remotes: {
        remoteApp: {
          entry: 'http://remote.example/assets/remoteEntry.js',
        },
      },
      virtualModuleDir: '__mf__virtual',
    } as any);

    plugin.configureServer?.(server as any);

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    emit('change', '/src/components/Counter.vue');
    emit('change', '/node_modules/vue/index.js');
    emit('change', '/src/__mf__virtual/chunk.js');

    expect(server.ws.send).toHaveBeenCalledWith({ type: 'full-reload' });
    expect(server.ws.send).toHaveBeenCalledTimes(1);
  });
});
