import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation } from '../src';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../src/utils/packageUtils';
import { FIXTURES } from './helpers/build';

type StaticServer = {
  origin: string;
  close: () => Promise<void>;
};

async function serveDirectory(root: string): Promise<StaticServer> {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const filePath = path.resolve(root, relativePath);

    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }

    try {
      const content = await readFile(filePath);
      const contentType = filePath.endsWith('.html')
        ? 'text/html'
        : filePath.endsWith('.js')
          ? 'application/javascript'
          : 'application/octet-stream';
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': contentType,
      });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not bind');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function buildFixtureTo(
  fixture: string,
  outDir: string,
  mfOptions: Parameters<typeof federation>[0]
): Promise<void> {
  // federation() resolves each shared package's version synchronously (via
  // the process-wide package-detection cwd) before Vite's own config hook
  // would otherwise point that detection at this fixture's root, so it must
  // be set explicitly first whenever more than one fixture with its own
  // same-named shared dependency is built within a single process.
  setPackageDetectionCwd(path.resolve(FIXTURES, fixture));
  const result = await build({
    root: path.resolve(FIXTURES, fixture),
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'chrome91',
    },
    plugins: [federation(mfOptions)],
  });

  if (Array.isArray(result)) throw new Error('Expected a single Rollup output');
}

async function createBrowser() {
  return chromium.launch({ channel: 'chrome', headless: true });
}

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

describe('version-first singleton static import browser bootstrap', () => {
  it('resolves both host and remote static imports to the higher negotiated version', async () => {
    const originalPackageDetectionCwd = getPackageDetectionCwd();
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-version-first-singleton-browser-'));
    let remoteServer: StaticServer | undefined;
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      const remoteOutDir = path.join(workspace, 'remote');
      const hostOutDir = path.join(workspace, 'host');
      // remote declares shared-lib@1.5.0 — the higher of the two versions.
      await buildFixtureTo('version-first-singleton-remote', remoteOutDir, remoteOptions);
      remoteServer = await serveDirectory(remoteOutDir);
      // host declares shared-lib@1.0.0 — the lower of the two versions.
      await buildFixtureTo(
        'version-first-singleton-host',
        hostOutDir,
        hostOptions(`${remoteServer.origin}/remoteEntry.js`)
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

      // Under shareStrategy: 'version-first' with singleton: true, both the
      // host's and the remote's static import of the shared singleton must
      // resolve to the higher of the two negotiated versions, regardless of
      // which side declared it.
      expect(hostSaw).toBe('1.5.0');
      expect(remoteSaw).toBe('1.5.0');
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await remoteServer?.close();
      await rm(workspace, { recursive: true, force: true });
      setPackageDetectionCwd(originalPackageDetectionCwd);
    }
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
});
