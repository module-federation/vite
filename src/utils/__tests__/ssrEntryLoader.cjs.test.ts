import { afterEach, describe, expect, it, vi } from 'vitest';
import ssrEntryLoaderPlugin from '../ssrEntryLoader';

afterEach(() => vi.unstubAllGlobals());

describe.runIf(process.versions.node.split('.')[0] === '24')('strict CommonJS SSR strategy', () => {
  it('creates HTTP work outside graph context and evaluates the remote inside it', async () => {
    const contextKey = Symbol.for('module-federation.vite.ssr-build-context');
    const currentGraph = () => (globalThis as any)[contextKey]?.getStore();
    const transportContexts: unknown[] = [];
    const timeoutContexts: unknown[] = [];
    const timeout = AbortSignal.timeout;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      timeoutContexts.push(currentGraph());
      return timeout.call(AbortSignal, milliseconds);
    });
    const source = new TextEncoder().encode(`
      const evaluatedInsideGraph = Boolean(globalThis[Symbol.for('module-federation.vite.ssr-build-context')]?.getStore());
      const hasGraph = () => Boolean(globalThis[Symbol.for('module-federation.vite.ssr-build-context')]?.getStore());
      module.exports = {
        init: hasGraph,
        get() {
          const getInsideGraph = hasGraph();
          return () => ({ evaluatedInsideGraph, getInsideGraph, factoryInsideGraph: hasGraph() });
        }
      };
    `);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        transportContexts.push(currentGraph());
        let complete = false;
        return {
          ok: true,
          headers: new Headers(),
          body: {
            getReader() {
              transportContexts.push(currentGraph());
              return {
                async read() {
                  transportContexts.push(currentGraph());
                  if (complete) return { done: true };
                  complete = true;
                  return { done: false, value: source };
                },
              };
            },
          },
        };
      })
    );
    try {
      const container = await ssrEntryLoaderPlugin({ strategy: 'cjs' }).loadEntry({
        remoteInfo: {
          name: 'cjs-transport-context',
          entry: 'https://remote.test/context.cjs',
          type: 'commonjs-module',
        },
      });
      expect(timeoutContexts).toEqual([undefined]);
      expect(transportContexts).toEqual([undefined, undefined, undefined, undefined]);
      expect((container?.init as Function)()).toBe(true);
      expect((container?.get as Function)()()).toEqual({
        evaluatedInsideGraph: true,
        getInsideGraph: true,
        factoryInsideGraph: true,
      });
      expect(currentGraph()).toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('loads an explicitly typed HTTP companion with an arbitrary filename', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('module.exports = { init() {}, get: () => () => ({ marker: "cjs" }) };')
      )
    );
    const loader = ssrEntryLoaderPlugin({ strategy: 'cjs' });
    const container = await loader.loadEntry({
      remoteInfo: {
        name: 'cjs-direct',
        entry: 'https://remote.test/server/custom.cjs',
        type: 'commonjs-module',
      },
    });
    expect((container?.get as Function)()().marker).toBe('cjs');
  });

  it('preserves response-body limits while leaving transport outside the graph', async () => {
    const contexts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        contexts.push(
          (globalThis as any)[Symbol.for('module-federation.vite.ssr-build-context')]?.getStore()
        );
        return new Response('module.exports = { init() {}, get() {} };');
      })
    );
    await expect(
      ssrEntryLoaderPlugin({ strategy: 'cjs', fetchMaxBytes: 1 }).loadEntry({
        remoteInfo: {
          name: 'cjs-large-body',
          entry: 'https://remote.test/large.cjs',
          type: 'commonjs-module',
        },
      })
    ).rejects.toThrow(/exceeded the 1-byte limit/);
    expect(contexts).toEqual([undefined]);
  });

  it('rejects an ESM entry without falling back', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const loader = ssrEntryLoaderPlugin({ strategy: 'cjs' });
    await expect(
      loader.loadEntry({
        remoteInfo: { name: 'esm-only', entry: 'https://remote.test/entry.ssr.js', type: 'module' },
      })
    ).rejects.toThrow(/requires a manifest advertising a CommonJS SSR companion/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects missing companions instead of delegating to the native loader', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    );
    const loader = ssrEntryLoaderPlugin({ strategy: 'cjs' });
    await expect(
      loader.loadEntry({
        remoteInfo: {
          name: 'missing-cjs',
          entry: 'https://missing.test/mf-manifest.json',
          type: 'module',
        },
      })
    ).rejects.toThrow(/requires an advertised CommonJS SSR companion/);
  });

  it('propagates evaluation errors and HTTP status failures', async () => {
    const fetch = vi.fn(async () => new Response('throw Error("broken release")'));
    vi.stubGlobal('fetch', fetch);
    const loader = ssrEntryLoaderPlugin({ strategy: 'cjs' });
    const remoteInfo = {
      name: 'broken-cjs',
      entry: 'https://broken.test/entry.cjs',
      type: 'commonjs-module',
    };
    await expect(loader.loadEntry({ remoteInfo })).rejects.toThrow('broken release');
    fetch.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    await expect(loader.loadEntry({ remoteInfo })).rejects.toThrow(/503/);
  });
});

it('rejects an unvalidated Node major before fetching or evaluating a CJS remote', async () => {
  const process22 = Object.create(process);
  Object.defineProperty(process22, 'versions', { value: { ...process.versions, node: '22.23.5' } });
  vi.stubGlobal('process', process22);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    ssrEntryLoaderPlugin({ strategy: 'cjs' }).loadEntry({
      remoteInfo: {
        name: 'unsupported-node',
        entry: 'https://remote.test/entry.cjs',
        type: 'commonjs-module',
      },
    })
  ).rejects.toThrow(/supports Node 24.*Node 22 failed the ordinary-GC memory bound/);
  expect(fetch).not.toHaveBeenCalled();
});
