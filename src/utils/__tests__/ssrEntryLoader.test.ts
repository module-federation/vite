/**
 * ssrEntryLoader tests.
 *
 * ssrEntryLoader has module-level caches (manifestCache, tempFileCache).
 * We use vi.resetModules() + dynamic import in each test to get a fresh
 * module instance with empty caches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchEntry = {
  ok: boolean;
  text?: string;
  json?: unknown;
  headers?: Record<string, string>;
};

function makeFetchMock(responses: Record<string, FetchEntry>) {
  return vi.fn(async (url: string, _options?: { method?: string }) => {
    const entry = responses[url] ?? { ok: false };
    return {
      ok: entry.ok,
      status: entry.ok ? 200 : 404,
      text: async () => entry.text ?? '',
      json: async () => entry.json ?? {},
      headers: { get: (h: string) => entry.headers?.[h] ?? null },
    };
  });
}

async function freshLoader() {
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
  const { default: factory } = await import('../ssrEntryLoader');
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
  it('returns undefined when window is defined', async () => {
    (globalThis as Record<string, unknown>).window = {};
    const factory = await freshLoader();
    const result = await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(result).toBeUndefined();
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
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': { ok: false },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    expect(fetch).toHaveBeenCalledWith('http://localhost:5001/mf-manifest.json');
  });
});

// ---------------------------------------------------------------------------
// URL convention fallback
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — URL convention fallback', () => {
  it('tries .server.cjs before .server.js', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.server.cjs': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;
    const moduleMock = await import('module');
    (moduleMock.createRequire as ReturnType<typeof vi.fn>).mockReturnValue(
      vi.fn().mockReturnValue({ init: vi.fn(), get: vi.fn() })
    );
    const factory = await freshLoader();
    await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:5001/remoteEntry.js' },
    });
    const heads = fetch.mock.calls.filter((c) => c[1]?.method === 'HEAD');
    expect(heads[0][0]).toBe('http://localhost:5001/remoteEntry.server.cjs');
  });

  it('falls back to .server.js when .server.cjs is absent', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': {
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
    expect(heads.some((c) => c[0] === 'http://localhost:5001/remoteEntry.server.js')).toBe(true);
  });

  it('rejects HTML fallback responses', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.server.cjs': {
        ok: true,
        headers: { 'content-type': 'text/html' },
      },
      'http://localhost:5001/remoteEntry.server.js': {
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
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': { ok: false },
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
// Manifest SSR entry resolution
// ---------------------------------------------------------------------------

describe('ssrEntryLoaderPlugin — manifest SSR entry resolution', () => {
  it('uses ssrRemoteEntry from manifest without convention HEAD requests', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: {
          metaData: { ssrRemoteEntry: { name: 'remoteEntry.server.js', path: '', type: 'module' } },
        },
      },
      'http://localhost:5001/remoteEntry.server.js': {
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
    expect(heads.length).toBe(0);
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
            ssrRemoteEntry: { name: 'remoteEntry.server.js', path: 'dist/', type: 'module' },
          },
        },
      },
      'http://localhost:5001/dist/remoteEntry.server.js': {
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
      (c) => c[0] === 'http://localhost:5001/dist/remoteEntry.server.js' && !c[1]?.method
    );
    expect(getCall).toBeDefined();
  });

  it('falls back to convention when manifest has no ssrRemoteEntry field', async () => {
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': {
        ok: true,
        json: { metaData: { remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' } } },
      },
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': { ok: false },
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
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': { ok: false },
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
  it('fetches transitive relative imports', async () => {
    const fsMock = await import('fs');
    (fsMock.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (fsMock.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const fetch = makeFetchMock({
      'http://localhost:5001/mf-manifest.json': { ok: false },
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': {
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
    expect(fetch).toHaveBeenCalledWith('http://localhost:5001/assets/helper.js');
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
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': {
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
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': {
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
      'http://localhost:5001/remoteEntry.server.cjs': { ok: false },
      'http://localhost:5001/remoteEntry.server.js': {
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
      'http://localhost:4175/mf-manifest.json': { ok: false },
      'http://localhost:4175/remoteEntry.server.cjs': { ok: false },
      'http://localhost:4175/__mf_ssr__/remoteEntry.server.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;

    const result = await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:4175/remoteEntry.js' },
    });

    expect(mockImport).toHaveBeenCalledWith('/__mf_ssr__/remoteEntry.server.js');
    expect(result).toBe(mockMod);
  });

  it('returns null when ModuleRunner import throws (no silent fallback)', async () => {
    vi.resetModules();
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
      'http://localhost:4175/mf-manifest.json': { ok: false },
      'http://localhost:4175/remoteEntry.server.cjs': { ok: false },
      'http://localhost:4175/__mf_ssr__/remoteEntry.server.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;

    const result = await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:4175/remoteEntry.js' },
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when vite/module-runner is unavailable (Vite < 8)', async () => {
    vi.resetModules();
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
      'http://localhost:4175/mf-manifest.json': { ok: false },
      'http://localhost:4175/remoteEntry.server.cjs': { ok: false },
      'http://localhost:4175/__mf_ssr__/remoteEntry.server.js': {
        ok: true,
        headers: { 'content-type': 'application/javascript' },
      },
    });
    global.fetch = fetch as unknown as typeof globalThis.fetch;

    const result = await factory().loadEntry!({
      remoteInfo: { name: 'r', entry: 'http://localhost:4175/remoteEntry.js' },
    });

    expect(result).toBeUndefined();
  });
});
