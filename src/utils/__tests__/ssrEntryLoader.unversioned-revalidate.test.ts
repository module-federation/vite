import { readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance, type ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import ssrEntryLoaderPlugin, { revalidate } from '../ssrEntryLoader';

async function startRemote(initialMarker: string): Promise<{
  server: Server;
  entryUrl: string;
  setMarker: (marker: string) => void;
}> {
  let marker = initialMarker;
  const server = createServer((request, response) => {
    if (request.url !== '/remoteEntry.ssr.js') {
      response.statusCode = 404;
      response.end();
      return;
    }

    response.setHeader('content-type', 'application/javascript');
    response.end(`export const marker = ${JSON.stringify(marker)};`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('The test server did not expose a TCP address');
  }

  return {
    server,
    entryUrl: `http://127.0.0.1:${address.port}/remoteEntry.js`,
    setMarker(nextMarker: string) {
      marker = nextMarker;
    },
  };
}

async function startManifestRemote(initialMarker: string): Promise<{
  server: Server;
  entryUrl: string;
  setMarker: (marker: string) => void;
}> {
  let marker = initialMarker;
  const server = createServer((request, response) => {
    if (request.url === '/mf-manifest.json') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          metaData: {
            buildInfo: { buildVersion: 'v1' },
            ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
          },
        })
      );
      return;
    }
    if (request.url === '/remoteEntry.ssr.js') {
      response.setHeader('content-type', 'application/javascript');
      response.end(`export const marker = ${JSON.stringify(marker)};`);
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('The test server did not expose a TCP address');
  }

  return {
    server,
    entryUrl: `http://127.0.0.1:${address.port}/remoteEntry.js`,
    setMarker(nextMarker: string) {
      marker = nextMarker;
    },
  };
}

async function startSameOriginLazyRemotes(): Promise<{
  server: Server;
  remoteA: string;
  remoteB: string;
}> {
  const container = (name: string): Record<string, string> => ({
    [`/${name}/remoteEntry.ssr.js`]: `
      export function init() {}
      export async function get(id) {
        if (id !== './widget') throw new Error('unknown expose ' + id);
        const mod = await import('./widget.js');
        return () => mod;
      }
    `,
    [`/${name}/widget.js`]: `
      export async function loadLazy() {
        return (await import('./lazy.js')).default;
      }
    `,
    [`/${name}/lazy.js`]: `export default '${name}-lazy';`,
  });
  const files: Record<string, string> = { ...container('a'), ...container('b') };
  const server = createServer((request, response) => {
    const body = request.url ? files[request.url] : undefined;
    if (body === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/javascript');
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('The test server did not expose a TCP address');
  }

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    remoteA: `${origin}/a/remoteEntry.js`,
    remoteB: `${origin}/b/remoteEntry.js`,
  };
}

async function closeRemote(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

function getMarker(value: unknown): string {
  return (value as { marker: string }).marker;
}

function listProcessCacheFiles(): string[] {
  const cacheDir = join(process.cwd(), 'node_modules', '.ssr-cache', String(process.pid));
  return readdirSync(cacheDir)
    .filter((entry) => statSync(join(cacheDir, entry)).isFile())
    .sort();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ssrEntryLoaderPlugin — convention entry revalidation', () => {
  it('loads a fresh module after explicit revalidate()', async () => {
    const remote = await startRemote('v1');
    try {
      const plugin = ssrEntryLoaderPlugin();
      const first = await plugin.loadEntry!({
        remoteInfo: { name: 'remote', entry: remote.entryUrl },
      });

      remote.setMarker('v2');
      revalidate(remote.entryUrl);
      const second = await plugin.loadEntry!({
        remoteInfo: { name: 'remote', entry: remote.entryUrl },
      });

      expect(getMarker(first)).toBe('v1');
      expect(getMarker(second)).toBe('v2');
    } finally {
      await closeRemote(remote.server);
    }
  });

  it('cleans the previous generation after the retention window', async () => {
    const remote = await startRemote('v1');
    try {
      const plugin = ssrEntryLoaderPlugin();
      const baseline = listProcessCacheFiles();
      await plugin.loadEntry!({
        remoteInfo: { name: 'remote', entry: remote.entryUrl },
      });
      const firstGeneration = listProcessCacheFiles().filter((file) => !baseline.includes(file));

      vi.useFakeTimers();
      remote.setMarker('v2');
      revalidate(remote.entryUrl);
      await plugin.loadEntry!({
        remoteInfo: { name: 'remote', entry: remote.entryUrl },
      });
      const beforeCleanup = listProcessCacheFiles();
      expect(beforeCleanup).toEqual(expect.arrayContaining(firstGeneration));
      expect(beforeCleanup.length).toBeGreaterThan(baseline.length + firstGeneration.length);

      await vi.advanceTimersByTimeAsync(30_000);

      const afterCleanup = listProcessCacheFiles();
      expect(afterCleanup).not.toEqual(expect.arrayContaining(firstGeneration));
    } finally {
      await closeRemote(remote.server);
    }
  });

  it('does not remove a reused path after manifest revalidation', async () => {
    const remote = await startManifestRemote('v1');
    try {
      const plugin = ssrEntryLoaderPlugin();
      const baseline = listProcessCacheFiles();
      await plugin.loadEntry!({
        remoteInfo: { name: 'remote', entry: remote.entryUrl },
      });
      const generationFiles = listProcessCacheFiles().filter((file) => !baseline.includes(file));

      vi.useFakeTimers();
      remote.setMarker('v2');
      revalidate(remote.entryUrl);
      await plugin.loadEntry!({
        remoteInfo: { name: 'remote', entry: remote.entryUrl },
      });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(listProcessCacheFiles()).toEqual(expect.arrayContaining(generationFiles));
    } finally {
      await closeRemote(remote.server);
    }
  });

  it('reloads the revalidated remote and preserves another remote on the same origin', async () => {
    const remotes = await startSameOriginLazyRemotes();
    const loader = ssrEntryLoaderPlugin() as unknown as ModuleFederationRuntimePlugin;
    const loadEntry = vi.spyOn(loader, 'loadEntry');
    const federation = createInstance({
      name: `revalidate-test-${Date.now()}`,
      remotes: [
        { name: 'remote_a', entry: remotes.remoteA, type: 'module' },
        { name: 'remote_b', entry: remotes.remoteB, type: 'module' },
      ],
      plugins: [loader],
    });

    vi.useFakeTimers();
    try {
      const widgetA = (await federation.loadRemote('remote_a/widget')) as {
        loadLazy: () => Promise<string>;
      };
      const widgetB = (await federation.loadRemote('remote_b/widget')) as {
        loadLazy: () => Promise<string>;
      };

      revalidate(remotes.remoteA);
      const refreshedWidgetA = (await federation.loadRemote('remote_a/widget')) as {
        loadLazy: () => Promise<string>;
      };

      expect(loadEntry).toHaveBeenCalledTimes(3);
      expect(refreshedWidgetA).not.toBe(widgetA);

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(refreshedWidgetA.loadLazy()).resolves.toBe('a-lazy');
      await expect(widgetB.loadLazy()).resolves.toBe('b-lazy');
    } finally {
      const global = globalThis as typeof globalThis & {
        __FEDERATION__?: { __INSTANCES__?: unknown[] };
        __GLOBAL_LOADING_REMOTE_ENTRY__?: Record<string, unknown>;
      };
      if (global.__FEDERATION__?.__INSTANCES__) {
        global.__FEDERATION__.__INSTANCES__ = global.__FEDERATION__.__INSTANCES__.filter(
          (instance) => instance !== federation
        );
      }
      for (const key of Object.keys(global.__GLOBAL_LOADING_REMOTE_ENTRY__ ?? {})) {
        if (key.endsWith(`:${remotes.remoteA}`) || key.endsWith(`:${remotes.remoteB}`)) {
          delete global.__GLOBAL_LOADING_REMOTE_ENTRY__?.[key];
        }
      }
      vi.useRealTimers();
      await closeRemote(remotes.server);
    }
  });
});
