import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, createServer, type Rollup, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { federation } from '../src';
import { SHARE_MODULE_PREFIX } from '../src/utils/hostProvidesAllShared';
import { createBrowser, serveDirectory, type StaticServer } from './helpers/browser';
import { findAsset, getHtmlAsset } from './helpers/matchers';

const SHARED = { 'shared-base': {}, 'esm-dep': {}, 'esm-default-dep': {}, 'cjs-dep': {} };
const EXPERIMENTS = { hostProvidesAllShared: true };

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

/** A package in `<root>/node_modules`; `type` and `index` decide its module format. */
function dependency(name: string, index: string, type: 'module' | 'commonjs' = 'module') {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version: '1.0.0',
      type,
      main: 'index.js',
    }),
    [`node_modules/${name}/index.js`]: index,
  };
}

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'mf-importmap-mode-'));
  const remote = path.join(workspace, 'remote');
  const host = path.join(workspace, 'host');

  await writeFiles(remote, {
    'package.json': JSON.stringify({ name: 'remote', type: 'module' }),
    'helper.js': `export const helper = () => 'helper';`,
    // Reads a shared value at module-evaluation time: works only with static imports.
    'Widget.js': `import { SharedBase, instance } from 'shared-base';
import { helper } from './helper.js';
export class Widget extends SharedBase {
  render() { return this.base() + ':' + helper(); }
}
export const sharedInstance = instance;
`,
    'index.js': `import { helper } from './helper.js';\nexport const root = helper();\n`,
    ...dependency('shared-base', `export const extra = 'extra';`),
    'node_modules/shared-base/extra.js': `export const extra = 'extra';`,
  });

  await writeFiles(host, {
    'package.json': JSON.stringify({ name: 'host', type: 'module' }),
    'index.html': `<!doctype html><html><head></head><body><div id="app"></div>
<script type="module" src="/entry.js"></script></body></html>`,
    'entry.js': `import { instance } from 'shared-base';
import { named } from 'esm-dep';
import esmDefault from 'esm-default-dep';
import cjs from 'cjs-dep';

import('importMapRemote/Widget').then(({ Widget, sharedInstance }) => {
  window.__result = {
    rendered: new Widget().render(),
    sameInstance: sharedInstance === instance,
    values: [named, esmDefault, cjs.cjs],
  };
  document.querySelector('#app').textContent = window.__result.rendered;
});
`,
    ...dependency(
      'shared-base',
      `export class SharedBase { base() { return 'base'; } }\nexport const instance = { id: Math.random() };`
    ),
    ...dependency('esm-dep', `export const named = 'named';`),
    ...dependency('esm-default-dep', `export default 'esm-default';\nexport const other = 1;`),
    ...dependency('cjs-dep', `module.exports = { cjs: 'cjs-value', other: 2 };`, 'commonjs'),
  });

  return { workspace, remote, host };
}

type Workspace = Awaited<ReturnType<typeof createWorkspace>>;

async function buildApp(
  root: string,
  mfOptions: Parameters<typeof federation>[0],
  { base = '/', outDir }: { base?: string; outDir?: string } = {}
): Promise<Rollup.RollupOutput> {
  const result = await build({
    root,
    base,
    logLevel: 'silent',
    build: {
      outDir: outDir ?? path.join(root, 'dist'),
      emptyOutDir: true,
      minify: false,
      target: 'chrome91',
    },
    plugins: [federation({ dts: false, ...mfOptions })],
  });
  if (Array.isArray(result)) throw new Error('Expected a single Rollup output');
  return result;
}

const buildRemote = (ws: Workspace, base = '/') =>
  buildApp(
    ws.remote,
    {
      name: 'importMapRemote',
      exposes: { '.': './index.js', './Widget': './Widget.js' },
      shared: { 'shared-base': {} },
      experiments: EXPERIMENTS,
    },
    { base }
  );

const buildHost = (ws: Workspace) =>
  buildApp(ws.host, {
    name: 'importMapHost',
    remotes: { importMapRemote: path.join(ws.remote, 'dist/mf-manifest.json') },
    shared: SHARED,
    experiments: EXPERIMENTS,
  });

function importMapOf(html: string): Record<string, string> {
  const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  expect(match, 'import map tag').toBeTruthy();
  return JSON.parse(match![1]).imports;
}

const chunks = (output: Rollup.RollupOutput): Rollup.OutputChunk[] =>
  output.output.filter((item): item is Rollup.OutputChunk => item.type === 'chunk');

describe('experiments.hostProvidesAllShared', () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await createWorkspace();
  });
  afterAll(() => rm(ws.workspace, { recursive: true, force: true }));

  describe('remote build', () => {
    let output: Rollup.RollupOutput;
    beforeAll(async () => {
      output = await buildRemote(ws, 'http://remote.test/app/');
    });

    it('emits one fixed-name entry per expose, keeping shared imports bare', () => {
      const widget = chunks(output).find((chunk) => chunk.fileName === 'Widget.js');
      expect(widget?.isEntry).toBe(true);
      expect(widget?.code).toMatch(/from\s*["']shared-base["']/);
      expect(widget?.exports.sort()).toEqual(['Widget', 'sharedInstance']);
      expect(chunks(output).find((chunk) => chunk.fileName === 'index.js')?.isEntry).toBe(true);
      expect(output.output.find((item) => item.fileName.includes('remoteEntry'))).toBeUndefined();
    });

    it('writes a standard mf-manifest.json without a remoteEntry', () => {
      const manifest = JSON.parse(String(findAsset(output, 'mf-manifest.json')?.source));
      expect(manifest.metaData.remoteEntry).toBeUndefined();
      expect(manifest.metaData).toMatchObject({
        name: 'importMapRemote',
        type: 'app',
        publicPath: 'http://remote.test/app/',
      });
      expect(manifest.shared).toEqual([]);
      expect(manifest.exposes).toEqual([
        {
          id: 'importMapRemote:index',
          name: 'index',
          path: '.',
          assets: { js: { sync: ['index.js'], async: [] }, css: { sync: [], async: [] } },
        },
        {
          id: 'importMapRemote:Widget',
          name: 'Widget',
          path: './Widget',
          assets: { js: { sync: ['Widget.js'], async: [] }, css: { sync: [], async: [] } },
        },
      ]);
    });

    it('warns when a remote bundles an unshared subpath of a shared package', async () => {
      await writeFiles(ws.remote, {
        'Extra.js': `import { extra } from 'shared-base/extra';\nexport const value = extra;\n`,
      });
      const warnings: string[] = [];
      await build({
        root: ws.remote,
        logLevel: 'silent',
        build: { write: false, minify: false },
        customLogger: {
          ...console,
          hasWarned: false,
          hasErrorLogged: () => false,
          clearScreen: () => {},
          warnOnce: () => {},
          info: () => {},
          error: () => {},
          warn: (message: string) => warnings.push(message),
        },
        plugins: [
          federation({
            name: 'importMapRemote',
            dts: false,
            exposes: { './Extra': './Extra.js' },
            shared: { 'shared-base': {} },
            experiments: EXPERIMENTS,
          }),
        ],
      });
      expect(warnings.join('\n')).toContain('"shared-base/extra"');
      expect(warnings.join('\n')).toContain('Add it to `shared`');
    });
  });

  describe('host build', () => {
    let output: Rollup.RollupOutput;
    let imports: Record<string, string>;
    beforeAll(async () => {
      await buildRemote(ws, 'http://remote.test/app/');
      output = await buildHost(ws);
      imports = importMapOf(String(getHtmlAsset(output)?.source));
    });

    it('maps every remote expose from the manifest and every shared key to a host chunk', () => {
      expect(imports.importMapRemote).toBe('http://remote.test/app/index.js');
      expect(imports['importMapRemote/Widget']).toBe('http://remote.test/app/Widget.js');
      for (const key of Object.keys(SHARED)) {
        expect(imports[key], key).toMatch(/^\/assets\/shared\/[\w-]+-[\w-]+\.js$/);
        expect(chunks(output).find((chunk) => `/${chunk.fileName}` === imports[key])?.isEntry).toBe(
          true
        );
      }
    });

    it('keeps remote specifiers as bare imports for the browser to resolve', () => {
      const entry = chunks(output).find(
        (chunk) => chunk.isEntry && !chunk.name.startsWith('shared/')
      );
      expect(entry?.code).toMatch(/import\(["']importMapRemote\/Widget["']\)/);
    });

    it('re-exports default and CommonJS names so remotes can import them statically', () => {
      const shareChunk = (key: string) =>
        chunks(output).find((chunk) => chunk.facadeModuleId === `${SHARE_MODULE_PREFIX}${key}`);
      expect(shareChunk('esm-dep')?.exports).toEqual(['named']);
      expect(shareChunk('esm-default-dep')?.exports.sort()).toEqual(['default', 'other']);
      expect(shareChunk('cjs-dep')?.exports.sort()).toEqual(['cjs', 'default', 'other']);
    });

    it('generates no Module Federation runtime glue', () => {
      const code = chunks(output)
        .map((chunk) => chunk.code)
        .join('\n');
      expect(code).not.toContain('loadShare');
      expect(code).not.toContain('__prebuild__');
      expect(code).not.toContain('@module-federation/runtime');
    });
  });

  describe('dev server', () => {
    let server: ViteDevServer;
    const shareId = (key: string) => `/@id/__x00__${SHARE_MODULE_PREFIX.slice(1)}${key}`;
    beforeAll(async () => {
      await buildRemote(ws, 'http://remote.test/app/');
      server = await createServer({
        root: ws.host,
        logLevel: 'silent',
        server: { middlewareMode: true },
        // No browser drives this server: pre-bundle the shares up front so nothing waits
        // on the crawl-triggered discovery run.
        optimizeDeps: { include: Object.keys(SHARED), noDiscovery: true },
        plugins: [
          federation({
            name: 'importMapHost',
            dts: false,
            remotes: { importMapRemote: path.join(ws.remote, 'dist/mf-manifest.json') },
            shared: SHARED,
            experiments: EXPERIMENTS,
          }),
        ],
      });
    });
    afterAll(() => server?.close());

    it('injects an import map pointing shared keys at virtual re-export modules', async () => {
      const html = await server.transformIndexHtml(
        '/index.html',
        await readFile(path.join(ws.host, 'index.html'), 'utf8')
      );
      const imports = importMapOf(html);
      expect(imports['importMapRemote/Widget']).toBe('http://remote.test/app/Widget.js');
      expect(imports['esm-dep']).toBe(shareId('esm-dep'));
      expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('type="module"'));
    });

    it('serves re-export modules that forward default and CommonJS names', async () => {
      // The middleware unwraps `/@id/__x00__<id>` to `\0<id>` before transforming.
      const esm = await server.transformRequest(`${SHARE_MODULE_PREFIX}esm-dep`);
      expect(esm?.code).toMatch(/export \* from ["']\/node_modules\/\.vite\/deps\/esm-dep\.js/);
      expect(esm?.code).not.toContain('default');

      const esmDefault = await server.transformRequest(`${SHARE_MODULE_PREFIX}esm-default-dep`);
      expect(esmDefault?.code).toMatch(/export \{ default \} from/);

      const cjs = await server.transformRequest(`${SHARE_MODULE_PREFIX}cjs-dep`);
      expect(cjs?.code).toContain('export const { cjs, other } = __mf_cjs');
    });

    it('resolves remote specifiers straight to the mapped URL', async () => {
      const entry = await server.transformRequest('/entry.js');
      expect(entry?.code).toContain('import("http://remote.test/app/Widget.js")');
    });
  });

  describe('browser', () => {
    let remoteServer: StaticServer;
    let hostServer: StaticServer;
    let browser: Awaited<ReturnType<typeof createBrowser>> | undefined;

    beforeAll(async () => {
      await mkdir(path.join(ws.remote, 'dist'), { recursive: true });
      remoteServer = await serveDirectory(path.join(ws.remote, 'dist'));
      await buildRemote(ws, `${remoteServer.origin}/`);
      await buildHost(ws);
      hostServer = await serveDirectory(path.join(ws.host, 'dist'));
      browser = await createBrowser();
    }, 30_000);
    afterAll(async () => {
      await browser?.close();
      await hostServer?.close();
      await remoteServer?.close();
    });

    it('loads a remote that extends a shared class at eval time on one shared instance', async () => {
      const page = await browser!.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(hostServer.origin);
      await page.waitForFunction(() => (window as any).__result, undefined, { timeout: 10_000 });
      const value = await page.evaluate(() => (window as any).__result);

      expect(errors).toEqual([]);
      expect(value).toEqual({
        rendered: 'base:helper',
        sameInstance: true,
        values: ['named', 'esm-default', 'cjs-value'],
      });
    }, 15_000);
  });
});
