import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  buildFixtureTo,
  createBrowser,
  serveDirectory,
  type StaticServer,
} from './helpers/browser';
import { FIXTURES } from './helpers/build';

// The host provides a singleton version outside the remote's requiredVersion.
const hostPage = (remoteEntry: string) => `<!doctype html>
<script type="module">
  try {
    const container = await import(${JSON.stringify(remoteEntry)});
    await container.init({
      'mock-shared-dep': {
        '2.0.0': { from: 'host', get: () => () => ({}), shareConfig: { singleton: true } },
      },
    });
    await container.get('./Expose');
    window.__result = 'loaded';
  } catch (error) {
    window.__error = String((error && error.message) || error);
  }
</script>`;

it.each([
  ['does not import it', 'entry.js'],
  ['imports it', 'exposed-module.js'],
])(
  'warns once about an unsatisfied singleton version when the expose %s',
  async (_label, file) => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-singleton-warning-'));
    let remoteServer: StaticServer | undefined;
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;
    try {
      const remoteOutDir = path.join(workspace, 'remote');
      const hostDir = path.join(workspace, 'host');
      await buildFixtureTo('shared-remote', remoteOutDir, {
        name: 'sharedRemote',
        filename: 'remoteEntry.js',
        exposes: { './Expose': path.resolve(FIXTURES, 'shared-remote', file) },
        shared: { 'mock-shared-dep': { singleton: true, requiredVersion: '^1.0.0' } },
        dts: false,
      });
      remoteServer = await serveDirectory(remoteOutDir);
      await mkdir(hostDir, { recursive: true });
      await writeFile(
        path.join(hostDir, 'index.html'),
        hostPage(`${remoteServer.origin}/remoteEntry.js`)
      );
      hostServer = await serveDirectory(hostDir);

      browser = await createBrowser();
      const page = await browser.newPage();
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.text().includes('does not satisfy')) warnings.push(message.text());
      });
      await page.goto(hostServer.origin);
      await page.waitForFunction(() => '__result' in window || '__error' in window, null, {
        timeout: 15_000,
      });

      expect(await page.evaluate(() => (window as any).__error)).toBeUndefined();
      expect(await page.evaluate(() => (window as any).__result)).toBe('loaded');
      expect(warnings).toHaveLength(1);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await remoteServer?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  60_000
);
