import { readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
