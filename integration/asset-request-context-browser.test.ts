import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { federation } from '../src';
import {
  buildFixtureTo,
  createBrowser,
  serveDirectory,
  type StaticServer,
} from './helpers/browser';
import { FIXTURES } from './helpers/build';

const TOKEN = 'Bearer secret-token';

const remoteOptions = {
  name: 'remoteApp',
  filename: 'remoteEntry.js',
  manifest: true,
  exposes: {
    './Widget': path.resolve(FIXTURES, 'asset-request-context-remote', 'widget.js'),
  },
  dts: false,
} satisfies Parameters<typeof federation>[0];

function hostOptions(remoteEntry: string, withAssetRequestContext = true) {
  return {
    name: 'hostApp',
    filename: 'remoteEntry.js',
    remotes: {
      remote1: { name: 'remote1', entry: remoteEntry, type: 'module' },
    },
    // The host's own plugin requests the manifest and entry through its context
    // and hands the context to the remote.
    runtimePlugins: withAssetRequestContext
      ? [path.resolve(FIXTURES, 'asset-request-context-host', 'authPlugin.js')]
      : [],
    dts: false,
  } satisfies Parameters<typeof federation>[0];
}

describe('assetRequestContext in the browser', () => {
  it.each(['remoteEntry.js', 'mf-manifest.json'])(
    'loads an authenticated remote from %s: every file is served with the header',
    async (hostEntry) => {
      const workspace = await mkdtemp(path.join(tmpdir(), 'mf-asset-request-context-browser-'));
      let remoteServer: StaticServer | undefined;
      let hostServer: StaticServer | undefined;
      let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

      try {
        const remoteOutDir = path.join(workspace, 'remote');
        const hostOutDir = path.join(workspace, 'host');
        await buildFixtureTo('asset-request-context-remote', remoteOutDir, remoteOptions);
        remoteServer = await serveDirectory(remoteOutDir, { authorization: TOKEN });
        await buildFixtureTo(
          'asset-request-context-host',
          hostOutDir,
          hostOptions(`${remoteServer.origin}/${hostEntry}`)
        );
        hostServer = await serveDirectory(hostOutDir);

        browser = await createBrowser();
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });

        await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
        try {
          await page.waitForFunction(
            () => document.querySelector('#app')?.textContent === 'widget loaded lazily',
            undefined,
            { timeout: 15_000 }
          );
        } catch (error) {
          throw new Error(
            JSON.stringify(
              {
                cause: String(error),
                pageErrors,
                consoleErrors,
                requests: remoteServer.requests,
                content: await page.content(),
              },
              null,
              2
            )
          );
        }

        const color = await page.evaluate(
          () => getComputedStyle(document.querySelector('#app')!).color
        );
        expect(color).toBe('rgb(255, 0, 0)');

        const served = remoteServer.requests.filter((request) => request.status === 200);
        expect(served.map((request) => request.path)).toEqual(
          expect.arrayContaining([
            ...(hostEntry === 'mf-manifest.json' ? ['/mf-manifest.json'] : []),
            '/remoteEntry.js',
            expect.stringMatching(/^\/assets\/widget-.*\.js$/),
            expect.stringMatching(/^\/assets\/lazy-.*\.js$/),
            expect.stringMatching(/^\/assets\/.*\.css$/),
          ])
        );
        // Native preload hints cannot carry the header: the host's HTML preload of
        // the remote entry, Vite's preload <link> for the expose's CSS, and, for a
        // manifest remote, the runtime's <link> preloads of the assets the manifest
        // lists. Their 401s are ignored, and every one of those files is loaded
        // through assetRequestContext.request as well.
        const servedPaths = new Set(served.map((request) => request.path));
        const rejected = remoteServer.requests.filter((request) => request.status !== 200);
        for (const request of rejected) {
          expect(request.authorization).toBeUndefined();
          expect(servedPaths.has(request.path)).toBe(true);
        }
        expect(served.every((request) => request.authorization === TOKEN)).toBe(true);
        expect(pageErrors).toEqual([]);
      } finally {
        await browser?.close();
        await hostServer?.close();
        await remoteServer?.close();
        await rm(workspace, { recursive: true, force: true });
      }
    },
    60_000
  );

  it('cannot load the same remote without assetRequestContext', async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), 'mf-asset-request-context-browser-control-')
    );
    let remoteServer: StaticServer | undefined;
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      const remoteOutDir = path.join(workspace, 'remote');
      const hostOutDir = path.join(workspace, 'host');
      await buildFixtureTo('asset-request-context-remote', remoteOutDir, remoteOptions);
      remoteServer = await serveDirectory(remoteOutDir, { authorization: TOKEN });
      await buildFixtureTo(
        'asset-request-context-host',
        hostOutDir,
        hostOptions(`${remoteServer.origin}/remoteEntry.js`, false)
      );
      hostServer = await serveDirectory(hostOutDir);

      browser = await createBrowser();
      const page = await browser.newPage();
      await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1_000);

      expect(await page.locator('#app').textContent()).toBe('');
      expect(remoteServer.requests.length).toBeGreaterThan(0);
      expect(remoteServer.requests.every((request) => request.status === 401)).toBe(true);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await remoteServer?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
