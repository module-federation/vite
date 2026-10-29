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
  it('retries a failed deferred remote import without reloading the page', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-loaded-first-browser-retry-'));
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      const hostOutDir = path.join(workspace, 'host');
      const remoteEntry = 'http://localhost:4174/retry-remote.js';
      const options = hostOptions(remoteEntry);
      await buildFixtureTo('loaded-first-retry-host', hostOutDir, {
        ...options,
        remotes: {
          remote1: {
            ...options.remotes.remote1,
            type: 'var',
            entryGlobalName: 'retryRemote',
          },
        },
      });
      hostServer = await serveDirectory(hostOutDir);
      browser = await createBrowser();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      let available = false;
      let entryRequests = 0;
      // Use a script container so the browser's failed ESM import cache does
      // not independently prevent the runtime from retrying the request.
      await page.route(remoteEntry, async (route) => {
        entryRequests++;
        await route.fulfill({
          status: available ? 200 : 503,
          contentType: 'application/javascript',
          body: available
            ? `globalThis.retryRemote = {
                init() {},
                get() {
                  return () => ({ REMOTE_NAME: 'recovered' });
                },
              };`
            : '',
        });
      });

      await page.goto(hostServer.origin);
      await page.waitForFunction(() => typeof (window as any).loadRemote === 'function');
      expect(entryRequests).toBe(0);
      const firstError = await page.evaluate(() =>
        (window as any).loadRemote().then(
          () => null,
          (error: Error) => error.message
        )
      );
      expect(firstError).toMatch(/Failed to load script resources|RUNTIME-008/);
      expect(entryRequests).toBe(1);

      available = true;
      await expect(
        page.evaluate(() => (window as any).loadRemote().then((mod: any) => mod.REMOTE_NAME))
      ).resolves.toBe('recovered');
      await expect(
        page.evaluate(() => (window as any).loadRemote().then((mod: any) => mod.REMOTE_NAME))
      ).resolves.toBe('recovered');
      expect(entryRequests).toBe(2);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

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

  it('resolves a local dynamic import after the remotes its chunk imports statically', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-loaded-first-browser-boundary-'));
    let remoteServer: StaticServer | undefined;
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      const remoteOutDir = path.join(workspace, 'remote');
      const hostOutDir = path.join(workspace, 'host');
      await buildFixtureTo('basic-remote', remoteOutDir, remoteOptions);
      remoteServer = await serveDirectory(remoteOutDir);
      await buildFixtureTo(
        'loaded-first-dynamic-boundary-host',
        hostOutDir,
        hostOptions(`${remoteServer.origin}/remoteEntry.js`)
      );
      hostServer = await serveDirectory(hostOutDir);

      browser = await createBrowser();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

      await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.querySelector('#app')?.textContent !== '',
        undefined,
        {
          timeout: 15_000,
        }
      );

      expect(await page.locator('#app').textContent()).toBe('remoteApp');
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await remoteServer?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects a local dynamic import when a remote its chunk imports statically fails', async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), 'mf-loaded-first-browser-boundary-failure-')
    );
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

      await buildFixtureTo(
        'loaded-first-dynamic-boundary-host',
        hostOutDir,
        hostOptions(remoteEntry)
      );
      hostServer = await serveDirectory(hostOutDir);
      browser = await createBrowser();
      const page = await browser.newPage();
      await page.addInitScript(() => {
        (window as typeof window & { __mfUnhandled?: string[] }).__mfUnhandled = [];
        window.addEventListener('unhandledrejection', (event) => {
          const target = window as typeof window & { __mfUnhandled: string[] };
          target.__mfUnhandled.push(String(event.reason));
        });
      });

      await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => (window as any).__mfUnhandled.length > 0, undefined, {
        timeout: 15_000,
      });

      expect(await page.locator('#app').textContent()).toBe('');
      const unhandled = await page.evaluate(() => (window as any).__mfUnhandled as string[]);
      expect(unhandled.join('\n')).toMatch(/Failed to load script resources|RUNTIME-008/);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it('resolves a local dynamic import whose chunk uses a remote only as a type', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-loaded-first-browser-type-only-'));
    let hostServer: StaticServer | undefined;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      // Nothing serves the remote: the page must not need it.
      const unused = await serveDirectory(workspace);
      const remoteEntry = `${unused.origin}/remoteEntry.js`;
      await unused.close();

      const hostOutDir = path.join(workspace, 'host');
      await buildFixtureTo(
        'loaded-first-type-only-boundary-host',
        hostOutDir,
        hostOptions(remoteEntry)
      );
      hostServer = await serveDirectory(hostOutDir);
      browser = await createBrowser();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

      await page.goto(hostServer.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.querySelector('#app')?.textContent !== '',
        undefined,
        { timeout: 15_000 }
      );

      expect(await page.locator('#app').textContent()).toBe('typed');
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await hostServer?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

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
