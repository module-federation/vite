import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build, createServer, version, type Plugin, type Rollup } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { federation, type ModuleFederationPluginApi } from '../src';
import { createBrowser, serveDirectory } from './helpers/browser';

vi.mock('../src/utils/packageUtils', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/packageUtils')>(
    '../src/utils/packageUtils'
  );
  return {
    ...actual,
    resolveImportPath(specifier: string) {
      return specifier === '@module-federation/vite/ssrEntryLoader'
        ? fileURLToPath(new URL('../src/utils/ssrEntryLoader.ts', import.meta.url))
        : actual.resolveImportPath(specifier);
    },
  };
});

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// This integration only uses the public plugin API, never remote resolution.
function applicationRuntime(): Plugin {
  const id = 'virtual:application-runtime';
  let hostInitId: string;
  return {
    name: 'application-runtime',
    configResolved(config) {
      const api = config.plugins.find((plugin) => plugin.name === 'module-federation-vite')
        ?.api as ModuleFederationPluginApi;
      hostInitId = api.moduleFederation.getHostInitImportId();
    },
    resolveId(source) {
      if (source === id) return `\0${id}`;
    },
    load(source) {
      if (source !== `\0${id}`) return;
      return `export async function loadApplicationRemote(request) {
        const bootstrap = await import(${JSON.stringify(hostInitId)});
        await bootstrap.__tla;
        const runtime = await bootstrap.hostInitPromise;
        return runtime.loadRemote(request);
      }`;
    },
  };
}

async function directory() {
  const root = await mkdtemp(path.join(import.meta.dirname, '.host-bootstrap-api-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  return root;
}

async function remote(target: string) {
  const root = await directory();
  const code = `const requests = [];
    export function init() {}
    export function get(expose) {
      requests.push(expose);
      if (expose !== './App') throw new Error('Unexpected expose: ' + expose);
      return () => ({ target: ${JSON.stringify(target)}, requests: () => [...requests] });
    }`;
  await writeFile(path.join(root, 'remoteEntry.js'), code);
  await writeFile(path.join(root, 'remoteEntry.ssr.js'), code);
  const server = await serveDirectory(root);
  cleanup.push(server.close);
  return `${server.origin}/remoteEntry.js`;
}

async function application(name: string, entry: string, nested = false) {
  const root = await directory();
  await writeFile(
    path.join(root, 'entry.js'),
    `export { loadApplicationRemote } from './runtime.js';`
  );
  await writeFile(
    path.join(root, 'runtime.js'),
    `export { loadApplicationRemote } from 'virtual:application-runtime';`
  );
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="/entry.js"></script>');
  // A bare resolver probe could pick up this package instead of the remote.
  const pkg = path.join(root, 'node_modules/products');
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), '{"name":"products","main":"index.js"}');
  await writeFile(path.join(pkg, 'index.js'), 'throw new Error("npm collision");');
  if (nested) {
    await writeFile(
      path.join(root, 'App.js'),
      `import { loadApplicationRemote } from 'virtual:application-runtime';
       export const target = 'parent';
       export async function child() {
         const mod = await loadApplicationRemote(['products', 'App'].join('/'));
         return { target: mod.target, requests: mod.requests() };
       }`
    );
  }
  return {
    root,
    configFile: false as const,
    logLevel: 'silent' as const,
    plugins: [
      federation({
        name,
        remotes: { products: { name: 'products', type: 'module', entry } },
        exposes: nested ? { './App': path.join(root, 'App.js') } : {},
        hostInitInjectLocation: 'entry',
        dts: false,
      }),
      applicationRuntime(),
    ],
  };
}

async function development(config: Awaited<ReturnType<typeof application>>) {
  const server = await createServer({ ...config, server: { port: 0, cors: true } });
  cleanup.push(() => server.close());
  await server.listen();
  return server;
}

describe('application-owned host bootstrap', () => {
  it('loads cold development remotes with independent owners, nesting and npm collisions', async () => {
    const firstEntry = await remote('first');
    const secondEntry = await remote('second');
    const parent = await development(await application('bootstrap-parent', secondEntry, true));
    const first = await development(
      await application('bootstrap-first', `${parent.resolvedUrls!.local[0]}remoteEntry.js`)
    );
    const second = await development(await application('bootstrap-second', firstEntry));
    const browser = await createBrowser();
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(first.resolvedUrls!.local[0]);
    // Keep these imports in browser code so Vitest does not rewrite them for SSR.
    const result = await page.evaluate(`(async () => {
        const first = await import(${JSON.stringify(`${first.resolvedUrls!.local[0]}runtime.js`)});
        const second = await import(${JSON.stringify(`${second.resolvedUrls!.local[0]}runtime.js`)});
        const request = ['products', 'App'].join('/');
        const parent = await first.loadApplicationRemote(request);
        const other = await second.loadApplicationRemote(request);
        return {
          parent: parent.target,
          child: await parent.child(),
          other: other.target,
          requests: other.requests(),
        };
      })()`);

    expect(result).toEqual({
      parent: 'parent',
      child: { target: 'second', requests: ['./App'] },
      other: 'first',
      requests: ['./App'],
    });
    expect(errors).toEqual([]);
  }, 30_000);

  it('loads a computed remote request in a production client build', async () => {
    const config = await application('bootstrap-client-build', await remote('client-build'));
    await writeFile(
      path.join(config.root, 'entry.js'),
      `import { loadApplicationRemote } from 'virtual:application-runtime';
       globalThis.bootstrapResult = loadApplicationRemote(['products', 'App'].join('/'))
         .then(mod => ({ target: mod.target, requests: mod.requests() }));`
    );
    await build(config);
    const server = await serveDirectory(path.join(config.root, 'dist'));
    cleanup.push(server.close);
    const browser = await createBrowser();
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    await page.goto(server.origin);
    await page.waitForFunction('globalThis.bootstrapResult !== undefined');

    expect(await page.evaluate('globalThis.bootstrapResult')).toEqual({
      target: 'client-build',
      requests: ['./App'],
    });
  }, 30_000);

  it.runIf(Number(version.split('.')[0]) >= 8)(
    'loads cold development SSR without transforming HTML or a client entry',
    async () => {
      const server = await development(
        await application('bootstrap-cold-ssr', await remote('ssr-dev'))
      );
      const html = vi.spyOn(server, 'transformIndexHtml');
      const entry = await server.ssrLoadModule('/entry.js');
      const mod = await entry.loadApplicationRemote(['products', 'App'].join('/'));

      expect(mod.target).toBe('ssr-dev');
      expect(mod.requests()).toEqual(['./App']);
      expect(html).not.toHaveBeenCalled();
      expect(server.environments.client.moduleGraph.idToModuleMap.size).toBe(0);
    },
    30_000
  );

  it('loads an independent SSR build without a preceding client build', async () => {
    const config = await application('bootstrap-ssr-build', await remote('ssr-build'));
    const output = (await build({
      ...config,
      build: { ssr: path.join(config.root, 'entry.js'), minify: false },
    })) as Rollup.RollupOutput;
    // Vite 5 wraps the SSR entry. Run its exported module in a fresh Node
    // process so Vitest cannot rewrite emitted relative chunk imports.
    const entry = output.output.find(
      (chunk) => chunk.type === 'chunk' && chunk.exports.includes('loadApplicationRemote')
    )!;
    const url = pathToFileURL(path.join(config.root, 'dist', entry.fileName)).href;
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      `const entry = await import(${JSON.stringify(url)});
       const mod = await entry.loadApplicationRemote(['products', 'App'].join('/'));
       console.log(JSON.stringify({ target: mod.target, requests: mod.requests() }));`,
    ]);

    expect(JSON.parse(stdout.trim())).toEqual({ target: 'ssr-build', requests: ['./App'] });
  }, 30_000);
});
