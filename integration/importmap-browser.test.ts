import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation } from '../src';
import { createBrowser, serveDirectory, type StaticServer } from './helpers/browser';
import { FIXTURES } from './helpers/build';

const sharedBase = path.resolve(
  FIXTURES,
  'importmap-browser-host',
  'vendor',
  'shared-base',
  'index.js'
);

async function buildTo(
  fixture: string,
  outDir: string,
  mfOptions: Parameters<typeof federation>[0],
  base = '/',
  alias: Record<string, string> = {}
) {
  await build({
    root: path.resolve(FIXTURES, fixture),
    base,
    logLevel: 'silent',
    resolve: { alias },
    build: { outDir, emptyOutDir: true, target: 'chrome91' },
    plugins: [federation(mfOptions)],
  });
}

describe('experiments.importMap — browser', () => {
  it('loads a remote that extends a shared class at module-eval time, without eager', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-importmap-browser-'));
    let remoteServer: StaticServer | undefined;
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      const remoteOutDir = path.join(workspace, 'remote');
      const hostOutDir = path.join(workspace, 'host');

      // The remote's publicPath must be known at build time, so serve its (empty) dir first.
      remoteServer = await serveDirectory(remoteOutDir);
      await buildTo(
        'importmap-remote',
        remoteOutDir,
        {
          name: 'importMapRemote',
          exposes: {
            './Widget': path.resolve(FIXTURES, 'importmap-remote', 'exposed-widget.js'),
          },
          shared: { 'shared-base': {} },
          experiments: { importMap: true },
        },
        `${remoteServer.origin}/`
      );

      await buildTo(
        'importmap-browser-host',
        hostOutDir,
        {
          name: 'importMapHost',
          remotes: {
            importMapRemote: `${remoteServer.origin}/importmap-manifest.json`,
          },
          shared: { 'shared-base': {} },
          experiments: { importMap: true },
        },
        '/',
        { 'shared-base': sharedBase }
      );
      hostServer = await serveDirectory(hostOutDir);

      browser = await createBrowser();
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });

      await page.goto(hostServer.origin);
      await page.waitForFunction(() => '__result' in window);
      const result = await page.evaluate(
        () => (window as unknown as { __result: unknown }).__result
      );

      expect(errors).toEqual([]);
      expect(result).toEqual({ rendered: 'widget:base', sameInstance: true });
    } finally {
      await browser?.close();
      await hostServer?.close();
      await remoteServer?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
