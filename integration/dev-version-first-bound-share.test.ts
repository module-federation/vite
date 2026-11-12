import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { federation } from '../src';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RUNTIME_PACKAGE = path.join(REPO_ROOT, 'node_modules/@module-federation/runtime');

const servers: ViteDevServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined))
  );
});

async function reservePort() {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Port probe did not bind');
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function packageJson(name: string, version: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ name, version, type: 'module', ...extra }, null, 2);
}

async function writePackage(root: string, name: string, version: string, source: string, extra?: Record<string, unknown>) {
  const directory = path.join(root, 'node_modules', ...name.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), packageJson(name, version, extra));
  await writeFile(path.join(directory, 'index.js'), source);
}

async function createApp(name: string, copyId: string, files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), `mf-bound-share-${name}-`));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    packageJson(name, '1.0.0')
  );
  await writeFile(
    path.join(root, 'index.html'),
    '<div id="app"></div>\n<script type="module" src="/src/main.js"></script>\n'
  );
  await writePackage(
    root,
    '@probe/ui',
    '1.0.0',
    `export const copyId = ${JSON.stringify(copyId)};
export class ProbeButton extends HTMLElement {
  constructor() {
    super();
    this.dataset.copy = copyId;
  }
}
ProbeButton.copyId = copyId;
const tag = 'probe-button';
globalThis.__probeEvaluated = globalThis.__probeEvaluated || [];
globalThis.__probeEvaluated.push(copyId);
if (typeof customElements !== 'undefined' && !customElements.get(tag)) {
  customElements.define(tag, ProbeButton);
}
`
  );
  await writePackage(
    root,
    '@probe/adapter',
    '1.0.0',
    `import { ProbeButton, copyId } from '@probe/ui';
import { loadShare } from '@module-federation/runtime';

export function boundProbe() {
  return { ProbeButton, copyId, loadShare };
}
`,
    {
      dependencies: {
        '@probe/ui': '1.0.0',
        '@module-federation/runtime': '2.9.3',
      },
    }
  );
  const runtimeLink = path.join(root, 'node_modules/@module-federation/runtime');
  await mkdir(path.dirname(runtimeLink), { recursive: true });
  await symlink(RUNTIME_PACKAGE, runtimeLink, 'dir');
  await Promise.all(
    Object.entries(files).map(async ([file, source]) => {
      const filePath = path.join(root, file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, source);
    })
  );
  return root;
}

async function startServer(root: string, options: Parameters<typeof federation>[0]) {
  const port = await reservePort();
  const server = await createServer({
    root,
    cacheDir: path.join(root, 'node_modules/.vite'),
    logLevel: 'error',
    appType: 'spa',
    resolve: {
      alias: {
        '@module-federation/vite/ssrEntryLoader': path.join(REPO_ROOT, 'src/utils/ssrEntryLoader.ts'),
      },
    },
    plugins: [federation(options)],
    optimizeDeps: { exclude: ['@probe/ui', '@probe/adapter', '@module-federation/runtime'] },
    server: {
      cors: true,
      host: '127.0.0.1',
      port,
      strictPort: true,
      fs: { allow: [root, REPO_ROOT] },
    },
  });
  await server.listen();
  servers.push(server);
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite server did not bind');
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

type ShareProvider = {
  lib?: () => { ProbeButton?: unknown; default?: { ProbeButton?: unknown } };
  loaded?: boolean;
  from?: string;
  shareConfig?: { import?: boolean };
};

const sharedProbe = {
  '@probe/ui': { singleton: true, requiredVersion: '^1.0.0' },
  '@probe/adapter': { singleton: true, requiredVersion: '^1.0.0' },
} as const;

describe('dev version-first bound singleton publication', () => {
  it('publishes the bound @probe/ui singleton into every runtime share scope', async () => {
    const leafRoot = await createApp('leaf', 'leaf', {
      'node_modules/vue/package.json': packageJson('vue', '3.5.45'),
      'node_modules/vue/index.js':
        "export const version = '3.5.45';\nexport function createApp() { return { mount() {} }; }\n",
      'src/widget.js': `import { version, createApp } from 'vue';
import { boundProbe } from '@probe/adapter';
export function loadWidget() {
  createApp({});
  return { ...boundProbe(), vue: version };
}
`,
      'src/main.js': `import { loadWidget } from './widget.js';
loadWidget();
document.querySelector('#app').textContent = 'leaf';
`,
    });
    const leaf = await startServer(leafRoot, {
      name: 'probeLeaf',
      filename: 'remoteEntry.js',
      exposes: { './Widget': path.join(leafRoot, 'src/widget.js') },
      shareStrategy: 'version-first',
      hostInitInjectLocation: 'html',
      dts: false,
      manifest: false,
      shared: {
        ...sharedProbe,
        vue: { singleton: true, requiredVersion: '^3.5.0' },
      },
    });

    const remoteRoot = await createApp('remote', 'remote', {
      'node_modules/react/package.json': packageJson('react', '19.2.8'),
      'node_modules/react/index.js':
        "export const version = '19.2.8';\nexport function createElement() { return null; }\nexport function useState(value) { return [value, () => {}]; }\n",
      'src/button.js': `import { version } from 'react';
import { boundProbe } from '@probe/adapter';
import { loadWidget } from 'probeLeaf/Widget';
export function loadButton() {
  return { ...boundProbe(), react: version, leaf: loadWidget() };
}
`,
      'src/main.js': `import { loadButton } from './button.js';
loadButton();
document.querySelector('#app').textContent = 'remote';
`,
    });
    const remote = await startServer(remoteRoot, {
      name: 'probeRemote',
      filename: 'remoteEntry.js',
      exposes: { './Button': path.join(remoteRoot, 'src/button.js') },
      remotes: {
        probeLeaf: {
          type: 'module',
          name: 'probeLeaf',
          entry: `${leaf.origin}/remoteEntry.js`,
        },
      },
      shareStrategy: 'version-first',
      hostInitInjectLocation: 'html',
      dts: false,
      manifest: false,
      shared: {
        ...sharedProbe,
        react: { singleton: true, requiredVersion: '^19.0.0' },
      },
    });

    const hostRoot = await createApp('host', 'host', {
      'node_modules/react/package.json': packageJson('react', '19.2.8'),
      'node_modules/react/index.js':
        "export const version = '19.2.8';\nexport function createElement() { return null; }\nexport function useState(value) { return [value, () => {}]; }\n",
      'src/main.js': `import { version } from 'react';
import { boundProbe } from '@probe/adapter';
import { loadButton } from 'probeRemote/Button';
const remote = loadButton();
window.__probeReady = {
  react: version,
  host: boundProbe().copyId,
  remote: remote.copyId,
  leaf: remote.leaf.copyId,
};
document.querySelector('#app').textContent = 'host';
`,
    });
    const host = await startServer(hostRoot, {
      name: 'probeHost',
      filename: 'remoteEntry.js',
      remotes: {
        probeRemote: {
          type: 'module',
          name: 'probeRemote',
          entry: `${remote.origin}/remoteEntry.js`,
        },
      },
      shareStrategy: 'version-first',
      hostInitInjectLocation: 'html',
      dts: false,
      manifest: false,
      shared: {
        ...sharedProbe,
        react: { singleton: true, requiredVersion: '^19.0.0' },
      },
    });

    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

    try {
      await page.goto(host.origin, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForFunction(() => (window as { __probeReady?: unknown }).__probeReady, undefined, {
          timeout: 20_000,
        });
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

      const report = await page.evaluate(() => {
        const registered = customElements.get('probe-button') as { copyId?: string } | undefined;
        const seen = new Set<object>();
        const scopes: Array<{
          instance: string | undefined;
          scope: string;
          providers: Array<{
            version: string;
            from: string | undefined;
            loaded: boolean;
            hasLib: boolean;
            importFalse: boolean;
            factoryMatchesRegistered: boolean;
          }>;
        }> = [];
        const federation = (
          globalThis as {
            __FEDERATION__?: {
              __INSTANCES__?: Array<{
                options?: { name?: string };
                shareScopeMap?: Record<string, Record<string, Record<string, ShareProvider>>>;
              }>;
            };
          }
        ).__FEDERATION__;
        const instances = federation?.__INSTANCES__ || [];
        for (const instance of instances) {
          for (const [scopeName, scope] of Object.entries(instance.shareScopeMap || {})) {
            const versions = scope?.['@probe/ui'];
            if (!versions || seen.has(versions)) continue;
            seen.add(versions);
            scopes.push({
              instance: instance.options?.name,
              scope: scopeName,
              providers: Object.entries(versions).map(([version, provider]) => {
                let factoryMatchesRegistered = false;
                if (typeof provider?.lib === 'function') {
                  const loadedModule = provider.lib() as { ProbeButton?: unknown; default?: { ProbeButton?: unknown } };
                  const ctor = loadedModule?.ProbeButton || loadedModule?.default?.ProbeButton;
                  factoryMatchesRegistered = ctor === registered;
                }
                return {
                  version,
                  from: provider?.from,
                  loaded: provider?.loaded === true,
                  hasLib: typeof provider?.lib === 'function',
                  importFalse: provider?.shareConfig?.import === false,
                  factoryMatchesRegistered,
                };
              }),
            });
          }
        }
        return {
          registeredCopy: registered?.copyId,
          evaluated: (globalThis as { __probeEvaluated?: string[] }).__probeEvaluated || [],
          ready: (window as { __probeReady?: unknown }).__probeReady,
          scopes,
        };
      });

      expect(pageErrors, JSON.stringify({ pageErrors, report }, null, 2)).toEqual([]);
      expect(report.registeredCopy, JSON.stringify(report, null, 2)).toBeTruthy();
      expect(report.scopes.length, JSON.stringify(report, null, 2)).toBeGreaterThan(0);
      for (const scope of report.scopes) {
        const providers = scope.providers.filter((provider) => !provider.importFalse);
        const represented = providers.some(
          (provider) => provider.hasLib && provider.loaded && provider.factoryMatchesRegistered
        );
        expect(represented, JSON.stringify({ scope, report }, null, 2)).toBe(true);
      }
    } finally {
      await browser.close();
    }
  }, 90_000);
});
