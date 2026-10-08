import { chromium } from '@playwright/test';
import { createServer, type ViteDevServer, version as viteVersion } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { federation } from '../src';

const servers: ViteDevServer[] = [];
const roots: string[] = [];
const supportsBundledDev = Number.parseInt(viteVersion, 10) >= 8;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createFixture(name: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `mf-vite-bundled-dev-${name}-`));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([file, source]) => {
      const filePath = path.join(root, file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, source);
    })
  );
  return root;
}

async function startServer(
  root: string,
  options: Parameters<typeof federation>[0],
  bundledDev = true
) {
  const server = await createServer({
    root,
    logLevel: 'silent',
    experimental: { bundledDev },
    plugins: [federation(options)],
    server: {
      cors: true,
      host: '127.0.0.1',
      port: 0,
    },
  });
  await server.listen();
  servers.push(server);
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite server did not bind');
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

describe.skipIf(!supportsBundledDev)('Vite bundledDev Module Federation compatibility', () => {
  it('loads an expose from a bundledDev remote', async () => {
    const remoteRoot = await createFixture('remote', {
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': 'document.body.textContent = "remote-ready";\n',
      'src/App.js': `
        document.body.dataset.remoteExpose = 'remote-expose-ready';
        export default 'remote-expose-ready';
      `,
    });
    const remote = await startServer(remoteRoot, {
      name: 'bundledDevRemote',
      filename: 'remoteEntry.js',
      exposes: { './App': './src/App.js' },
      dts: false,
    });

    const hostRoot = await createFixture('host', {
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': `
        (async () => {
          const remote = await import('bundledDevRemote/App');
          document.body.textContent = remote.default;
        })();
      `,
    });
    const host = await startServer(hostRoot, {
      name: 'bundledDevHost',
      remotes: {
        bundledDevRemote: {
          type: 'module',
          name: 'bundledDevRemote',
          entry: `${remote.origin}/remoteEntry.js`,
        },
      },
      dts: false,
    });

    expect(remote.server.config.experimental.bundledDev).toBe(true);
    expect(host.server.config.experimental.bundledDev).toBe(true);

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const errorResponses: string[] = [];
    const remoteEntryResponse = await fetch(`${remote.origin}/remoteEntry.js`);
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) errorResponses.push(`${response.status()} ${response.url()}`);
    });

    try {
      expect(remoteEntryResponse.status).toBe(200);
      const remoteEntrySource = await remoteEntryResponse.text();
      expect(remoteEntrySource).toMatch(/\binit\b/);
      expect(remoteEntrySource).toMatch(/\bget\b/);
      await page.goto(host.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.body.textContent === 'remote-expose-ready', null, {
        timeout: 15_000,
      });
      expect(pageErrors).toEqual([]);
      expect(errorResponses).toEqual([]);

      await writeFile(
        path.join(remoteRoot, 'src/App.js'),
        `
          document.body.dataset.remoteExpose = 'remote-expose-updated';
          export default 'remote-expose-updated';
        `
      );
      await page.waitForFunction(
        () => document.body.dataset.remoteExpose === 'remote-expose-updated',
        null,
        { timeout: 15_000 }
      );
    } catch (error) {
      throw new Error(
        JSON.stringify(
          {
            cause: String(error),
            remoteOrigin: remote.origin,
            hostOrigin: host.origin,
            remoteEntryStatus: remoteEntryResponse.status,
            pageErrors,
            consoleErrors,
            failedRequests,
            errorResponses,
            content: await page.content(),
          },
          null,
          2
        )
      );
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('serves a bundledDev remote expose graph in a few requests', async () => {
    const moduleCount = 50;
    const chain: Record<string, string> = {};
    for (let i = 0; i < moduleCount; i++) {
      chain[`src/chain/m${i}.js`] =
        i + 1 < moduleCount
          ? `import next from './m${i + 1}.js';\nexport default ${i} + next;\n`
          : `export default ${i};\n`;
    }
    const remoteRoot = await createFixture('chain-remote', {
      ...chain,
      // An inline html module shared with the expose, like the React Refresh preamble.
      'index.html':
        '<script type="module">import "/src/preamble.js";</script>\n<script type="module" src="/src/main.js"></script>\n',
      'src/preamble.js': 'export const preamble = true;\n',
      'src/main.js': 'document.body.dataset.remoteMain = "ran";\n',
      'src/App.js': `
        import './preamble.js';
        import sum from './chain/m0.js';
        export default 'chain-' + sum;
      `,
    });
    const remote = await startServer(remoteRoot, {
      name: 'bundledDevChainRemote',
      filename: 'remoteEntry.js',
      exposes: { './App': './src/App.js' },
      dts: false,
    });

    const hostRoot = await createFixture('chain-host', {
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': `
        (async () => {
          const remote = await import('bundledDevChainRemote/App');
          document.body.textContent = remote.default;
        })();
      `,
    });
    const host = await startServer(hostRoot, {
      name: 'bundledDevChainHost',
      remotes: {
        bundledDevChainRemote: {
          type: 'module',
          name: 'bundledDevChainRemote',
          entry: `${remote.origin}/remoteEntry.js`,
        },
      },
      dts: false,
    });

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    const remoteRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    page.on('request', (request) => {
      if (request.url().startsWith(remote.origin)) remoteRequests.push(request.url());
    });

    try {
      await page.goto(host.origin, { waitUntil: 'domcontentloaded' });
      const expected = `chain-${(moduleCount * (moduleCount - 1)) / 2}`;
      await page.waitForFunction((text) => document.body.textContent === text, expected, {
        timeout: 15_000,
      });
      expect(pageErrors).toEqual([]);
      expect(remoteRequests.length).toBeLessThan(15);
      // The remote's own app entry must not run inside the host page.
      expect(await page.evaluate(() => document.body.dataset.remoteMain)).toBeUndefined();
      // The remote's modules live in its own Rolldown dev runtime, not the host's.
      const hostRuntimeIds = await page.evaluate(() => [
        ...((
          globalThis as { __rolldown_runtime__?: { moduleCache?: Map<string, unknown> } }
        ).__rolldown_runtime__?.moduleCache?.keys() ?? []),
      ]);
      expect(hostRuntimeIds.length).toBeGreaterThan(0);
      expect(hostRuntimeIds.filter((id) => id.includes('chain-remote'))).toEqual([]);
    } catch (error) {
      throw new Error(
        JSON.stringify({ cause: String(error), pageErrors, remoteRequests }, null, 2)
      );
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('keeps a remoteHmr remote on bundledDev', async () => {
    const remoteRoot = await createFixture('remote-hmr', {
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': 'document.body.textContent = "remote-ready";\n',
      'src/App.js': 'export default "remote-hmr";\n',
    });
    const remote = await startServer(remoteRoot, {
      name: 'bundledDevRemoteHmr',
      filename: 'remoteEntry.js',
      exposes: { './App': './src/App.js' },
      dev: { remoteHmr: true },
      dts: false,
    });

    expect(remote.server.config.experimental.bundledDev).toBe(true);
  }, 60_000);

  it('loads a statically imported expose from a bundledDev remote', async () => {
    const remoteRoot = await createFixture('static-remote', {
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': 'document.body.textContent = "remote-ready";\n',
      'src/App.js': 'export default "static-remote-expose-ready";\n',
    });
    const remote = await startServer(remoteRoot, {
      name: 'bundledDevStaticRemote',
      filename: 'remoteEntry.js',
      exposes: { './App': './src/App.js' },
      dts: false,
    });

    const hostRoot = await createFixture('static-host', {
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': `
        import remote from 'bundledDevStaticRemote/App';
        document.body.textContent = remote;
      `,
    });
    const host = await startServer(hostRoot, {
      name: 'bundledDevStaticHost',
      remotes: {
        bundledDevStaticRemote: {
          type: 'module',
          name: 'bundledDevStaticRemote',
          entry: `${remote.origin}/remoteEntry.js`,
        },
      },
      dts: false,
    });

    expect(host.server.config.experimental.bundledDev).toBe(true);

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

    try {
      await page.goto(host.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.body.textContent === 'static-remote-expose-ready',
        null,
        { timeout: 15_000 }
      );
      expect(pageErrors).toEqual([]);
    } catch (error) {
      throw new Error(
        JSON.stringify(
          { cause: String(error), pageErrors, consoleErrors, content: await page.content() },
          null,
          2
        )
      );
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('keeps a singleton shared dependency aligned across Host and Remote', async () => {
    const sharedPackage = {
      'node_modules/mock-shared-dep/package.json': JSON.stringify({
        name: 'mock-shared-dep',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      }),
      'node_modules/mock-shared-dep/index.js': 'export const instance = {};\n',
    };
    const remoteRoot = await createFixture('shared-remote', {
      ...sharedPackage,
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': 'document.body.textContent = "remote-ready";\n',
      'src/App.js': `
        import { instance } from 'mock-shared-dep';
        export default instance;
      `,
    });
    const remote = await startServer(remoteRoot, {
      name: 'bundledDevSharedRemote',
      filename: 'remoteEntry.js',
      exposes: { './App': './src/App.js' },
      shared: { 'mock-shared-dep': { singleton: true } },
      dts: false,
    });

    const hostRoot = await createFixture('shared-host', {
      ...sharedPackage,
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': `
        import { instance as hostInstance } from 'mock-shared-dep';
        (async () => {
          const remote = await import('bundledDevSharedRemote/App');
          document.body.textContent = remote.default === hostInstance
            ? 'shared-singleton-ready'
            : 'shared-singleton-mismatch';
        })();
      `,
    });
    const host = await startServer(hostRoot, {
      name: 'bundledDevSharedHost',
      remotes: {
        bundledDevSharedRemote: {
          type: 'module',
          name: 'bundledDevSharedRemote',
          entry: `${remote.origin}/remoteEntry.js`,
        },
      },
      shared: { 'mock-shared-dep': { singleton: true } },
      dts: false,
    });

    expect(remote.server.config.experimental.bundledDev).toBe(true);
    expect(host.server.config.experimental.bundledDev).toBe(true);

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

    try {
      await page.goto(host.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.body.textContent === 'shared-singleton-ready',
        null,
        { timeout: 15_000 }
      );
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
