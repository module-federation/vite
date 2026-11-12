import { afterEach, describe, expect, it, vi } from 'vitest';
import ssrEntryLoaderPlugin from '../ssrEntryLoader';

afterEach(() => vi.unstubAllGlobals());

describe.runIf(process.versions.node.split('.')[0] === '24')('strict CommonJS SSR strategy', () => {
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
