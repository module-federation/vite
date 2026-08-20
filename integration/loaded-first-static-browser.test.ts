import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation } from '../src';
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
    './Module': path.resolve(FIXTURES, 'basic-remote', 'exposed-module.js'),
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
    shareStrategy: 'loaded-first',
    hostInitInjectLocation: 'html',
    dts: false,
  } satisfies Parameters<typeof federation>[0];
}

describe('loaded-first static remote browser bootstrap', () => {
  it.each([
    ['named', 'loaded-first-static-host'],
    ['namespace', 'loaded-first-namespace-host'],
  ])(
    'evaluates %s static imports after the remote is ready',
    async (_kind, fixture) => {
      const workspace = await mkdtemp(path.join(tmpdir(), 'mf-loaded-first-browser-'));
      let remoteServer: StaticServer | undefined;
      let hostServer: StaticServer | undefined;
      let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

      try {
        const remoteOutDir = path.join(workspace, 'remote');
        const hostOutDir = path.join(workspace, 'host');
        await buildFixtureTo('basic-remote', remoteOutDir, remoteOptions);
        remoteServer = await serveDirectory(remoteOutDir);
        await buildFixtureTo(
          fixture,
          hostOutDir,
          hostOptions(`${remoteServer.origin}/remoteEntry.js`)
        );
        hostServer = await serveDirectory(hostOutDir);

        browser = await createBrowser();
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        const requests: string[] = [];
        const events: string[] = [];
        await page.addInitScript(() => {
          (window as typeof window & { __mfUnhandled?: string[] }).__mfUnhandled = [];
          window.addEventListener('unhandledrejection', (event) => {
            const target = window as typeof window & { __mfUnhandled: string[] };
            target.__mfUnhandled.push(String(event.reason));
          });
        });
        page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
          if (message.text() === '__mf_host_entry_evaluated__') events.push('host-entry');
        });
        page.on('request', (request) => requests.push(request.url()));
        page.on('response', (response) => {
          if (response.url() === `${remoteServer!.origin}/remoteEntry.js`) {
            events.push('remote-response');
          }
        });

        await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
        try {
          await page.waitForFunction(
            () => document.querySelector('#app')?.textContent === 'remoteApp',
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
                requests,
                events,
                content: await page.content(),
              },
              null,
              2
            )
          );
        }
        expect(await page.locator('#app').textContent()).toBe('remoteApp');

        expect(events.indexOf('remote-response')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('host-entry')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('remote-response')).toBeLessThan(events.indexOf('host-entry'));
        expect(pageErrors).toEqual([]);
        await expect(page.evaluate(() => (window as any).__mfUnhandled)).resolves.toEqual([]);
      } finally {
        await browser?.close();
        await hostServer?.close();
        await remoteServer?.close();
        await rm(workspace, { recursive: true, force: true });
      }
    },
    60_000
  );

  it('does not evaluate the host entry when a static remote fails', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-loaded-first-browser-failure-'));
    let remoteServer: StaticServer | undefined;
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      const remoteOutDir = path.join(workspace, 'remote');
      const hostOutDir = path.join(workspace, 'host');
      await buildFixtureTo('basic-remote', remoteOutDir, remoteOptions);
      remoteServer = await serveDirectory(remoteOutDir);
      const remoteEntry = `${remoteServer.origin}/remoteEntry.js`;
      await remoteServer.close();
      remoteServer = undefined;

      await buildFixtureTo('loaded-first-static-host', hostOutDir, hostOptions(remoteEntry));
      hostServer = await serveDirectory(hostOutDir);
      browser = await createBrowser();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      await page.addInitScript(() => {
        (window as typeof window & { __mfUnhandled?: string[] }).__mfUnhandled = [];
        window.addEventListener('unhandledrejection', (event) => {
          const target = window as typeof window & { __mfUnhandled: string[] };
          target.__mfUnhandled.push(String(event.reason));
        });
      });
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

      await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      expect(await page.locator('#app').textContent()).toBe('');
      const unhandled = await page.evaluate(() => (window as any).__mfUnhandled as string[]);
      expect([...pageErrors, ...unhandled].join('\n')).toMatch(
        /Failed to load script resources|RUNTIME-008/
      );
    } finally {
      await browser?.close();
      await hostServer?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
