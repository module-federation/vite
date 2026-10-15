import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ssrEntryLoaderPlugin from '../ssrEntryLoader';

describe('ssrEntryLoaderPlugin — rebaseSharedAtRuntime', () => {
  it('pins shared imports to the copy next to the running server entry', async () => {
    // A relocated server output with its own copy of the shared package.
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'mf-ssr-output-')));
    const pkgDir = join(output, 'node_modules', 'mf-ssr-rebase-shared');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      '{"name":"mf-ssr-rebase-shared","main":"index.cjs"}'
    );
    writeFileSync(join(pkgDir, 'index.cjs'), 'module.exports = { marker: "deployed" };');
    const serverEntry = join(output, 'index.mjs');
    writeFileSync(serverEntry, '');

    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/javascript');
      response.end('export { default as shared } from "mf-ssr-rebase-shared";');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');

    const argv1 = process.argv[1];
    process.argv[1] = serverEntry;
    try {
      // Build-machine path that no longer exists after deployment, plus the
      // internal flag the plugin sets for `vite build` output.
      const options = {
        resolvedShared: { 'mf-ssr-rebase-shared': '/build/machine/node_modules/gone/index.js' },
        rebaseSharedAtRuntime: true,
      };
      const loaded = (await ssrEntryLoaderPlugin(options).loadEntry!({
        remoteInfo: {
          name: 'remote',
          entry: `http://127.0.0.1:${address.port}/remoteEntry.ssr.js`,
        },
      })) as { shared: { marker: string } } | undefined;

      expect(loaded?.shared.marker).toBe('deployed');
    } finally {
      process.argv[1] = argv1;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
