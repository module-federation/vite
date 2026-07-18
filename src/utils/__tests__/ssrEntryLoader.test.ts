/**
 * ssrEntryLoader tests.
 *
 * ssrEntryLoader has module-level caches (ssrEntryCache, manifestFetchCache, tempFileCache).
 * We use vi.resetModules() + dynamic import in each test to get a fresh
 * module instance with empty caches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchEntry = {
  ok: boolean;
  status?: number;
  statusText?: string;
  text?: string;
  json?: unknown;
  headers?: Record<string, string>;
};

function makeFetchMock(responses: Record<string, FetchEntry>) {
  return vi.fn(async (url: string, _options?: { method?: string; signal?: AbortSignal }) => {
    const entry = responses[url] ?? { ok: false };
    return {
      ok: entry.ok,
      status: entry.status ?? (entry.ok ? 200 : 404),
      statusText: entry.statusText ?? (entry.ok ? 'OK' : 'Not Found'),
      text: async () => entry.text ?? (entry.json !== undefined ? JSON.stringify(entry.json) : ''),
      json: async () => entry.json ?? {},
      headers: {
        get: (h: string) => entry.headers?.[h.toLowerCase()] ?? entry.headers?.[h] ?? null,
      },
    };
  });
}

function expectFetchCalled(fetch: ReturnType<typeof vi.fn>, url: string): void {
  expect(fetch.mock.calls.some(([requestUrl]) => requestUrl === url)).toBe(true);
}

function expectFetchNotCalled(fetch: ReturnType<typeof vi.fn>, url: string): void {
  expect(fetch.mock.calls.some(([requestUrl]) => requestUrl === url)).toBe(false);
}

async function freshLoaderModule() {
  vi.resetModules();
  vi.mock('path', () => ({
    default: {
      join: (...p: string[]) => p.join('/'),
      dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
    },
    join: (...p: string[]) => p.join('/'),
    dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
  }));
  vi.mock('fs', () => ({
    default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  }));
  vi.mock('crypto', () => {
    const hash = { update: vi.fn().mockReturnThis(), digest: vi.fn(() => 'abc123def456789') };
    return { default: { createHash: vi.fn(() => hash) }, createHash: vi.fn(() => hash) };
  });
  vi.mock('module', () => ({
    default: { createRequire: vi.fn() },
    createRequire: vi.fn(),
  }));
  return await import('../ssrEntryLoader');
}

async function freshLoader() {
  const { default: factory } = await freshLoaderModule();
  return factory;
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin factory', () => {
  it('is the default export and is a function', async () => {
    const factory = await freshLoader();
    expect(typeof factory).toBe('function');
  });

  it('returns a plugin with name and loadEntry hook', async () => {
    const factory = await freshLoader();
    const plugin = factory();
    expect(plugin.name).toBe('mf-vite:ssr-entry-loader');
    expect(typeof plugin.loadEntry).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Browser guard
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — browser guard', () => {
  it('still intercepts on Node when a DOM shim defines window', async () => {
    (globalThis as Record<string, unknown>).window = {};
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expectFetchCalled(fetch, 'http://localhost:5001/mf-manifest.json');
    delete (globalThis as Record<string, unknown>).window;
  });
});

// ---------------------------------------------------------------------------
// Manifest URL derivation
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — manifest URL derivation', () => {
  it('replaces the entry filename with mf-manifest.json', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': { ok: false },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expectFetchCalled(fetch, 'http://localhost:5001/mf-manifest.json');
  });
});

// ---------------------------------------------------------------------------
// URL convention fallback
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — URL convention fallback', () => {
  it('prefers the /__mf_server__/ SSR entry when available', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).toEqual([
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js',
    ]);
  });

  it('tries the .ssr.js convention when /__mf_server__/ is absent', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).toEqual([
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js',
      'http://localhost:5001/remoteEntry.ssr.js',
    ]);
  });

  it('falls back to the dev SSR middleware when root .ssr.js is HTML', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'text/html' },
      },
      'http://localhost:5001/__mf_ssr__/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).toEqual([
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js',
      'http://localhost:5001/remoteEntry.ssr.js',
      'http://localhost:5001/__mf_ssr__/remoteEntry.ssr.js',
    ]);
  });

  it('rejects HTML fallback responses', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'text/html' },
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    const result = await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when no SSR entry is discoverable', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': { ok: false },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    const result = await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Manifest-as-entry (.json remote entry URL)
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — manifest-as-entry', () => {
  it('loads an already-resolved SSR entry URL directly', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.ssr.js' },
    });
    expectFetchCalled(fetch, 'http://localhost:5001/remoteEntry.ssr.js');
    expectFetchNotCalled(fetch, 'http://localhost:5001/mf-manifest.json');
  });

  it('fetches the manifest URL directly when entry is mf-manifest.json', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/mf-manifest.json' },
    });
    expectFetchCalled(fetch, 'http://localhost:5001/mf-manifest.json');
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).not.toContain(
      'http://localhost:5001/__mf_server__/mf-manifest.ssr.js'
    );
  });

  it('resolves ssrRemoteEntry from manifest-as-entry without probing mf-manifest.ssr.js', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/mf-manifest.json' },
    });
    const getCall = fetch.mock.calls.find(
      (c) => c[0] === 'http://localhost:5001/remoteEntry.ssr.js' && !c[1]?.method
    );
    expect(getCall).toBeDefined();
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).not.toContain(
      'http://localhost:5001/__mf_server__/mf-manifest.ssr.js'
    );
  });

  it('falls back to __mf_server__ using remoteEntry.name when manifest lacks ssrRemoteEntry', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/mf-manifest.json' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).toEqual([
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js',
    ]);
  });

  it('uses manifest ssrRemoteEntry directly instead of probing fallbacks first', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: {
            remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
            ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
          },
        },
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/mf-manifest.json' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).toEqual([]);
    expectFetchCalled(fetch, 'http://localhost:5001/remoteEntry.ssr.js');
  });

  it('falls back to convention using remoteEntry.name when __mf_server__ is absent', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/mf-manifest.json' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).toEqual([
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js',
      'http://localhost:5001/remoteEntry.ssr.js',
    ]);
  });

  it('respects remoteEntry.path when falling back from manifest metadata', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/assets/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { remoteEntry: { name: 'remoteEntry.js', path: 'chunks/', type: 'module' } },
        },
      },
      'http://localhost:5001/assets/chunks/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/assets/chunks/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/assets/mf-manifest.json' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).toEqual([
      'http://localhost:5001/assets/chunks/__mf_server__/remoteEntry.ssr.js',
      'http://localhost:5001/assets/chunks/remoteEntry.ssr.js',
    ]);
  });

  it('caches SSR resolution per remote entry URL', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    const plugin = factory();
    const entry = 'http://localhost:5001/mf-manifest.json';

    await plugin.loadEntry!({ remoteInfo: { name: 'manifest', entry } });
    await plugin.loadEntry!({ remoteInfo: { name: 'manifest', entry } });

    const manifestGets = fetch.mock.calls.filter(
      (c) => c[0] === 'http://localhost:5001/mf-manifest.json' && !c[1]?.method
    );
    expect(manifestGets).toHaveLength(1);
  });

  it('aborts stalled requests and retries them instead of caching the timeout', async () => {
    const manifestUrl = 'http://localhost:5001/mf-manifest.json';
    let manifestAttempts = 0;
    const fetch = vi.fn(
      async (url: string, options?: { method?: string; signal?: AbortSignal }) => {
        if (url === manifestUrl) {
          manifestAttempts++;
          if (manifestAttempts === 1) {
            return new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                once: true,
              });
            });
          }
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              metaData: {
                ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
              },
            }),
            text: async () =>
              JSON.stringify({
                metaData: {
                  ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
                },
              }),
            headers: { get: (_header: string): string | null => 'application/json' },
          };
        }

        const isEntry = url === 'http://localhost:5001/remoteEntry.ssr.js' && !options?.method;
        return {
          ok: isEntry,
          status: isEntry ? 200 : 404,
          statusText: isEntry ? 'OK' : 'Not Found',
          json: async () => ({}),
          text: async () =>
            isEntry ? 'export async function init() {} export async function get() {}' : '',
          headers: {
            get: (_header: string): string | null => (isEntry ? 'application/javascript' : null),
          },
        };
      }
    );
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    const plugin = factory({ fetchTimeoutMs: 5 });
    const remoteInfo = { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' };

    await plugin.loadEntry!({ remoteInfo });
    await plugin.loadEntry!({ remoteInfo });

    expect(manifestAttempts).toBe(2);
    const firstManifestRequest = fetch.mock.calls.find(([url]) => url === manifestUrl);
    expect(firstManifestRequest?.[1]?.signal?.aborted).toBe(true);
  });

  it('does not share in-flight caches between different fetch timeouts', async () => {
    const manifestUrl = 'http://localhost:5001/mf-manifest.json';
    let manifestAttempts = 0;
    const fetch = vi.fn(
      async (url: string, options?: { method?: string; signal?: AbortSignal }) => {
        if (url === manifestUrl) {
          manifestAttempts++;
          if (options?.signal) {
            return new Promise<never>((_resolve, reject) => {
              options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                once: true,
              });
            });
          }
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              metaData: {
                ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
              },
            }),
            text: async () =>
              JSON.stringify({
                metaData: {
                  ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
                },
              }),
            headers: { get: (_header: string): string | null => 'application/json' },
          };
        }

        const isEntry = url === 'http://localhost:5001/remoteEntry.ssr.js' && !options?.method;
        return {
          ok: isEntry,
          status: isEntry ? 200 : 404,
          statusText: isEntry ? 'OK' : 'Not Found',
          json: async () => ({}),
          text: async () =>
            isEntry ? 'export async function init() {} export async function get() {}' : '',
          headers: {
            get: (_header: string): string | null => (isEntry ? 'application/javascript' : null),
          },
        };
      }
    );
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    const remoteInfo = { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' };
    const timedOutPlugin = factory({ fetchTimeoutMs: 5 });
    const unboundedPlugin = factory({ fetchTimeoutMs: 0 });

    await Promise.all([
      timedOutPlugin.loadEntry!({ remoteInfo }),
      unboundedPlugin.loadEntry!({ remoteInfo }),
    ]);

    expect(manifestAttempts).toBe(2);
    expect(fetch.mock.calls.some(([url, options]) => url === manifestUrl && !options?.signal)).toBe(
      true
    );
  });

  it('dedupes manifest fetches across js and manifest entry URLs', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
      'http://localhost:5001/remoteEntry.js': { ok: false },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    const plugin = factory();

    await plugin.loadEntry!({
      remoteInfo: { name: 'js', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    await plugin.loadEntry!({
      remoteInfo: { name: 'manifest', entry: 'http://localhost:5001/mf-manifest.json' },
    });

    const manifestGets = fetch.mock.calls.filter(
      (c) => c[0] === 'http://localhost:5001/mf-manifest.json' && !c[1]?.method
    );
    expect(manifestGets).toHaveLength(1);
  });

  it('supports a custom manifest fileName when used as the entry URL', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/dist/custom-manifest.json': {
        ok: true,
        json: {
          metaData: { ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/dist/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/dist/custom-manifest.json' },
    });
    expectFetchCalled(fetch, 'http://localhost:5001/dist/custom-manifest.json');
    expectFetchNotCalled(fetch, 'http://localhost:5001/dist/mf-manifest.json');
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).not.toContain(
      'http://localhost:5001/dist/__mf_server__/custom-manifest.ssr.js'
    );
  });

  it('still defaults to mf-manifest.json when deriving from remoteEntry.js', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/dist/custom-manifest.json': { ok: false },
      'http://localhost:5001/dist/mf-manifest.json': { ok: false },
      'http://localhost:5001/dist/remoteEntry.ssr.js': { ok: false },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/dist/remoteEntry.js' },
    });
    expectFetchCalled(fetch, 'http://localhost:5001/dist/mf-manifest.json');
    expectFetchNotCalled(fetch, 'http://localhost:5001/dist/custom-manifest.json');
  });
});

// ---------------------------------------------------------------------------
// Manifest SSR entry resolution
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — manifest SSR entry resolution', () => {
  it('uses ssrRemoteEntry from manifest after probing /__mf_server__', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.map((c) => c[0])).toEqual([
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js',
    ]);
    expectFetchCalled(fetch, 'http://localhost:5001/remoteEntry.ssr.js');
  });

  it('resolves SSR entry URL with path prefix from manifest', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: {
            ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: 'dist/', type: 'module' },
          },
        },
      },
      'http://localhost:5001/dist/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    const getCall = fetch.mock.calls.find(
      (c) => c[0] === 'http://localhost:5001/dist/remoteEntry.ssr.js' && !c[1]?.method
    );
    expect(getCall).toBeDefined();
  });

  it('falls back to convention when manifest has no ssrRemoteEntry field', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: { metaData: { remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' } } },
      },
      'http://localhost:5001/remoteEntry.ssr.js': { ok: false },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.length).toBeGreaterThan(0);
  });

  it('falls back to convention when manifest fetch fails', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': { ok: false },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Code transformation
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — code transformation', () => {
  it('evicts a timed-out module fetch so the next load can retry it', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const entryUrl = 'http://localhost:5001/remoteEntry.ssr.js';
    let attempts = 0;
    const fetch = vi.fn(async (_url: string, options?: { signal?: AbortSignal }) => {
      attempts++;
      if (attempts === 1) {
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => 'export async function init() {} export async function get() {}',
        headers: { get: () => 'application/javascript' },
      };
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    const plugin = factory({ fetchTimeoutMs: 5 });
    const remoteInfo = { name: 'r', entry: entryUrl };

    await plugin.loadEntry!({ remoteInfo });
    await plugin.loadEntry!({ remoteInfo });

    expect(attempts).toBe(2);
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('throws HTTP status details instead of importing a non-ok SSR entry response', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: {
            ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
          },
        },
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() { return "loaded-from-404"; }',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();

    await expect(
      factory().loadEntry!({
        remoteInfo: { name: 'r', entry: 'http://localhost:5001/mf-manifest.json' },
      })
    ).rejects.toThrow(
      'Failed to fetch SSR module "http://localhost:5001/remoteEntry.ssr.js": 404 Not Found'
    );
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('throws the missing transitive HTTP module URL when a nested import response is non-ok', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'import { t } from "./assets/missing.js";export async function init() {}',
      },
      'http://localhost:5001/assets/missing.js': {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'text/plain' },
        text: 'missing chunk',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();

    await expect(
      factory().loadEntry!({
        remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
      })
    ).rejects.toThrow(
      'Failed to fetch SSR module "http://localhost:5001/assets/missing.js": 500 Internal Server Error'
    );
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('fetches transitive relative imports', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: `import { t } from "./assets/helper.js";export async function init() {}`,
      },
      'http://localhost:5001/assets/helper.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export const t = 1;',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(fetch.mock.calls.some((c) => c[0] === 'http://localhost:5001/assets/helper.js')).toBe(
      true
    );
  });

  it('finishes fetching circular relative import graphs', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'import "./assets/cycle.js"; export async function init() {}',
      },
      'http://localhost:5001/assets/cycle.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'import "../remoteEntry.ssr.js"; export const cycle = true;',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();

    const result = await Promise.race([
      factory().loadEntry!({
        remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.ssr.js' },
      }).then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);

    expect(result).toBe('settled');
    expectFetchCalled(fetch, 'http://localhost:5001/remoteEntry.ssr.js');
    expectFetchCalled(fetch, 'http://localhost:5001/assets/cycle.js');
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized SSR module bodies before writing temp files', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const entryUrl = 'http://localhost:5001/remoteEntry.ssr.js';
    const fetch = makeFetchMock({
      [entryUrl]: {
        ok: true,
        headers: {
          'content-type': 'application/javascript',
          'content-length': '2048',
        },
        text: 'export async function init() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();

    await expect(
      factory({ fetchMaxBytes: 1024 }).loadEntry!({
        remoteInfo: { name: 'r', entry: entryUrl },
      })
    ).rejects.toThrow(/exceeds the 1024-byte limit/);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects oversized SSR manifest bodies instead of falling through', async () => {
    const fetch = makeFetchMock({
      // Server-build probe runs before the manifest fetch; keep it unavailable.
      'http://localhost:5001/__mf_server__/remoteEntry.ssr.js': { ok: false },
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        headers: { 'content-length': '2048' },
        json: { metaData: { name: 'r' } },
      },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();

    await expect(
      factory({ fetchMaxBytes: 1024 }).loadEntry!({
        remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
      })
    ).rejects.toThrow(/exceeds the 1024-byte limit/);
    expectFetchNotCalled(fetch, 'http://localhost:5001/remoteEntry.ssr.js');
  });

  it('does not reuse SSR caches across different fetchMaxBytes limits', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const entryUrl = 'http://localhost:5001/remoteEntry.ssr.js';
    const fetch = makeFetchMock({
      [entryUrl]: {
        ok: true,
        headers: {
          'content-type': 'application/javascript',
          'content-length': '2048',
        },
        text: 'export async function init() {} export async function get() {}',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    // One module instance so process-level caches are shared across options.
    const factory = await freshLoader();

    await factory({ fetchMaxBytes: 0 }).loadEntry!({
      remoteInfo: { name: 'r', entry: entryUrl },
    });

    await expect(
      factory({ fetchMaxBytes: 1024 }).loadEntry!({
        remoteInfo: { name: 'r', entry: entryUrl },
      })
    ).rejects.toThrow(/exceeds the 1024-byte limit/);
  });

  it('fetches loader-wrapped template literal dynamic imports', async () => {
    let written = '';
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (_p: unknown, code: unknown) => {
        written += `${code as string}\n`;
      }
    );
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'var mod = preload(() => import(`./assets/exposes.js`), []);export async function init() {}',
      },
      'http://localhost:5001/assets/exposes.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'export const exposed = 1;',
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(fetch.mock.calls.some((c) => c[0] === 'http://localhost:5001/assets/exposes.js')).toBe(
      true
    );
    expect(written).not.toContain('import(`http://localhost:5001/assets/exposes.js`)');
  });

  it('replaces Vite preload-helper import with server no-op', async () => {
    let written = '';
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (_p: unknown, code: unknown) => {
        written += code as string;
      }
    );
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: `import { t as e } from "./assets/preload-helper-ABC.js";export async function init() {}`,
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(written).toContain('const e = (fn) => fn();');
    expect(written).not.toContain('preload-helper');
  });

  it('replaces __vite__mapDeps with empty array', async () => {
    let written = '';
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (_p: unknown, code: unknown) => {
        written += code as string;
      }
    );
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: `const deps = __vite__mapDeps([0,1]);export async function init() {}`,
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(written).toContain('const deps = [];');
    expect(written).not.toContain('__vite__mapDeps');
  });

  it('rewrites shared bare package specifiers to file:// paths', async () => {
    let written = '';
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (_p: unknown, code: unknown) => {
        written += code as string;
      }
    );
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: `import{useState as e}from"react";export async function init() {}`,
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    // resolvedShared is pre-populated at build time by index.ts — simulate that here.
    await factory({ resolvedShared: { react: '/abs/node_modules/react/index.js' } }).loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(written).toContain('file:///abs/node_modules/react/index.js');
    expect(written).not.toMatch(/from\s*["']react["']/);
  });

  it('partitions transformed temp-file cache entries by host shares and scope', async () => {
    const written: string[] = [];
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (_p: unknown, code: unknown) => {
        written.push(code as string);
      }
    );
    const entryUrl = 'http://localhost:5001/remoteEntry.ssr.js';
    global.fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      [entryUrl]: {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: 'import { v } from "shared-lib"; export const value = v;',
      },
    }) as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();

    await factory({
      resolvedShared: { 'shared-lib': '/host-a/shared.mjs' },
      shareScopeName: 'scope-a',
    }).loadEntry!({ remoteInfo: { name: 'a', entry: 'http://localhost:5001/remoteEntry.js' } });
    await factory({
      resolvedShared: { 'shared-lib': '/host-b/shared.mjs' },
      shareScopeName: 'scope-b',
    }).loadEntry!({ remoteInfo: { name: 'b', entry: 'http://localhost:5001/remoteEntry.js' } });

    expect(written).toHaveLength(2);
    expect(written[0]).toContain('file:///host-a/shared.mjs');
    expect(written[1]).toContain('file:///host-b/shared.mjs');
  });
});

// ---------------------------------------------------------------------------
// Vite 8+ ModuleRunner dev-mode path
// ---------------------------------------------------------------------------

/**
 * freshLoaderWithRunner — like freshLoader but also configures vite/module-runner
 * via vi.doMock (not hoisted) so per-test ModuleRunner behaviour can be injected.
 */
async function freshLoaderWithRunner(
  runnerFactory: () => { import: (id: string) => Promise<unknown> } | null
) {
  vi.resetModules();
  vi.doMock('vite/module-runner', () => {
    const impl = runnerFactory();
    if (impl === null) throw new Error('module not found');
    // Must use regular functions (not arrow functions) so they're newable.
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ModuleRunner: vi.fn(function (this: any) {
        return impl;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ESModulesEvaluator: vi.fn(function (this: any) {
        return {};
      }),
    };
  });
  vi.doMock('path', () => ({
    default: {
      join: (...p: string[]) => p.join('/'),
      dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
    },
    join: (...p: string[]) => p.join('/'),
    dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
  }));
  vi.doMock('fs', () => ({
    default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  }));
  vi.doMock('crypto', () => {
    const hash = { update: vi.fn().mockReturnThis(), digest: vi.fn(() => 'abc123def456789') };
    return { default: { createHash: vi.fn(() => hash) }, createHash: vi.fn(() => hash) };
  });
  vi.doMock('module', () => ({
    default: { createRequire: vi.fn() },
    createRequire: vi.fn(),
  }));
  const { default: factory } = await import('../ssrEntryLoader');
  return factory;
}

describe('ssrEntryLoaderPlugin — Vite 8+ ModuleRunner dev-mode path', () => {
  it('uses ModuleRunner when URL contains /__mf_ssr__/ and vite/module-runner is available', async () => {
    const mockMod = { init: vi.fn(), get: vi.fn() };
    const mockImport = vi.fn().mockResolvedValue(mockMod);

    const factory = await freshLoaderWithRunner(() => ({ import: mockImport }));

    const fetch = makeFetchMock({
      'http://localhost:4175/mf-manifest.json': {
        ok: true,
        json: {
          metaData: {
            ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '__mf_ssr__/', type: 'module' },
          },
        },
      },
      'http://localhost:4175/__mf_ssr__/remoteEntry.ssr.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;

    const result = await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:4175/remoteEntry.js' },
    });

    expect(mockImport).toHaveBeenCalledWith('/__mf_ssr__/remoteEntry.ssr.js');
    expect(result).toBe(mockMod);
  });

  it('returns null when ModuleRunner import throws (no silent fallback)', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    vi.resetModules();
    try {
      const failingRunner = { import: vi.fn().mockRejectedValue(new Error('runner failed')) };
      vi.doMock('vite/module-runner', () => ({
        ModuleRunner: vi.fn(function (this: unknown) {
          return failingRunner;
        }),
        ESModulesEvaluator: vi.fn(function (this: unknown) {
          return {};
        }),
      }));
      vi.doMock('path', () => ({
        default: {
          join: (...p: string[]) => p.join('/'),
          dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
        },
        join: (...p: string[]) => p.join('/'),
        dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
      }));
      vi.doMock('fs', () => ({
        default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() },
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        rmSync: vi.fn(),
      }));
      vi.doMock('module', () => ({ default: { createRequire: vi.fn() }, createRequire: vi.fn() }));

      const { default: factory } = await import('../ssrEntryLoader');

      const fetch = makeFetchMock({
        'http://localhost:4175/mf-manifest.json': {
          ok: true,
          json: {
            metaData: {
              ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '__mf_ssr__/', type: 'module' },
            },
          },
        },
        'http://localhost:4175/__mf_ssr__/remoteEntry.ssr.js': {
          ok: true,
          headers: { 'content-type': 'application/javascript' },
        },
      });
      global.fetch = fetch as unknown as typeof globalThis.fetch;

      const result = await factory().loadEntry!({
        remoteInfo: { name: 'r', entry: 'http://localhost:4175/remoteEntry.js' },
      });

      expect(result).toBeUndefined();
      expectFetchNotCalled(fetch, 'http://localhost:4175/__mf_ssr__/remoteEntry.ssr.js');
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('returns undefined when vite/module-runner is unavailable (Vite < 8)', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    vi.resetModules();
    try {
      // Simulate Vite < 8 — dev-mode SSR is not supported on older Vite versions.
      vi.doMock('vite/module-runner', () => {
        throw new Error('module not found');
      });
      vi.doMock('path', () => ({
        default: {
          join: (...p: string[]) => p.join('/'),
          dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
        },
        join: (...p: string[]) => p.join('/'),
        dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
      }));
      vi.doMock('fs', () => ({
        default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() },
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        rmSync: vi.fn(),
      }));
      vi.doMock('module', () => ({ default: { createRequire: vi.fn() }, createRequire: vi.fn() }));

      const { default: factory } = await import('../ssrEntryLoader');

      const fetch = makeFetchMock({
        'http://localhost:4175/mf-manifest.json': {
          ok: true,
          json: {
            metaData: {
              ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '__mf_ssr__/', type: 'module' },
            },
          },
        },
        'http://localhost:4175/__mf_ssr__/remoteEntry.ssr.js': {
          ok: true,
          headers: { 'content-type': 'application/javascript' },
        },
      });
      global.fetch = fetch as unknown as typeof globalThis.fetch;

      const result = await factory().loadEntry!({
        remoteInfo: { name: 'r', entry: 'http://localhost:4175/remoteEntry.js' },
      });

      expect(result).toBeUndefined();
      expectFetchNotCalled(fetch, 'http://localhost:4175/__mf_ssr__/remoteEntry.ssr.js');
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('falls back to temp-file import for production preview /__mf_ssr__/ entries', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    vi.doMock('vite/module-runner', () => {
      throw new Error('module not found');
    });
    vi.doUnmock('path');
    vi.doUnmock('fs');
    vi.doUnmock('module');

    try {
      const { default: factory } = await import('../ssrEntryLoader');

      const fetch = makeFetchMock({
        'http://localhost:4175/mf-manifest.json': {
          ok: true,
          json: {
            metaData: {
              ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '__mf_ssr__/', type: 'module' },
            },
          },
        },
        'http://localhost:4175/__mf_ssr__/remoteEntry.ssr.js': {
          ok: true,
          headers: { 'content-type': 'application/javascript' },
          text: 'export async function init() {} export async function get() {}',
        },
      });
      global.fetch = fetch as unknown as typeof globalThis.fetch;

      const result = await factory().loadEntry!({
        remoteInfo: { name: 'r', entry: 'http://localhost:4175/remoteEntry.js' },
      });

      expect(typeof result?.init).toBe('function');
      expect(typeof result?.get).toBe('function');
      expectFetchCalled(fetch, 'http://localhost:4175/__mf_ssr__/remoteEntry.ssr.js');
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Revalidation — maxAgeMs and revalidate()
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — revalidation', () => {
  const entryUrl = 'http://localhost:5001/remoteEntry.js';
  const manifestUrl = 'http://localhost:5001/mf-manifest.json';
  const ssrEntryUrl = 'http://localhost:5001/remoteEntry.ssr.js';

  // The ModuleRunner describe above doUnmocks path/fs/module, which removes
  // the vi.mock registrations for every later dynamic import — re-register
  // with doMock per test here so the loader (and the fs assertions) see mocks.
  async function freshMockedLoaderModule() {
    vi.resetModules();
    vi.doMock('path', () => ({
      default: {
        join: (...p: string[]) => p.join('/'),
        dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
      },
      join: (...p: string[]) => p.join('/'),
      dirname: (p: string) => p.replace(/\/[^/]+$/, ''),
    }));
    vi.doMock('fs', () => ({
      default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() },
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      rmSync: vi.fn(),
    }));
    vi.doMock('module', () => ({
      default: { createRequire: vi.fn() },
      createRequire: vi.fn(),
    }));
    return await import('../ssrEntryLoader');
  }

  function makeManifest(buildVersion: string) {
    return {
      metaData: {
        buildInfo: { buildVersion },
        ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
      },
    };
  }

  function makeResponses(buildVersion: string, entryBody: string): Record<string, FetchEntry> {
    return {
      [manifestUrl]: { ok: true, json: makeManifest(buildVersion) },
      [ssrEntryUrl]: {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
        text: entryBody,
      },
    };
  }

  it('re-fetches the manifest when the cached resolution is older than maxAgeMs', async () => {
    const responses = makeResponses('1.0.0', 'export async function init() {}');
    const fetch = makeFetchMock(responses);
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const { default: factory } = await freshMockedLoaderModule();
    const plugin = factory({ maxAgeMs: 0 });

    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });
    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });

    const manifestFetches = fetch.mock.calls.filter(([url]) => url === manifestUrl);
    expect(manifestFetches.length).toBeGreaterThanOrEqual(2);
  });

  it('does not re-fetch the SSR entry when the manifest version is unchanged', async () => {
    const responses = makeResponses('1.0.0', 'export async function init() {}');
    global.fetch = makeFetchMock(responses) as unknown as typeof globalThis.fetch;
    const { default: factory } = await freshMockedLoaderModule();
    const fsMock = await import('fs');
    const plugin = factory({ maxAgeMs: 0 });

    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });
    const writesAfterFirst = (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.length;
    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });

    expect((fsMock.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      writesAfterFirst
    );
  });

  it('re-fetches the SSR entry when the manifest version changes', async () => {
    const responses = makeResponses('1.0.0', 'export const marker = "v1";');
    global.fetch = makeFetchMock(responses) as unknown as typeof globalThis.fetch;
    const { default: factory } = await freshMockedLoaderModule();
    const fsMock = await import('fs');
    const plugin = factory({ maxAgeMs: 0 });

    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });

    Object.assign(responses, makeResponses('2.0.0', 'export const marker = "v2";'));
    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });

    const writes = (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(String(writes[writes.length - 1][1])).toContain('v2');
  });

  it('revalidate() drops caches so the next load re-resolves', async () => {
    const responses = makeResponses('1.0.0', 'export const marker = "v1";');
    global.fetch = makeFetchMock(responses) as unknown as typeof globalThis.fetch;
    const loader = await freshMockedLoaderModule();
    const fsMock = await import('fs');
    const plugin = loader.default();

    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });

    Object.assign(responses, makeResponses('2.0.0', 'export const marker = "v2";'));
    // Without revalidation the loader would reuse its cached resolution.
    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });
    const writesBefore = (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.length;

    loader.revalidate(entryUrl);
    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });

    const writes = (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes.length).toBeGreaterThan(writesBefore);
    expect(String(writes[writes.length - 1][1])).toContain('v2');
  });

  it('revalidate() without arguments clears everything and resets runtime module caches', async () => {
    const responses = makeResponses('1.0.0', 'export const marker = "v1";');
    const fetch = makeFetchMock(responses);
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const loader = await freshMockedLoaderModule();
    const plugin = loader.default();

    await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });
    const manifestFetchesBefore = fetch.mock.calls.filter(([url]) => url === manifestUrl).length;

    const moduleCache = new Map([['remote', {}]]);
    (globalThis as Record<string, unknown>).__FEDERATION__ = {
      __INSTANCES__: [{ moduleCache }],
    };
    try {
      loader.revalidate();
      expect(moduleCache.size).toBe(0);

      await plugin.loadEntry!({ remoteInfo: { name: 'r', entry: entryUrl } });
      const manifestFetchesAfter = fetch.mock.calls.filter(([url]) => url === manifestUrl).length;
      expect(manifestFetchesAfter).toBeGreaterThan(manifestFetchesBefore);
    } finally {
      delete (globalThis as Record<string, unknown>).__FEDERATION__;
    }
  });
});
