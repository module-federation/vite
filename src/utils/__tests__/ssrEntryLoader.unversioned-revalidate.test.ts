import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
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

async function closeRemote(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

function getMarker(value: unknown): string {
  return (value as { marker: string }).marker;
}

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
});
