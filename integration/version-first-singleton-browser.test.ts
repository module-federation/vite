import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { federation } from '../src';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import {
  buildFixtureTo,
  createBrowser,
  serveDirectory,
  type StaticServer,
} from './helpers/browser';
import { FIXTURES } from './helpers/build';

const remoteOptions = {
  name: 'remoteApp',
  filename: 'remoteEntry.js',
  exposes: {
    './Module': path.resolve(FIXTURES, 'version-first-singleton-remote', 'exposed-module.js'),
  },
  shareStrategy: 'version-first',
  shared: {
    'shared-lib': { singleton: true },
  },
  dts: false,
} satisfies Parameters<typeof federation>[0];

function hostOptions(remoteEntry: string) {
  return {
    name: 'hostApp',
    filename: 'remoteEntry.js',
    remotes: {
      remote1: {
        name: 'remote1',
        entry: remoteEntry,
        type: 'module',
      },
    },
    shareStrategy: 'version-first',
    shared: {
      'shared-lib': { singleton: true },
    },
    hostInitInjectLocation: 'html',
    dts: false,
  } satisfies Parameters<typeof federation>[0];
}

async function readNegotiatedSharedVersions(
  sharedImports: { host?: string; remote?: string } = {}
) {
  const originalPackageDetectionCwd = getPackageDetectionCwd();
  const workspace = await mkdtemp(path.join(tmpdir(), 'mf-version-first-singleton-browser-'));
  let remoteServer: StaticServer | undefined;
  let hostServer: StaticServer | undefined;
  let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

  try {
    const remoteOutDir = path.join(workspace, 'remote');
    const hostOutDir = path.join(workspace, 'host');
    // The remote provides 1.5.0 and the host provides 1.0.0.
    await buildFixtureTo('version-first-singleton-remote', remoteOutDir, {
      ...remoteOptions,
      shared: {
        'shared-lib': { singleton: true, import: sharedImports.remote },
      },
    });
    remoteServer = await serveDirectory(remoteOutDir);
    await buildFixtureTo('version-first-singleton-host', hostOutDir, {
      ...hostOptions(`${remoteServer.origin}/remoteEntry.js`),
      shared: {
        'shared-lib': { singleton: true, import: sharedImports.host },
      },
    });
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
        () => document.querySelector('#app')?.textContent?.startsWith('host:'),
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
            content: await page.content(),
          },
          null,
          2
        )
      );
    }

    const [hostSaw, remoteSaw] = await Promise.all([
      page.evaluate(() => (window as any).__host_saw_version__),
      page.evaluate(() => (window as any).__remote_saw_version__),
    ]);
    return { hostSaw, remoteSaw, pageErrors, consoleErrors };
  } finally {
    await browser?.close();
    await hostServer?.close();
    await remoteServer?.close();
    await rm(workspace, { recursive: true, force: true });
    setPackageDetectionCwd(originalPackageDetectionCwd);
  }
}

describe('version-first singleton static import browser bootstrap', () => {
  it('registers nested-prefix providers and selects the higher host version', async () => {
    const previousCwd = getPackageDetectionCwd();
    const workspace = await mkdtemp(path.resolve('node_modules/.nested-prefix-'));
    let remoteServer: StaticServer | undefined;
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      for (const [side, version] of [
        ['host', '2.0.0'],
        ['remote', '1.0.0'],
      ]) {
        const root = path.join(workspace, side);
        const packageDir = path.join(root, 'node_modules/audit-lib');
        await mkdir(path.join(packageDir, 'features'), { recursive: true });
        await writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: side, type: 'module' })
        );
        await writeFile(
          path.join(root, 'index.html'),
          '<script type="module" src="/main.js"></script>'
        );
        await writeFile(
          path.join(packageDir, 'package.json'),
          JSON.stringify({ name: 'audit-lib', version, type: 'module' })
        );
        await writeFile(
          path.join(packageDir, 'features/button.js'),
          `export const version = '${version}';`
        );
      }
      await writeFile(
        path.join(workspace, 'remote/main.js'),
        'export { version as remoteVersion } from "audit-lib/features/button.js";'
      );
      await writeFile(
        path.join(workspace, 'host/main.js'),
        `import { version } from 'audit-lib/features/button.js';
         import { remoteVersion } from 'remote/Module';
         window.__prefixVersions = { host: version, remote: remoteVersion };`
      );

      const shared = { 'audit-lib/features/': { singleton: true, requiredVersion: '*' } };
      const remoteOutDir = path.join(workspace, 'remote-dist');
      const hostOutDir = path.join(workspace, 'host-dist');
      await buildFixtureTo(path.join(workspace, 'remote'), remoteOutDir, {
        name: 'a_prefix_remote',
        filename: 'remoteEntry.js',
        shareStrategy: 'version-first',
        shared,
        exposes: { './Module': path.join(workspace, 'remote/main.js') },
        dts: false,
      });
      remoteServer = await serveDirectory(remoteOutDir);
      await buildFixtureTo(path.join(workspace, 'host'), hostOutDir, {
        name: 'z_prefix_host',
        shareStrategy: 'version-first',
        shared,
        remotes: {
          remote: {
            type: 'module',
            name: 'a_prefix_remote',
            entry: `${remoteServer.origin}/remoteEntry.js`,
          },
        },
        dts: false,
      });
      hostServer = await serveDirectory(hostOutDir);
      browser = await createBrowser();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(hostServer.origin);
      await page.waitForFunction(() => (window as any).__prefixVersions !== undefined);
      expect(await page.evaluate(() => (window as any).__prefixVersions)).toEqual({
        host: '2.0.0',
        remote: '2.0.0',
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await remoteServer?.close();
      await rm(workspace, { recursive: true, force: true });
      setPackageDetectionCwd(previousCwd);
    }
  }, 60_000);

  it('resolves both host and remote static imports to the higher negotiated version', async () => {
    expect(await readNegotiatedSharedVersions({})).toEqual({
      hostSaw: '1.5.0',
      remoteSaw: '1.5.0',
      pageErrors: [],
      consoleErrors: [],
    });
  }, 60_000);

  it('preserves singleton negotiation when comments separate export tokens', async () => {
    const result = await readNegotiatedSharedVersions({
      host: path.resolve(FIXTURES, 'version-first-singleton-host/commented-shared.js'),
      remote: path.resolve(FIXTURES, 'version-first-singleton-remote/commented-shared.js'),
    });

    expect(result).toEqual({
      hostSaw: '1.5.0',
      remoteSaw: '1.5.0',
      pageErrors: [],
      consoleErrors: [],
    });
  }, 60_000);

  it('keeps eager React fallbacks coherent across patch versions', async () => {
    const originalPackageDetectionCwd = getPackageDetectionCwd();
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-react-skew-browser-'));
    let remoteServer: StaticServer | undefined;
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      const remoteOutDir = path.join(workspace, 'remote');
      const hostOutDir = path.join(workspace, 'host');
      await buildFixtureTo('react-skew-remote', remoteOutDir, {
        name: 'reactSkewRemote',
        filename: 'remoteEntry.js',
        exposes: {
          './Module': path.resolve(FIXTURES, 'react-skew-remote', 'exposed-module.js'),
        },
        shareStrategy: 'version-first',
        shared: {
          react: { singleton: true, requiredVersion: '^19.2.4' },
          'react-dom/client': { singleton: true, requiredVersion: '^19.2.4' },
        },
        hostInitInjectLocation: 'entry',
        dts: false,
      });
      remoteServer = await serveDirectory(remoteOutDir);

      await buildFixtureTo('react-skew-host', hostOutDir, {
        name: 'reactSkewHost',
        filename: 'remoteEntry.js',
        remotes: {
          remote: {
            name: 'remote',
            entry: `${remoteServer.origin}/remoteEntry.js`,
            type: 'module',
          },
        },
        shareStrategy: 'version-first',
        shared: {
          react: { singleton: true, requiredVersion: '^19.2.4' },
          'react-dom/client': { singleton: true, requiredVersion: '^19.2.4' },
        },
        hostInitInjectLocation: 'entry',
        dts: false,
      });
      hostServer = await serveDirectory(hostOutDir);

      browser = await createBrowser();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

      await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForFunction(
          () => document.querySelector('#app')?.textContent === 'rendered',
          undefined,
          { timeout: 5_000 }
        );
      } catch (error) {
        throw new Error(
          JSON.stringify(
            {
              cause: String(error),
              pageErrors,
              content: await page.content(),
            },
            null,
            2
          )
        );
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await remoteServer?.close();
      await rm(workspace, { recursive: true, force: true });
      setPackageDetectionCwd(originalPackageDetectionCwd);
    }
  }, 60_000);

  it('keeps the host React provider when a nested same-version leaf sorts after it', async () => {
    const originalPackageDetectionCwd = getPackageDetectionCwd();
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-react-nested-same-version-'));
    const servers: StaticServer[] = [];
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      // host 19.2.8 -> nested host remote_a 19.2.4 -> leaf remote_c 19.2.8.
      // The Runtime breaks the 19.2.8 tie by container name and "remote_c" sorts
      // after "host", so the leaf must not displace the host's already-seeded React.
      const stubs = {
        '19.2.8': path.resolve(FIXTURES, 'react-skew-host', 'node_modules'),
        '19.2.4': path.resolve(FIXTURES, 'react-skew-remote', 'node_modules'),
      };
      const createRemoteRoot = async (name: string, version: keyof typeof stubs) => {
        const root = path.join(workspace, `${name}-src`);
        await cp(path.resolve(FIXTURES, 'react-skew-remote'), root, { recursive: true });
        await rm(path.join(root, 'node_modules'), { recursive: true, force: true });
        await cp(stubs[version], path.join(root, 'node_modules'), { recursive: true });
        return root;
      };
      const shared = {
        react: { singleton: true, requiredVersion: '^19.2.4' },
        'react-dom/client': { singleton: true, requiredVersion: '^19.2.4' },
      };
      const serve = async (outDir: string) => {
        const server = await serveDirectory(outDir);
        servers.push(server);
        return server;
      };

      const leafRoot = await createRemoteRoot('remote_c', '19.2.8');
      const leafOutDir = path.join(workspace, 'remote_c');
      await buildFixtureTo(leafRoot, leafOutDir, {
        name: 'remote_c',
        filename: 'remoteEntry.js',
        exposes: { './Module': path.join(leafRoot, 'exposed-module.js') },
        shareStrategy: 'version-first',
        shared,
        hostInitInjectLocation: 'entry',
        dts: false,
      });
      const leafServer = await serve(leafOutDir);

      const nestedRoot = await createRemoteRoot('remote_a', '19.2.4');
      await writeFile(
        path.join(nestedRoot, 'exposed-module.js'),
        `import { useState } from 'react';
         import 'react-dom/client';
         export async function loadRemoteComponent() {
           // Keep the namespace: Rollup would otherwise destructure the dynamic
           // import before the remote-pending wrapper resolves.
           const leaf = await import('remote_c/Module');
           return function RemoteComponent() {
             return useState('nested')[0] + ':' + leaf.RemoteComponent();
           };
         }`
      );
      const nestedOutDir = path.join(workspace, 'remote_a');
      await buildFixtureTo(nestedRoot, nestedOutDir, {
        name: 'remote_a',
        filename: 'remoteEntry.js',
        exposes: { './Module': path.join(nestedRoot, 'exposed-module.js') },
        remotes: {
          remote_c: {
            name: 'remote_c',
            entry: `${leafServer.origin}/remoteEntry.js`,
            type: 'module',
          },
        },
        shareStrategy: 'version-first',
        shared,
        hostInitInjectLocation: 'entry',
        dts: false,
      });
      const nestedServer = await serve(nestedOutDir);

      const hostRoot = path.join(workspace, 'host-src');
      await cp(path.resolve(FIXTURES, 'react-skew-host'), hostRoot, { recursive: true });
      await writeFile(
        path.join(hostRoot, 'entry.js'),
        `import { createRoot } from 'react-dom/client';
         import('remote_a/Module')
           .then(({ loadRemoteComponent }) => loadRemoteComponent())
           .then((RemoteComponent) => {
             createRoot(document.querySelector('#app')).render(RemoteComponent);
           });`
      );
      const hostOutDir = path.join(workspace, 'host');
      await buildFixtureTo(hostRoot, hostOutDir, {
        name: 'host',
        filename: 'remoteEntry.js',
        remotes: {
          remote_a: {
            name: 'remote_a',
            entry: `${nestedServer.origin}/remoteEntry.js`,
            type: 'module',
          },
        },
        shareStrategy: 'version-first',
        shared,
        hostInitInjectLocation: 'entry',
        dts: false,
      });
      const hostServer = await serve(hostOutDir);

      browser = await createBrowser();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

      await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForFunction(
          () => document.querySelector('#app')?.textContent === 'rendered',
          undefined,
          { timeout: 5_000 }
        );
      } catch (error) {
        throw new Error(JSON.stringify({ cause: String(error), pageErrors }, null, 2));
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      for (const server of servers.reverse()) await server.close();
      await rm(workspace, { recursive: true, force: true });
      setPackageDetectionCwd(originalPackageDetectionCwd);
    }
  }, 60_000);
});
