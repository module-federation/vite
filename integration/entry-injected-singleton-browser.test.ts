import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

async function createApp(root: string, name: 'host' | 'remote') {
  const vue = path.join(root, 'node_modules/vue');
  await mkdir(vue, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, type: 'module' }));
  await writeFile(
    path.join(vue, 'package.json'),
    JSON.stringify({
      name: 'vue',
      version: '3.5.13',
      type: 'module',
      exports: './index.js',
    })
  );
  await writeFile(
    path.join(vue, 'index.js'),
    `
    globalThis.__vueEvaluations ??= [];
    globalThis.__vueEvaluations.push('${name}-vue-local-fallback');
    export const provider = '${name}-vue-local-fallback';
  `
  );
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>'
  );
  if (name === 'remote') {
    await writeFile(
      path.join(root, 'exposed-module.js'),
      `import { provider } from 'vue'; export const render = () => provider;`
    );
    await writeFile(
      path.join(root, 'entry.js'),
      `import { render } from './exposed-module.js';
       document.querySelector('#app').textContent = render();`
    );
  }
}

async function jsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(root, entry.name);
        return entry.isDirectory() ? jsFiles(file) : file.endsWith('.js') ? [file] : [];
      })
    )
  ).flat();
}

describe('entry-injected singleton fallback browser loading', () => {
  it('uses the host vue without fetching or evaluating the remote fallback, and loads it standalone', async () => {
    const previousCwd = getPackageDetectionCwd();
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-entry-vue-fallback-'));
    const servers: StaticServer[] = [];
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;
    try {
      const remoteRoot = path.join(workspace, 'remote-src');
      const hostRoot = path.join(workspace, 'host-src');
      await createApp(remoteRoot, 'remote');
      await createApp(hostRoot, 'host');
      const shared = { vue: { singleton: true, requiredVersion: '^3.5.0', strictVersion: false } };
      const remoteOut = path.join(workspace, 'remote-dist');
      await buildFixtureTo(remoteRoot, remoteOut, {
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: { './Module': path.join(remoteRoot, 'exposed-module.js') },
        hostInitInjectLocation: 'entry',
        shareStrategy: 'version-first',
        shared,
        dts: false,
      });
      const remoteChunks = await jsFiles(remoteOut);
      const localVueChunks = new Set<string>();
      for (const file of remoteChunks) {
        if ((await readFile(file, 'utf8')).includes('remote-vue-local-fallback')) {
          localVueChunks.add('/' + path.relative(remoteOut, file).replaceAll('\\', '/'));
        }
      }
      expect(localVueChunks.size).toBeGreaterThan(0);
      const remoteServer = await serveDirectory(remoteOut);
      servers.push(remoteServer);

      await writeFile(
        path.join(hostRoot, 'entry.js'),
        `
        import { provider } from 'vue';
        import('remote/Module').then(({ render }) => {
          document.querySelector('#app').textContent = provider + ' / ' + render();
        });
      `
      );
      const hostOut = path.join(workspace, 'host-dist');
      await buildFixtureTo(hostRoot, hostOut, {
        name: 'host',
        filename: 'remoteEntry.js',
        remotes: {
          remote: {
            name: 'remote',
            entry: remoteServer.origin + '/remoteEntry.js',
            type: 'module',
          },
        },
        hostInitInjectLocation: 'entry',
        shareStrategy: 'version-first',
        shared,
        dts: false,
      });
      const hostServer = await serveDirectory(hostOut);
      servers.push(hostServer);
      browser = await createBrowser();

      const hosted = await browser.newPage();
      const hostedErrors: string[] = [];
      const remoteRequests: string[] = [];
      hosted.on('pageerror', (error) => hostedErrors.push(error.message));
      hosted.on('request', (request) => {
        if (request.url().startsWith(remoteServer.origin))
          remoteRequests.push(new URL(request.url()).pathname);
      });
      await hosted.goto(hostServer.origin);
      await hosted.waitForFunction(
        () => document.querySelector('#app')?.textContent?.includes(' / '),
        undefined,
        { timeout: 15_000 }
      );
      expect(await hosted.locator('#app').textContent()).toBe(
        'host-vue-local-fallback / host-vue-local-fallback'
      );
      expect(hostedErrors).toEqual([]);
      const hostedEvaluations = await hosted.evaluate(() => (globalThis as any).__vueEvaluations);

      const standalone = await browser.newPage();
      const standaloneErrors: string[] = [];
      const standaloneRequests: string[] = [];
      standalone.on('pageerror', (error) => standaloneErrors.push(error.message));
      standalone.on('request', (request) =>
        standaloneRequests.push(new URL(request.url()).pathname)
      );
      await standalone.goto(remoteServer.origin);
      await standalone.waitForFunction(
        () => document.querySelector('#app')?.textContent?.includes('remote-vue'),
        undefined,
        { timeout: 15_000 }
      );
      expect(standaloneErrors).toEqual([]);
      expect(standaloneRequests.some((request) => localVueChunks.has(request))).toBe(true);
      expect(await standalone.evaluate(() => (globalThis as any).__vueEvaluations)).toEqual([
        'remote-vue-local-fallback',
      ]);

      expect(remoteRequests.filter((request) => localVueChunks.has(request))).toEqual([]);
      expect(hostedEvaluations).toEqual(['host-vue-local-fallback']);
    } finally {
      await browser?.close();
      for (const server of servers.reverse()) await server.close();
      await rm(workspace, { recursive: true, force: true });
      setPackageDetectionCwd(previousCwd);
    }
  }, 60_000);

  it('skips the installed remote Vue when hosted and hydrates with it standalone', async () => {
    const previousCwd = getPackageDetectionCwd();
    const workspace = await mkdtemp(path.join(tmpdir(), 'mf-entry-vue-hydration-'));
    const servers: StaticServer[] = [];
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;
    try {
      const root = path.join(workspace, 'remote-src');
      await mkdir(root, { recursive: true });
      await symlink(
        path.resolve('examples/vite-vite/vite-remote/node_modules'),
        path.join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'vue-remote', type: 'module' })
      );
      await writeFile(
        path.join(root, 'index.html'),
        '<!doctype html><div id="app"><span>server content</span></div><script type="module" src="/entry.js"></script>'
      );
      await writeFile(
        path.join(root, 'entry.js'),
        `
        import { createSSRApp, h } from 'vue';
        import { createMemoryHistory, createRouter } from 'vue-router';
        const router = createRouter({ history: createMemoryHistory(), routes: [] });
        const serverNode = document.querySelector('#app span');
        createSSRApp({
          mounted() {
            window.__hydrationProbe = {
              reused: serverNode === document.querySelector('#app span'),
              text: document.querySelector('#app span')?.textContent,
              routerReady: typeof router.resolve === 'function',
            };
          },
          render() { return h('span', 'server content'); },
        }).mount('#app');
      `
      );
      await writeFile(
        path.join(root, 'exposed-module.js'),
        `export { createSSRApp } from 'vue'; export { createRouter } from 'vue-router';`
      );
      const outDir = path.join(workspace, 'remote-dist');
      await buildFixtureTo(root, outDir, {
        name: 'vueHydrationRemote',
        filename: 'remoteEntry.js',
        exposes: { './Module': path.join(root, 'exposed-module.js') },
        hostInitInjectLocation: 'entry',
        shared: {
          vue: { singleton: true, requiredVersion: '^3.4.0' },
          'vue-router': { singleton: true, requiredVersion: '^4.0.0' },
        },
        dts: false,
      });
      const remoteVueChunks = (await jsFiles(outDir))
        .filter((file) => file.includes('__prebuild__'))
        .map((file) => '/' + path.relative(outDir, file).replaceAll('\\', '/'));
      expect(remoteVueChunks.length).toBe(2);
      const remoteServer = await serveDirectory(outDir);
      servers.push(remoteServer);

      const hostRoot = path.join(workspace, 'host-src');
      await mkdir(hostRoot, { recursive: true });
      await symlink(
        path.resolve('examples/vite-vite/vite-host/node_modules'),
        path.join(hostRoot, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await writeFile(
        path.join(hostRoot, 'package.json'),
        JSON.stringify({ name: 'vue-host', type: 'module' })
      );
      await writeFile(
        path.join(hostRoot, 'index.html'),
        '<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>'
      );
      await writeFile(
        path.join(hostRoot, 'entry.js'),
        `
        import { createSSRApp } from 'vue';
        import { createRouter } from 'vue-router';
        import('remote/Module').then(({ createSSRApp: remoteCreateSSRApp, createRouter: remoteCreateRouter }) => {
          window.__hostVueProbe = {
            sameProvider: remoteCreateSSRApp === createSSRApp,
            sameRouterProvider: remoteCreateRouter === createRouter,
          };
          document.querySelector('#app').textContent = 'hosted';
        });
      `
      );
      const hostOutDir = path.join(workspace, 'host-dist');
      await buildFixtureTo(hostRoot, hostOutDir, {
        name: 'vueHost',
        filename: 'remoteEntry.js',
        remotes: {
          remote: {
            name: 'vueHydrationRemote',
            entry: remoteServer.origin + '/remoteEntry.js',
            type: 'module',
          },
        },
        hostInitInjectLocation: 'entry',
        shareStrategy: 'version-first',
        shared: {
          vue: { singleton: true, requiredVersion: '^3.4.0', strictVersion: false },
          'vue-router': { singleton: true, requiredVersion: '^4.0.0', strictVersion: false },
        },
        dts: false,
      });
      const hostServer = await serveDirectory(hostOutDir);
      servers.push(hostServer);
      browser = await createBrowser();

      const hosted = await browser.newPage();
      const hostedErrors: string[] = [];
      const remoteRequests: string[] = [];
      hosted.on('pageerror', (error) => hostedErrors.push(error.message));
      hosted.on('request', (request) => {
        if (request.url().startsWith(remoteServer.origin))
          remoteRequests.push(new URL(request.url()).pathname);
      });
      await hosted.goto(hostServer.origin);
      await hosted.waitForFunction(() => (window as any).__hostVueProbe !== undefined, undefined, {
        timeout: 15_000,
      });
      expect(hostedErrors).toEqual([]);
      expect(await hosted.evaluate(() => (window as any).__hostVueProbe)).toEqual({
        sameProvider: true,
        sameRouterProvider: true,
      });
      expect(remoteRequests.filter((request) => remoteVueChunks.includes(request))).toEqual([]);

      const page = await browser.newPage();
      const pageErrors: string[] = [];
      const standaloneRequests: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('request', (request) => {
        if (request.url().startsWith(remoteServer.origin)) {
          standaloneRequests.push(new URL(request.url()).pathname);
        }
      });
      await page.goto(remoteServer.origin);
      await page.waitForFunction(() => (window as any).__hydrationProbe !== undefined, undefined, {
        timeout: 15_000,
      });
      expect(pageErrors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__hydrationProbe)).toEqual({
        reused: true,
        text: 'server content',
        routerReady: true,
      });
      expect(
        standaloneRequests.filter((request) => remoteVueChunks.includes(request)).sort()
      ).toEqual([...remoteVueChunks].sort());
    } finally {
      await browser?.close();
      for (const server of servers.reverse()) await server.close();
      await rm(workspace, { recursive: true, force: true });
      setPackageDetectionCwd(previousCwd);
    }
  }, 60_000);
});
