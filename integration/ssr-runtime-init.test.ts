import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build, createServer, version, type Rollup, type InlineConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { federation } from '../src';
import { createBrowser, serveDirectory } from './helpers/browser';

vi.mock('../src/utils/packageUtils', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/packageUtils')>(
    '../src/utils/packageUtils'
  );
  return {
    ...actual,
    resolveImportPath(id: string) {
      return id === '@module-federation/vite/ssrEntryLoader'
        ? fileURLToPath(new URL('../src/utils/ssrEntryLoader.ts', import.meta.url))
        : actual.resolveImportPath(id);
    },
  };
});

const cleanup: Array<() => Promise<unknown>> = [];
type Application = { root: string; name: string; config: InlineConfig };
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function directory() {
  const root = await mkdtemp(path.join(import.meta.dirname, '.ssr-runtime-init-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  return root;
}

async function remote(target: string) {
  const requests: string[] = [];
  const server = createHttpServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('content-type', 'text/javascript');
    response.setHeader('access-control-allow-origin', '*');
    response.end(`const exposes = [];
      export function init() {}
      export function get(expose) {
        exposes.push(expose);
        if (expose !== './value') throw new Error('Unexpected expose: ' + expose);
        return () => ({ target: ${JSON.stringify(target)}, exposes: () => exposes.slice() });
      }`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  const address = server.address() as { port: number };
  return { entry: `http://127.0.0.1:${address.port}/remoteEntry.js`, requests };
}

async function application(
  entry: string,
  shareStrategy: 'version-first' | 'loaded-first' = 'version-first',
  exposes = false,
  hostInitInjectLocation: 'html' | 'entry' = 'html'
): Promise<Application> {
  const root = await directory();
  const name = path.basename(root);
  await writeFile(
    path.join(root, 'probe.js'),
    `
    import { getInstance, loadRemote } from '@module-federation/runtime';
    export const ownerAtEvaluation = getInstance()?.name;
    export function initCount() { return globalThis.__mfTestInitCounts?.[${JSON.stringify(name)}] ?? 0; }
    const original = getInstance();
    export async function probe() {
      const mod = await loadRemote(['products', 'value'].join('/'));
      return { ownerAtEvaluation, owner: getInstance()?.name,
        sameInstance: original === getInstance(), target: mod.target, exposes: mod.exposes() };
    }
  `
  );
  const counter = path.join(root, 'counter.js');
  await writeFile(
    counter,
    `export default () => ({ name: 'test-count-init', beforeInit(args) {
    globalThis.__mfTestInitCounts ??= {};
    globalThis.__mfTestInitCounts[${JSON.stringify(name)}] = (globalThis.__mfTestInitCounts[${JSON.stringify(name)}] ?? 0) + 1;
    return args;
  } });`
  );
  await writeFile(
    path.join(root, 'client.js'),
    `import * as probe from './probe.js'; globalThis.runtimeProbe = probe;`
  );
  await writeFile(
    path.join(root, 'index.html'),
    '<script type="module" src="/client.js"></script>'
  );
  await writeFile(path.join(root, 'transformed.js'), `export { target } from 'products/value';`);
  const pkg = path.join(root, 'node_modules/products');
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), '{"name":"products","main":"index.js"}');
  await writeFile(path.join(pkg, 'index.js'), 'throw new Error("npm collision");');
  return {
    root,
    name,
    config: {
      root,
      configFile: false as const,
      logLevel: 'silent' as const,
      plugins: [
        federation({
          name,
          filename: 'remoteEntry.js',
          remotes: { products: { name: 'products', type: 'module', entry } },
          dts: false,
          shareStrategy,
          hostInitInjectLocation,
          runtimePlugins: [counter],
          exposes: exposes ? { './probe': path.join(root, 'probe.js') } : {},
        }),
      ],
    },
  };
}

async function buildApplication(app: Application) {
  const output = (await build({
    ...app.config,
    build: { ssr: path.join(app.root, 'probe.js'), minify: false, target: 'node20' },
  })) as Rollup.RollupOutput;
  const entry = output.output.find(
    (chunk) => chunk.type === 'chunk' && chunk.exports.includes('probe')
  )!;
  return pathToFileURL(path.join(app.root, 'dist', entry.fileName)).href;
}

async function deploy(app: Application, mode: 'dev' | 'ssr' | 'client') {
  if (mode === 'dev') {
    const server = await createServer({ ...app.config, server: { port: 0, cors: true } });
    cleanup.push(() => server.close());
    await server.listen();
    return server.resolvedUrls!.local[0];
  }
  if (mode === 'ssr') await buildApplication(app);
  else await build(app.config);
  const server = await serveDirectory(path.join(app.root, 'dist'));
  cleanup.push(server.close);
  return `${server.origin}/`;
}

async function topology(
  mode: 'dev' | 'ssr' | 'client',
  strategy: 'version-first' | 'loaded-first' = 'version-first'
) {
  const child = await application('http://unused');
  await writeFile(
    path.join(child.root, 'value.js'),
    `export const target = 'child'; export const exposes = () => ['./value'];`
  );
  await writeFile(path.join(child.root, 'probe.js'), 'export function probe() {}');
  child.config.plugins = [
    federation({
      name: child.name,
      filename: 'remoteEntry.js',
      exposes: { './value': path.join(child.root, 'value.js') },
      dts: false,
    }),
  ];
  const childOrigin = await deploy(child, mode);
  const parent = await application(`${childOrigin}remoteEntry.js`, strategy, true);
  const parentOrigin = await deploy(parent, mode);
  const host = await application(`${parentOrigin}remoteEntry.js`, strategy);
  await writeFile(
    path.join(host.root, 'probe.js'),
    `
    import { getInstance, loadRemote } from '@module-federation/runtime';
    export const ownerAtEvaluation = getInstance()?.name;
    export async function probe() {
      const parent = await loadRemote(['products', 'probe'].join('/'));
      return { owner: getInstance()?.name, ownerAtEvaluation, remote: await parent.probe() };
    }
  `
  );
  return { host, parent };
}

function expectTopology(result: any, host: Application, parent: Application) {
  expect(result).toEqual({
    owner: host.name,
    ownerAtEvaluation: host.name,
    remote: {
      owner: parent.name,
      ownerAtEvaluation: parent.name,
      sameInstance: true,
      target: 'child',
      exposes: ['./value'],
    },
  });
}

describe('plain runtime API during SSR startup', () => {
  it.runIf(Number(version.split('.')[0]) >= 8).each(['virtual', 'workspace'] as const)(
    'initializes cold dev SSR from a %s entry before a top-level runtime call',
    async (kind) => {
      const target = await remote(kind);
      const app = await application(target.entry);
      const code = `
        import { getInstance, loadRemote } from '@module-federation/runtime';
        export const owner = getInstance()?.name;
        export const value = (await loadRemote('products/value')).target;
      `;
      let entry = 'virtual:ssr-runtime-probe';
      if (kind === 'virtual') {
        app.config.plugins!.unshift({
          name: 'ssr-runtime-probe',
          resolveId(id) {
            if (id === entry) return '\0' + entry;
          },
          load(id) {
            if (id === '\0' + entry) return code;
          },
        });
      } else {
        entry = path.join(await directory(), 'probe.js');
        await writeFile(entry, code);
      }
      const server = await createServer(app.config);
      cleanup.push(() => server.close());
      const result = await server.ssrLoadModule(entry);
      expect(result.owner).toBe(app.name);
      expect(result.value).toBe(kind);
    }
  );

  it.runIf(Number(version.split('.')[0]) >= 8)(
    'keeps two cold dev SSR owners independent',
    async () => {
      const first = await application((await remote('first')).entry);
      const second = await application((await remote('second')).entry);
      const firstServer = await createServer(first.config);
      cleanup.push(() => firstServer.close());
      const secondServer = await createServer(second.config);
      cleanup.push(() => secondServer.close());
      const firstProbe = await firstServer.ssrLoadModule('/probe.js');
      const secondProbe = await secondServer.ssrLoadModule('/probe.js');
      expect((await firstProbe.probe()).owner).toBe(first.name);
      expect((await secondProbe.probe()).owner).toBe(second.name);
    }
  );

  it.runIf(Number(version.split('.')[0]) >= 8)(
    'keeps H → A → C ownership during cold dev SSR',
    async () => {
      const { host, parent } = await topology('dev');
      const server = await createServer(host.config);
      cleanup.push(() => server.close());
      const probe = await server.ssrLoadModule('/probe.js');
      expectTopology(await probe.probe(), host, parent);
    },
    30_000
  );

  it.each(['version-first', 'loaded-first'] as const)(
    'keeps H → A → C ownership in independent SSR builds (%s)',
    async (strategy) => {
      const { host, parent } = await topology('ssr', strategy);
      const url = await buildApplication(host);
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--input-type=module',
        '--eval',
        `const entry = await import(${JSON.stringify(url)}); console.log(JSON.stringify(await entry.probe()));`,
      ]);
      expectTopology(JSON.parse(stdout.trim()), host, parent);
    },
    30_000
  );

  it.each(['dev', 'client'] as const)(
    'preserves nested plain runtime calls on the %s client',
    async (mode) => {
      const { host, parent } = await topology(mode);
      const origin = await deploy(host, mode);
      const browser = await createBrowser();
      cleanup.push(() => browser.close());
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(origin);
      await page.waitForFunction('globalThis.runtimeProbe !== undefined');
      expectTopology(await page.evaluate('globalThis.runtimeProbe.probe()'), host, parent);
      expect(errors).toEqual([]);
    },
    30_000
  );

  it.each(['html', 'entry'] as const)(
    'does not add an SSR host bootstrap without remotes (%s)',
    async (hostInitInjectLocation) => {
      const root = await directory();
      await writeFile(path.join(root, 'probe.js'), 'export const value = 42;');
      const output = (await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [federation({ name: path.basename(root), dts: false, hostInitInjectLocation })],
        build: { ssr: path.join(root, 'probe.js'), write: false },
      })) as Rollup.RollupOutput;
      expect(
        output.output
          .filter((chunk) => chunk.type === 'chunk')
          .some((chunk) => Object.keys(chunk.modules).some((id) => id.includes('__H_A_I__')))
      ).toBe(false);
    }
  );

  it.runIf(Number(version.split('.')[0]) >= 8).each(['version-first', 'loaded-first'] as const)(
    'initializes cold development SSR without fetching remotes (%s)',
    async (strategy) => {
      const target = await remote('dev');
      const app = await application(target.entry, strategy);
      const server = await createServer({ ...app.config, server: { port: 0 } });
      cleanup.push(() => server.close());
      const probe = await server.ssrLoadModule('/probe.js');
      expect(probe.ownerAtEvaluation).toBe(app.name);
      expect(target.requests).toEqual([]);
      expect(probe.initCount()).toBe(1);
      expect(await probe.probe()).toEqual({
        ownerAtEvaluation: app.name,
        owner: app.name,
        sameInstance: true,
        target: 'dev',
        exposes: ['./value'],
      });
      const instance = (await server.ssrLoadModule('/probe.js')).ownerAtEvaluation;
      await server.ssrLoadModule('/transformed.js');
      expect(probe.ownerAtEvaluation).toBe(instance);
      expect((await probe.probe()).sameInstance).toBe(true);
      expect(probe.initCount()).toBe(1);
    },
    30_000
  );

  it.each(['version-first', 'loaded-first'] as const)(
    'initializes independent SSR builds and keeps owners separate (%s)',
    async (strategy) => {
      const firstRemote = await remote('first');
      const secondRemote = await remote('second');
      const first = await application(firstRemote.entry, strategy);
      const second = await application(secondRemote.entry, strategy, false, 'entry');
      const firstUrl = await buildApplication(first);
      const secondUrl = await buildApplication(second);
      const execution = promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
        const first = await import(${JSON.stringify(firstUrl)});
        const second = await import(${JSON.stringify(secondUrl)});
        console.log(JSON.stringify({ owners: [first.ownerAtEvaluation, second.ownerAtEvaluation] }));
        await new Promise(resolve => process.stdin.once('data', resolve));
        console.log(JSON.stringify([await first.probe(), await second.probe()]));
        console.log(JSON.stringify([first.initCount(), second.initCount()]));
      `,
        ],
        { timeout: 15_000 }
      );
      let initialRequests: number[] = [];
      execution.child.stdout!.once('data', () => {
        initialRequests = [firstRemote.requests.length, secondRemote.requests.length];
        execution.child.stdin!.end('\n');
      });
      const { stdout } = await execution;
      expect(initialRequests).toEqual([0, 0]);
      const [owners, results, counts] = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(owners).toEqual({ owners: [first.name, second.name] });
      expect(counts).toEqual([1, 1]);
      expect(results).toEqual([
        {
          ownerAtEvaluation: first.name,
          owner: first.name,
          sameInstance: true,
          target: 'first',
          exposes: ['./value'],
        },
        {
          ownerAtEvaluation: second.name,
          owner: second.name,
          sameInstance: true,
          target: 'second',
          exposes: ['./value'],
        },
      ]);
    },
    30_000
  );
});
