import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { federation } from '../src';
import { buildFixtureTo, createBrowser, serveDirectory } from './helpers/browser';

interface PreloadResult {
  url: string;
  resourceType: string;
  status: string;
}

interface TestWindow extends Window {
  preloadNested(): Promise<{ matchedVersion: string; results: PreloadResult[] }>;
  loadWidget(): Promise<void>;
}

it.each(['build', 'serve'] as const)(
  'loads and preloads nested manifest remotes in the browser (%s)',
  async (command) => {
    const workspace = await mkdtemp(path.join(import.meta.dirname, '.manifest-remotes-'));
    const closeServers: Array<() => Promise<void>> = [];
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    async function startApp(
      options: Parameters<typeof federation>[0],
      files: Record<string, string>
    ) {
      const root = path.join(workspace, options.name);
      await mkdir(root);
      await Promise.all(
        Object.entries({ 'index.html': '<!doctype html>', ...files }).map(([name, source]) =>
          writeFile(path.join(root, name), source)
        )
      );

      const mfOptions = { manifest: true, filename: 'remoteEntry.js', dts: false, ...options };
      if (command === 'build') {
        const outDir = path.join(root, 'dist');
        await buildFixtureTo(root, outDir, mfOptions);
        const server = await serveDirectory(outDir);
        closeServers.push(server.close);
        return server.origin;
      }

      const server = await createServer({
        root,
        plugins: [federation(mfOptions)],
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0, cors: true, ws: false },
      });
      closeServers.push(() => server.close());
      await server.listen();
      return server.resolvedUrls!.local[0].replace(/\/$/, '');
    }

    try {
      const nestedOrigin = await startApp(
        { name: 'nested', exposes: { './Value': './value.js' } },
        { 'value.js': 'export const value = "nested value";' }
      );
      const nestedEntry = `${nestedOrigin}/mf-manifest.json`;
      const nested = { name: 'nested', type: 'module', entry: nestedEntry };
      const remoteOrigin = await startApp(
        { name: 'middle', exposes: { './Widget': './widget.js' }, remotes: { nested } },
        {
          'index.html': '<script type="module" src="/widget.js"></script>',
          'widget.js': 'export { value } from "nested/Value";',
        }
      );
      const remoteEntry = `${remoteOrigin}/mf-manifest.json`;
      const middle = { name: 'middle', type: 'module', entry: remoteEntry };
      const hostOrigin = await startApp(
        { name: 'manifestHost', remotes: { middle }, shareStrategy: 'loaded-first' },
        {
          'index.html': '<div id="result"></div><script type="module" src="/app.js"></script>',
          'app.js': `
            import { createInstance } from '@module-federation/runtime';

            let matchedVersion;
            let preloadResults;
            const runtime = createInstance({
              name: 'manifestPreloadHost',
              remotes: ${JSON.stringify([middle, nested])},
              plugins: [{
                name: 'record-preload',
                afterLoadSnapshot({ moduleInfo, remoteSnapshot }) {
                  if (moduleInfo.name === 'middle') {
                    matchedVersion = remoteSnapshot.remotesInfo?.nested?.matchedVersion;
                  }
                },
                afterPreloadRemote({ results }) { preloadResults = results; },
              }],
            });

            window.preloadNested = async () => {
              // Traversal uses cached snapshots. Prime the nested snapshot without
              // preloading the exposed module's assets.
              await runtime.preloadRemote([{ nameOrAlias: 'nested', exposes: ['unused'] }]);
              await runtime.preloadRemote([{ nameOrAlias: 'middle', depsRemote: true }]);
              return { matchedVersion, results: preloadResults.flatMap(({ results }) => results) };
            };

            window.loadWidget = async () => {
              // Keep the namespace so Vite 5/6 don't destructure before federation resolves the remote.
              const widget = await import('middle/Widget');
              document.querySelector('#result').textContent = widget.value;
            };
          `,
        }
      );

      browser = await createBrowser();
      const page = await browser.newPage();
      await page.goto(hostOrigin);
      await page.waitForFunction(() => 'preloadNested' in window);
      const { matchedVersion, results } = await page.evaluate(() =>
        (window as TestWindow).preloadNested()
      );
      await page.evaluate(() => (window as TestWindow).loadWidget());
      expect(await page.locator('#result').textContent()).toBe('nested value');
      expect(matchedVersion).toBe(nestedEntry);
      expect(results.filter(({ url }) => new URL(url).origin === nestedOrigin)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceType: 'js',
            status: 'success',
          }),
        ])
      );
    } finally {
      await browser?.close();
      await Promise.all(closeServers.map((close) => close()));
      await rm(workspace, { recursive: true, force: true });
    }
  },
  45_000
);
