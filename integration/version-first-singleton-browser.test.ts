import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('resolves a higher remote version before host static import capture', async () => {
    // The remote's 1.5.0 provider is registered by entry injection before the
    // host's static import captures the singleton; this must remain an upgrade.
    expect(await readNegotiatedSharedVersions()).toEqual({
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

  it('keeps nested and sibling React consumers on the captured singleton identity', async () => {
    const originalPackageDetectionCwd = getPackageDetectionCwd();
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-react-nested-sibling-identity-'));
    const servers: StaticServer[] = [];
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    try {
      // Production-shaped skew: host 19.2.8 -> remote_a 19.2.4 -> remote_c 19.2.8,
      // with sibling remote_b at 19.2.6. All providers satisfy ^19.2.4.
      const createRemoteRoot = async (name: string, version: '19.2.4' | '19.2.6' | '19.2.8') => {
        const root = path.join(workspace, `${name}-src`);
        await cp(path.resolve(FIXTURES, 'react-skew-remote'), root, { recursive: true });
        await rm(path.join(root, 'node_modules'), { recursive: true, force: true });
        await cp(
          path.resolve(
            FIXTURES,
            version === '19.2.8' ? 'react-skew-host/node_modules' : 'react-skew-remote/node_modules'
          ),
          path.join(root, 'node_modules'),
          { recursive: true }
        );
        const reactRoot = path.join(root, 'node_modules/react');
        await writeFile(
          path.join(reactRoot, 'jsx-runtime.js'),
          `exports.Fragment = Symbol.for('react.fragment');
           exports.jsx = function jsx(type, props) { return { type, props }; };
           exports.jsxs = exports.jsx;`
        );
        await writeFile(
          path.join(reactRoot, 'jsx-dev-runtime.js'),
          `exports.Fragment = Symbol.for('react.fragment');
           exports.jsxDEV = function jsxDEV(type, props) { return { type, props }; };`
        );
        await writeFile(
          path.join(reactRoot, 'compiler-runtime.js'),
          'exports.c = () => undefined;'
        );
        if (version === '19.2.8') {
          // The host fixture already provides the 19.2.8 React and ReactDOM stubs.
        } else if (version === '19.2.6') {
          for (const relativePath of [
            'react/index.js',
            'react/package.json',
            'react-dom/client.js',
            'react-dom/package.json',
          ]) {
            const filePath = path.join(root, 'node_modules', relativePath);
            const source = await readFile(filePath, 'utf8');
            await writeFile(filePath, source.replaceAll('19.2.4', '19.2.6'));
          }
        }
        if (name === 'remote_b' || name === 'remote_c') {
          await writeFile(
            path.join(root, 'node_modules/react-dom/renderer-react.js'),
            `const internals = { dispatcher: null };
             module.exports = { version: '${version}', __TEST_INTERNALS: internals };`
          );
          await writeFile(
            path.join(root, 'node_modules/react-dom/client.js'),
            `'use strict';
             const React = require('./renderer-react');
             const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
             if (hook) hook.inject({ currentDispatcherRef: React.__TEST_INTERNALS, version: '${version}' });
             exports.version = '${version}';
             exports.createRoot = function createRoot(container) {
               const owner = { currentDispatcherRef: React.__TEST_INTERNALS };
               const state = [];
               let component;
               let cursor = 0;
               const render = () => {
                 cursor = 0;
                 const previousDispatcher = React.__TEST_INTERNALS.dispatcher;
                 React.__TEST_INTERNALS.dispatcher = {
                   useState(initialValue) {
                     const slot = cursor++;
                     if (!(slot in state)) state[slot] = initialValue;
                     return [state[slot], (nextValue) => {
                       state[slot] = typeof nextValue === 'function' ? nextValue(state[slot]) : nextValue;
                       render();
                     }];
                   },
                 };
                 globalThis.__mf_current_root_owner__ = owner;
                 try { container.replaceChildren(component()); }
                 finally {
                   globalThis.__mf_current_root_owner__ = undefined;
                   React.__TEST_INTERNALS.dispatcher = previousDispatcher;
                 }
               };
               return {
                 render(nextComponent) {
                   component = nextComponent;
                   render();
                 },
               };
             };`
          );
        }
        return root;
      };
      const shared = {
        react: { singleton: true, requiredVersion: '^19.2.4', strictVersion: false },
        'react/jsx-runtime': { singleton: true, requiredVersion: '^19.2.4', strictVersion: false },
        'react/jsx-dev-runtime': {
          singleton: true,
          requiredVersion: '^19.2.4',
          strictVersion: false,
        },
        'react/compiler-runtime': {
          singleton: true,
          requiredVersion: '^19.2.4',
          strictVersion: false,
        },
        'react-dom/client': {
          singleton: true,
          requiredVersion: '^19.2.4',
          strictVersion: false,
        },
      };
      const serve = async (outDir: string) => {
        const server = await serveDirectory(outDir);
        servers.push(server);
        return server;
      };

      const leafRoot = await createRemoteRoot('remote_c', '19.2.8');
      await writeFile(
        path.join(leafRoot, 'exposed-module.js'),
        `import * as React from 'react';
         import { useState } from 'react';
         import { createRoot } from 'react-dom/client';
         export function RemoteComponent() {
           const [count, setCount] = useState(0);
           const button = document.createElement('button');
           button.id = 'remote-c-increment';
           button.textContent = 'Remote C count: ' + count;
           button.onclick = () => setCount(count + 1);
           const owner = globalThis.__mf_current_root_owner__;
           (globalThis.__react_leaf_identity_probe__ ||= {}).remoteC = {
             leafInternals: React.__TEST_INTERNALS,
             rootDispatcherRef: owner?.currentDispatcherRef,
           };
           return button;
         }
         export function mount(container) {
           createRoot(container).render(RemoteComponent);
         }`
      );
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
         import { createRoot } from 'react-dom/client';
         export async function loadRemoteComponent() {
           const leaf = await import('remote_c/Module');
           return leaf;
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

      const siblingRoot = await createRemoteRoot('remote_b', '19.2.6');
      await writeFile(
        path.join(siblingRoot, 'exposed-module.js'),
        `import * as React from 'react';
         import { useState } from 'react';
         import { createRoot } from 'react-dom/client';
         export function RemoteComponent() {
           const [count, setCount] = useState(0);
           const button = document.createElement('button');
           button.id = 'remote-b-increment';
           button.textContent = 'Remote B count: ' + count;
           button.onclick = () => setCount(count + 1);
           const owner = globalThis.__mf_current_root_owner__;
           (globalThis.__react_leaf_identity_probe__ ||= {}).remoteB = {
             leafInternals: React.__TEST_INTERNALS,
             rootDispatcherRef: owner?.currentDispatcherRef,
           };
           return button;
         }
         export function mount(container) {
           createRoot(container).render(RemoteComponent);
         }`
      );
      const siblingOutDir = path.join(workspace, 'remote_b');
      await buildFixtureTo(siblingRoot, siblingOutDir, {
        name: 'remote_b',
        filename: 'remoteEntry.js',
        exposes: { './Module': path.join(siblingRoot, 'exposed-module.js') },
        shareStrategy: 'version-first',
        shared,
        hostInitInjectLocation: 'entry',
        dts: false,
      });
      const siblingServer = await serve(siblingOutDir);

      const hostRoot = path.join(workspace, 'host-src');
      await cp(path.resolve(FIXTURES, 'react-skew-host'), hostRoot, { recursive: true });
      const hostReactRoot = path.join(hostRoot, 'node_modules/react');
      await writeFile(
        path.join(hostReactRoot, 'jsx-runtime.js'),
        `exports.Fragment = Symbol.for('react.fragment');
         exports.jsx = function jsx(type, props) { return { type, props }; };
         exports.jsxs = exports.jsx;`
      );
      await writeFile(
        path.join(hostReactRoot, 'jsx-dev-runtime.js'),
        `exports.Fragment = Symbol.for('react.fragment');
         exports.jsxDEV = function jsxDEV(type, props) { return { type, props }; };`
      );
      await writeFile(
        path.join(hostReactRoot, 'compiler-runtime.js'),
        'exports.c = () => undefined;'
      );
      await writeFile(
        path.join(hostRoot, 'node_modules/react-dom/client.js'),
        `'use strict';
         const React = require('react');
         const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
         const renderer = { currentDispatcherRef: React.__TEST_INTERNALS, version: '19.2.8' };
         if (hook) hook.inject(renderer);
         exports.createRoot = function createRoot(container) {
           const owner = { currentDispatcherRef: React.__TEST_INTERNALS, renderer };
           const state = [];
           let component;
           let cursor = 0;
           const render = () => {
             cursor = 0;
             const previousDispatcher = React.__TEST_INTERNALS.dispatcher;
             React.__TEST_INTERNALS.dispatcher = {
               useState(initialValue) {
                 const slot = cursor++;
                 if (!(slot in state)) state[slot] = initialValue;
                 return [state[slot], (nextValue) => {
                   if (globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.currentRenderer !== owner.renderer) return;
                   state[slot] = typeof nextValue === 'function' ? nextValue(state[slot]) : nextValue;
                   render();
                 }];
               },
             };
             globalThis.__mf_current_root_owner__ = owner;
             try {
               const value = component();
               container.replaceChildren(value);
             } finally {
               globalThis.__mf_current_root_owner__ = undefined;
               React.__TEST_INTERNALS.dispatcher = previousDispatcher;
             }
           };
           return {
             render(nextComponent) {
               component = nextComponent;
               render();
             },
           };
         };`
      );
      await writeFile(
        path.join(hostRoot, 'index.html'),
        '<!doctype html><html><body><div id="nested"></div><div id="sibling"></div><script>globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__={renderers:new Map(),inject(renderer){const id=this.renderers.size+1;this.renderers.set(id,renderer);this.currentRenderer=renderer;return id;}};</script><script type="module" src="./entry.js"></script></body></html>'
      );
      await writeFile(
        path.join(hostRoot, 'entry.js'),
        `import * as React from 'react';
         const cacheBefore = globalThis.__mf_module_cache__.share['default:react'];
         const useStateBefore = React.useState;
         const internalsBefore = React.__TEST_INTERNALS;
         Promise.all([import('remote_a/Module'), import('remote_b/Module')])
           .then(async ([nested, sibling]) => {
             const leaf = await nested.loadRemoteComponent();
             leaf.mount(document.querySelector('#nested'));
             sibling.mount(document.querySelector('#sibling'));
             const cacheAfter = globalThis.__mf_module_cache__.share['default:react'];
          window.__react_identity_probe__ = {
              cacheSame: cacheAfter === cacheBefore,
              useStateSame: React.useState === useStateBefore,
              internalsSame: React.__TEST_INTERNALS === internalsBefore,
              rendererCount: globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size,
           };
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
          remote_b: {
            name: 'remote_b',
            entry: `${siblingServer.origin}/remoteEntry.js`,
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
          () =>
            document.querySelector('#remote-c-increment')?.textContent === 'Remote C count: 0' &&
            document.querySelector('#remote-b-increment')?.textContent === 'Remote B count: 0',
          undefined,
          { timeout: 5_000 }
        );
      } catch (error) {
        throw new Error(
          JSON.stringify(
            { cause: String(error), pageErrors, content: await page.content() },
            null,
            2
          )
        );
      }

      expect(pageErrors).toEqual([]);
      expect(
        await page.evaluate(() => {
          const probe = (window as any).__react_leaf_identity_probe__;
          return {
            remoteC: probe?.remoteC?.leafInternals === probe?.remoteC?.rootDispatcherRef,
            remoteB: probe?.remoteB?.leafInternals === probe?.remoteB?.rootDispatcherRef,
          };
        })
      ).toEqual({
        remoteC: true,
        remoteB: true,
      });
      await page.locator('#remote-c-increment').click();
      await page.waitForFunction(
        () => document.querySelector('#remote-c-increment')?.textContent === 'Remote C count: 1'
      );
      await page.locator('#remote-b-increment').click();
      await page.waitForFunction(
        () => document.querySelector('#remote-b-increment')?.textContent === 'Remote B count: 1'
      );
      expect(await page.evaluate(() => (window as any).__react_identity_probe__)).toEqual({
        cacheSame: true,
        useStateSame: true,
        internalsSame: true,
        rendererCount: 1,
      });
    } finally {
      await browser?.close();
      for (const server of servers.reverse()) await server.close();
      await rm(workspace, { recursive: true, force: true });
      setPackageDetectionCwd(originalPackageDetectionCwd);
    }
  }, 60_000);
});
