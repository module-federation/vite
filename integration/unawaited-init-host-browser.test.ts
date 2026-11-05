import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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

// The remote ships no copy of the shared package: the host must provide it.
const remoteOptions = {
  name: 'sharedRemote',
  filename: 'remoteEntry.js',
  exposes: {
    './Module': path.resolve(FIXTURES, 'shared-remote', 'exposed-module.js'),
  },
  shared: {
    'mock-shared-dep': { import: false, requiredVersion: false },
  },
  dts: false,
} satisfies Parameters<typeof federation>[0];

// A host that hands the container a share scope whose providers resolve
// asynchronously, calls init() twice without awaiting it, then immediately calls get().
function hostPage(remoteEntry: string, awaitInit: boolean) {
  return `<!doctype html>
<script type="module">
  try {
  const container = await import(${JSON.stringify(remoteEntry)});
  const provided = { init: 'from-host', value1: 'h1', value2: 'h2', value3: 'h3' };
  const scope = {
    'mock-shared-dep': {
      '1.0.0': {
        from: 'host',
        get: () => new Promise((resolve) => setTimeout(() => resolve(() => provided), 50)),
      },
    },
  };
  ${awaitInit ? 'await container.init(scope);' : 'container.init(scope);\n  container.init(scope);'}
  const factory = await container.get('./Module');
  window.__result = factory().parserReady;
  } catch (error) {
    window.__error = String((error && error.message) || error);
  }
</script>`;
}

describe('container get() with a host that does not await init()', () => {
  it.each([
    ['does not await init()', false],
    ['awaits init()', true],
  ])(
    'evaluates the expose with the host share when the host %s',
    async (_label, awaitInit) => {
      const workspace = await mkdtemp(path.join(tmpdir(), 'mf-unawaited-init-'));
      let remoteServer: StaticServer | undefined;
      let hostServer: StaticServer | undefined;
      let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

      try {
        const remoteOutDir = path.join(workspace, 'remote');
        const hostDir = path.join(workspace, 'host');
        await buildFixtureTo('shared-remote', remoteOutDir, remoteOptions);
        remoteServer = await serveDirectory(remoteOutDir);
        await mkdir(hostDir, { recursive: true });
        await writeFile(
          path.join(hostDir, 'index.html'),
          hostPage(`${remoteServer.origin}/remoteEntry.js`, awaitInit)
        );
        hostServer = await serveDirectory(hostDir);

        browser = await createBrowser();
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));

        await page.goto(hostServer.origin);
        await page.waitForFunction(() => '__result' in window || '__error' in window, null, {
          timeout: 15_000,
        });

        expect(await page.evaluate(() => (window as any).__error)).toBeUndefined();
        expect(pageErrors).toEqual([]);
        expect(await page.evaluate(() => (window as any).__result)).toBe('from-host');
      } finally {
        await browser?.close();
        await hostServer?.close();
        await remoteServer?.close();
        await rm(workspace, { recursive: true, force: true });
      }
    },
    60_000
  );
});
