import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createBuilder, version, type Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { federation } from '../src';

const HANDLER_MARKER = 'LEAK_MARKER_HANDLER_BODY';
const CALLER_MARKER = 'RPC_CALLER_MARKER';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/**
 * Stands in for a framework compiler such as TanStack Start's: the app's
 * server environment keeps the server function handler (it is the provider),
 * every other environment it compiles gets an RPC caller instead.
 */
function serverFunctionCompiler(callerEnvironments: string[]): Plugin {
  return {
    name: 'test:server-function-compiler',
    transform(code, id) {
      if (!id.endsWith('serverFn.js')) return;
      if (this.environment.name === 'ssr') return;
      if (this.environment.name === 'client' || callerEnvironments.includes(this.environment.name))
        return `export const askServer = () => ${JSON.stringify(CALLER_MARKER)};`;
      this.error(`server function compiled in unexpected environment ${this.environment.name}`);
    },
  };
}

async function remoteApp() {
  const root = await mkdtemp(path.join(import.meta.dirname, '.ssr-dedicated-env-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(root, 'serverFn.js'),
    `export const askServer = () => process.env.INTERNAL_PRICING_URL ?? ${JSON.stringify(HANDLER_MARKER)};`
  );
  await writeFile(
    path.join(root, 'StatusCard.js'),
    `import { askServer } from './serverFn.js';\nexport const status = () => askServer();`
  );
  await writeFile(
    path.join(root, 'server.js'),
    `import { askServer } from './serverFn.js';\nexport const render = () => askServer();`
  );
  await writeFile(path.join(root, 'client.js'), `import './StatusCard.js';`);
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="/client.js"></script>');
  return root;
}

async function readTree(directory: string) {
  const files = new Map<string, string>();
  if (!existsSync(directory)) return files;
  for (const file of await readdir(directory, { recursive: true })) {
    if (file.endsWith('.js') || file.endsWith('.json')) {
      files.set(file, await readFile(path.join(directory, file), 'utf8').catch(() => ''));
    }
  }
  return files;
}

async function build(
  root: string,
  { ssrEnvironment, frameworkBuildApp }: { ssrEnvironment?: string; frameworkBuildApp?: boolean }
) {
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: 'silent',
    builder: frameworkBuildApp
      ? {
          // Like TanStack Start: build the app's environments only.
          async buildApp(builder) {
            await builder.build(builder.environments.client);
            await builder.build(builder.environments.ssr);
          },
        }
      : {},
    plugins: [
      serverFunctionCompiler(ssrEnvironment ? [ssrEnvironment] : []),
      federation({
        name: 'statusRemote',
        filename: 'remoteEntry.js',
        exposes: { './StatusCard': './StatusCard.js' },
        ssrEnvironment,
        manifest: true,
        dts: false,
      }),
    ],
    build: { minify: false },
    environments: {
      client: { build: { outDir: 'dist/client' } },
      ssr: {
        build: {
          outDir: 'dist/server',
          rollupOptions: { input: path.join(root, 'server.js') },
        },
      },
    },
  });
  await builder.buildApp();
  return builder;
}

async function getExpose(entry: string) {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    `const container = await import(${JSON.stringify(pathToFileURL(entry).href)});
    await container.init({});
    const factory = await container.get('./StatusCard');
    console.log(factory().status());`,
  ]);
  return stdout.trim();
}

describe.runIf(Number(version.split('.')[0]) >= 7)('ssrEnvironment', () => {
  it('publishes server-only code from the app server bundle by default', async () => {
    const root = await remoteApp();
    await build(root, {});

    const client = await readTree(path.join(root, 'dist/client'));
    expect(client.has('remoteEntry.ssr.js')).toBe(true);
    expect([...client.values()].some((code) => code.includes(HANDLER_MARKER))).toBe(true);
  }, 60_000);

  it.each([false, true])(
    'builds the published SSR entry in its own environment (framework buildApp: %s)',
    async (frameworkBuildApp) => {
      const root = await remoteApp();
      const builder = await build(root, { ssrEnvironment: 'mf_ssr', frameworkBuildApp });

      expect(builder.environments.mf_ssr.isBuilt).toBe(true);
      expect(builder.environments.mf_ssr.config.consumer).toBe('server');
      expect(builder.environments.mf_ssr.config.build.outDir).toBe(
        path.join('dist', 'mf_ssr')
      );

      const client = await readTree(path.join(root, 'dist/client'));
      const server = await readTree(path.join(root, 'dist/server'));
      const dedicated = await readTree(path.join(root, 'dist/mf_ssr'));

      // The public output carries the RPC caller only.
      expect(client.has('remoteEntry.ssr.js')).toBe(true);
      expect(client.has('remoteEntry.js')).toBe(true);
      expect([...client.values()].some((code) => code.includes(HANDLER_MARKER))).toBe(false);
      expect([...client.values()].some((code) => code.includes(CALLER_MARKER))).toBe(true);
      expect(JSON.parse(client.get('mf-manifest.json')!).metaData.ssrRemoteEntry.name).toBe(
        'remoteEntry.ssr.js'
      );

      // The handler stays in the app's private server output, which no longer
      // emits an SSR remote entry of its own.
      expect([...server.values()].some((code) => code.includes(HANDLER_MARKER))).toBe(true);
      expect(server.has('remoteEntry.ssr.js')).toBe(false);

      // The dedicated build holds only the SSR entry graph.
      expect(dedicated.has('remoteEntry.ssr.js')).toBe(true);
      expect(dedicated.has('remoteEntry.js')).toBe(false);
      expect(dedicated.has('mf-manifest.json')).toBe(false);
      for (const file of dedicated.keys()) expect(client.has(file)).toBe(true);

      expect(await getExpose(path.join(root, 'dist/client/remoteEntry.ssr.js'))).toBe(
        CALLER_MARKER
      );
    },
    60_000
  );

  it('keeps a single-output client build and its input intact', async () => {
    const root = await remoteApp();
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: 'silent',
      // A framework that only builds the browser app, with one output directory.
      builder: {
        async buildApp(builder) {
          await builder.build(builder.environments.client);
        },
      },
      plugins: [
        serverFunctionCompiler(['mf_ssr']),
        federation({
          name: 'statusRemote',
          filename: 'remoteEntry.js',
          exposes: { './StatusCard': './StatusCard.js' },
          ssrEnvironment: 'mf_ssr',
          dts: false,
        }),
      ],
      build: {
        minify: false,
        rollupOptions: { input: { main: path.join(root, 'index.html') } },
      },
    });
    await builder.buildApp();

    expect(builder.environments.mf_ssr.config.build.outDir).toBe(path.join('dist', 'mf_ssr'));
    const output = await readTree(path.join(root, 'dist'));
    expect(output.has('remoteEntry.js')).toBe(true);
    expect(output.has('remoteEntry.ssr.js')).toBe(true);
    expect(existsSync(path.join(root, 'dist/index.html'))).toBe(true);
    expect(existsSync(path.join(root, 'dist/mf_ssr/index.html'))).toBe(false);
    expect([...output.values()].some((code) => code.includes(HANDLER_MARKER))).toBe(false);
    expect(await getExpose(path.join(root, 'dist/remoteEntry.ssr.js'))).toBe(CALLER_MARKER);
  }, 60_000);

  it('never writes into an app output directory with the same name', async () => {
    const root = await remoteApp();
    const builder = await build(root, { ssrEnvironment: 'server' });

    expect(builder.environments.server.config.build.outDir).toBe(path.join('dist', 'mf-server'));
    const server = await readTree(path.join(root, 'dist/server'));
    expect([...server.values()].some((code) => code.includes(HANDLER_MARKER))).toBe(true);
    expect(await getExpose(path.join(root, 'dist/client/remoteEntry.ssr.js'))).toBe(
      CALLER_MARKER
    );
  }, 60_000);

  it('rejects the client environment', () => {
    expect(() => federation({ name: 'statusRemote', ssrEnvironment: 'client' })).toThrow(
      /Invalid ssrEnvironment/
    );
  });
});
