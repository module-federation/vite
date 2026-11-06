import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import {
  buildFixtureTo,
  createBrowser,
  serveDirectory,
  type StaticServer,
} from './helpers/browser';
import { FIXTURES } from './helpers/build';

describe('Vue version-first production hydration', () => {
  it.each(['html', 'entry'] as const)(
    'hydrates shared Vue and vue-router with a configured remote (%s injection)',
    async (hostInitInjectLocation) => {
      const previousCwd = getPackageDetectionCwd();
      const workspace = await mkdtemp(path.join(tmpdir(), 'mf-vue-hydration-'));
      const servers: StaticServer[] = [];
      let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;
      try {
        const remoteOutDir = path.join(workspace, 'remote-dist');
        await buildFixtureTo('vue-hydration-remote', remoteOutDir, {
          name: 'demoRemote',
          filename: 'remoteEntry.js',
          exposes: { './Module': path.join(FIXTURES, 'vue-hydration-remote/exposed-module.js') },
          dts: false,
        });
        const remoteServer = await serveDirectory(remoteOutDir);
        servers.push(remoteServer);
        const hostRoot = path.join(workspace, 'host-src');
        await cp(path.join(FIXTURES, 'vue-hydration-host'), hostRoot, { recursive: true });
        await symlink(
          path.resolve('examples/vite-vite/vite-host/node_modules'),
          path.join(hostRoot, 'node_modules'),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
        const hostOutDir = path.join(workspace, 'host-dist');
        await buildFixtureTo(hostRoot, hostOutDir, {
          name: 'demoHost',
          remotes: {
            remote: {
              name: 'demoRemote',
              type: 'module',
              entry: `${remoteServer.origin}/remoteEntry.js`,
            },
          },
          shareStrategy: 'version-first',
          hostInitInjectLocation,
          shared: {
            vue: { singleton: true, requiredVersion: '^3.5.0' },
            'vue-router': { singleton: true, requiredVersion: '^4.0.0' },
          },
          dts: false,
        });
        const hostServer = await serveDirectory(hostOutDir);
        servers.push(hostServer);
        browser = await createBrowser();
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.stack || error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(hostServer.origin);
        try {
          await page.waitForFunction(() => (window as any).__hydrationProbe, undefined, {
            timeout: 5_000,
          });
        } catch (error) {
          throw new Error(
            JSON.stringify({ cause: String(error), errors, content: await page.content() }, null, 2)
          );
        }
        expect(await page.evaluate(() => (window as any).__hydrationProbe)).toEqual({
          reused: true,
        });
        await page.locator('button').click();
        await expect.poll(() => page.locator('button').textContent()).toBe('count: 1');
        await page.locator('a').click();
        await expect.poll(() => page.locator('p').textContent()).toBe('about page');
        expect(errors).toEqual([]);
      } finally {
        await browser?.close();
        for (const server of servers.reverse()) await server.close();
        await rm(workspace, { recursive: true, force: true });
        setPackageDetectionCwd(previousCwd);
      }
    },
    60_000
  );
});
