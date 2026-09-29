import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ssrEntryLoaderPlugin from '../ssrEntryLoader';

describe('ssrEntryLoaderPlugin — resolvedShared and createRequire', () => {
  it('gives imports and createRequire the same pinned shared module', async () => {
    // A name Node cannot resolve from the temp dir, so only the pin can find it.
    const pinned = join(realpathSync(mkdtempSync(join(tmpdir(), 'mf-ssr-pinned-'))), 'shared.cjs');
    writeFileSync(pinned, 'module.exports = { marker: "pinned" };');
    // Rolldown's runtime helper next to a plain import of the same shared package.
    const entrySource = [
      'import shared from "mf-ssr-pinned-shared";',
      'import { createRequire } from "node:module";',
      'const __require = createRequire(import.meta.url);',
      'export const sameInstance = __require("mf-ssr-pinned-shared") === shared;',
      'export const resolved = __require.resolve("mf-ssr-pinned-shared");',
    ].join('\n');
    const server = createServer((request, response) => {
      if (request.url !== '/remoteEntry.ssr.js') {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/javascript');
      response.end(entrySource);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');

    try {
      const loaded = (await ssrEntryLoaderPlugin({
        resolvedShared: { 'mf-ssr-pinned-shared': pinned },
      }).loadEntry!({
        remoteInfo: {
          name: 'remote',
          entry: `http://127.0.0.1:${address.port}/remoteEntry.ssr.js`,
        },
      })) as { sameInstance: boolean; resolved: string } | undefined;

      expect(loaded?.sameInstance).toBe(true);
      expect(loaded?.resolved).toBe(pinned);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
