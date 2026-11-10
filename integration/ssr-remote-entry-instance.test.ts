import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { getInstance, init, loadRemote } from '@module-federation/runtime';
import { build, createServer, version, type InlineConfig } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { federation } from '../src';
import ssrEntryLoader, { revalidate } from '../src/utils/ssrEntryLoader';
import { serveDirectory } from './helpers/browser';

const require = createRequire(import.meta.url);
const cleanup: Array<() => Promise<unknown>> = [];

async function remoteRoot(prefix: string) {
  const root = await mkdtemp(path.join(import.meta.dirname, prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="./value.js"></script>');
  await writeFile(path.join(root, 'value.js'), "export const value = 'from remote';");
  return { root, name: path.basename(root).replace(/\W/g, '_') };
}

function remoteConfig(root: string, name: string, ssr?: string): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: 'silent',
    build: { outDir: 'dist', emptyOutDir: false, target: 'esnext', ssr },
    plugins: [
      federation({ name, filename: 'remoteEntry.js', exposes: { './value': './value.js' }, dts: false }),
    ],
  };
}

function instanceNames(): string[] {
  const federationGlobal = (
    globalThis as { __FEDERATION__?: { __INSTANCES__?: Array<{ name: string }> } }
  ).__FEDERATION__;
  return (federationGlobal?.__INSTANCES__ ?? []).map((instance) => instance.name);
}

// A server that calls the runtime's init() itself and loads remotes through
// ssrEntryLoader. The dev remote path (/__mf_ssr__/ over a ModuleRunner) is Vite 8+.
describe.runIf(Number(version.split('.')[0]) >= 8)('plain-Node host with ssrEntryLoader', () => {
  let built: { root: string; name: string };
  let dev: { root: string; name: string };

  beforeAll(async () => {
    built = await remoteRoot('.ssr-instance-built-');
    await build(remoteConfig(built.root, built.name));
    await build(remoteConfig(built.root, built.name, 'value.js'));
    const assets = await serveDirectory(path.join(built.root, 'dist'));
    cleanup.push(() => assets.close());

    dev = await remoteRoot('.ssr-instance-dev-');
    const server = await createServer({
      ...remoteConfig(dev.root, dev.name),
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
    cleanup.push(() => server.close());
    await server.listen();
    const { port } = server.httpServer!.address() as AddressInfo;

    init({
      name: 'plain-host',
      remotes: [
        { name: built.name, type: 'module', entry: `${assets.origin}/remoteEntry.js` },
        { name: dev.name, type: 'module', entry: `http://127.0.0.1:${port}/remoteEntry.js` },
      ],
      plugins: [
        ssrEntryLoader({
          resolvedShared: {
            '@module-federation/runtime': require.resolve('@module-federation/runtime'),
          },
        }),
      ],
    });
  }, 60_000);

  afterAll(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('keeps loading remotes after a built remote container initializes', async () => {
    for (const _request of [1, 2]) {
      expect((await loadRemote<{ value: string }>(`${built.name}/value`))?.value).toBe(
        'from remote'
      );
    }
    expect(getInstance()?.name).toBe('plain-host');
  });

  it('keeps one remote instance when a dev remote entry is evaluated again', async () => {
    for (const request of [1, 2]) {
      if (request === 2) revalidate();
      expect((await loadRemote<{ value: string }>(`${dev.name}/value`))?.value).toBe(
        'from remote'
      );
    }
    expect(getInstance()?.name).toBe('plain-host');
    expect(instanceNames().filter((name) => name === dev.name)).toHaveLength(1);
  });
});
