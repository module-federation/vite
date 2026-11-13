import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Rollup } from 'vite';
import { createInstance, type ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import { describe, expect, it } from 'vitest';
import { federation } from '../src';
import ssrEntryLoaderPlugin, { revalidate } from '../src/utils/ssrEntryLoader';

describe.runIf(process.versions.node.split('.')[0] === '24')(
  'built CommonJS SSR companions',
  () => {
    it('publishes and loads a bundled container, including nested remotes and rollback', async () => {
      const root = await mkdtemp(join(tmpdir(), 'mf-cjs-'));
      const id = Math.random().toString(36).slice(2);
      const names = { a: `cjs_a_${id}`, b: `cjs_b_${id}` };
      const privatePackage = `mf-cjs-private-${id}`;
      const privateRoot = join(root, 'node_modules', privatePackage);
      await mkdir(privateRoot, { recursive: true });
      await writeFile(
        join(privateRoot, 'package.json'),
        JSON.stringify({ name: privatePackage, type: 'module', exports: './index.js' })
      );
      await writeFile(
        join(privateRoot, 'index.js'),
        'export const privateValue = "bundled-private";'
      );
      const releases = new Map<string, Map<string, string>>();
      const selected = { a: 'v1', b: 'v1' };
      const hits = { a: 0, b: 0 };
      const server = createServer((request, response) => {
        const [, name, ...parts] = (request.url ?? '').split('/');
        if (name !== 'a' && name !== 'b') return response.writeHead(404).end();
        hits[name]++;
        const source = releases.get(`${name}/${selected[name]}`)?.get(parts.join('/'));
        if (source === undefined) return response.writeHead(404).end();
        response.setHeader(
          'content-type',
          parts.join('/').endsWith('.json') ? 'application/json' : 'text/javascript'
        );
        response.end(source);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No server address');
      const origin = `http://127.0.0.1:${address.port}`;
      let host: ReturnType<typeof createInstance> | undefined;
      try {
        for (const [name, version] of [
          ['b', 'v1'],
          ['a', 'v1'],
          ['a', 'v2'],
        ] as const) {
          const filename = join(root, `${name}-${version}.js`);
          await writeFile(
            filename,
            `
          export { privateValue } from ${JSON.stringify(privatePackage)};
          export const marker = ${JSON.stringify(`${name}-${version}`)};
          export const hostArray = Array;
          export const read = () => marker;
          ${name === 'a' ? `export async function nested() { return (await import(${JSON.stringify(names.b + '/Widget')})).marker; }` : ''}
        `
          );
          const options = () =>
            federation({
              name: names[name],
              filename: 'remoteEntry.js',
              ssrFormat: 'cjs',
              ssrFilename: 'server/container.ssr.cjs',
              ssrEntryLoader: { strategy: 'cjs' },
              manifest: true,
              dts: false,
              exposes: { './Widget': filename },
              remotes:
                name === 'a'
                  ? {
                      [names.b]: {
                        name: names.b,
                        entry: `${origin}/b/mf-manifest.json`,
                        type: 'module',
                      },
                    }
                  : {},
            });
          const outDir = join(root, 'dist', name, version);
          await build({
            configFile: false,
            root,
            logLevel: 'silent',
            plugins: [options()],
            build: {
              outDir,
              emptyOutDir: false,
              minify: false,
              target: 'esnext',
              rollupOptions: { input: filename },
            },
          });
          const result = (await build({
            configFile: false,
            root,
            logLevel: 'silent',
            plugins: [options()],
            build: { outDir, emptyOutDir: false, minify: false, target: 'node22', ssr: filename },
          })) as Rollup.RollupOutput;
          const files = new Map(
            result.output.map((file) => [
              file.fileName,
              file.type === 'chunk' ? file.code : String(file.source),
            ])
          );
          const source = files.get('server/container.ssr.cjs');
          expect(source).toBeDefined();
          expect(source).not.toMatch(/\bimport\s*\(|\bimport\.meta/);
          expect(source).not.toContain(`require("${privatePackage}")`);
          const manifest = JSON.parse(await readFile(join(outDir, 'mf-manifest.json'), 'utf8'));
          expect(manifest.metaData.ssrRemoteEntry).toEqual({
            name: 'server/container.ssr.cjs',
            path: '',
            type: 'commonjs-module',
          });
          manifest.metaData.buildInfo.buildVersion = `${name}-${version}`;
          files.set('mf-manifest.json', JSON.stringify(manifest));
          releases.set(`${name}/${version}`, files);
        }
        host = createInstance({
          name: `cjs_host_${id}`,
          remotes: Object.entries(names).map(([key, name]) => ({
            name,
            entry: `${origin}/${key}/mf-manifest.json`,
          })),
          plugins: [ssrEntryLoaderPlugin({ strategy: 'cjs' }) as ModuleFederationRuntimePlugin],
        });
        type Widget = {
          privateValue: string;
          marker: string;
          hostArray: typeof Array;
          read(): string;
          nested(): Promise<string>;
        };
        const first = (await host.loadRemote<Widget>(`${names.a}/Widget`))!;
        const held = first.read;
        expect(first.privateValue).toBe('bundled-private');
        expect(first.hostArray.prototype).toBe(Array.prototype);
        expect(await first.nested()).toBe('b-v1');
        await host.loadRemote(`${names.b}/Widget`);
        selected.a = 'v2';
        revalidate(names.a);
        const loaded = await Promise.all(
          Array.from({ length: 6 }, () => host!.loadRemote<Widget>(`${names.a}/Widget`))
        );
        expect(loaded.every((module) => module?.marker === 'a-v2')).toBe(true);
        expect(held()).toBe('a-v1');
        expect(await loaded[0]!.nested()).toBe('b-v1');
        const broken = new Map(releases.get('a/v2'));
        const manifest = JSON.parse(broken.get('mf-manifest.json')!);
        manifest.metaData.buildInfo.buildVersion = 'a-broken';
        broken.set('mf-manifest.json', JSON.stringify(manifest));
        broken.set('server/container.ssr.cjs', 'throw Error("broken CJS release")');
        releases.set('a/broken', broken);
        selected.a = 'broken';
        revalidate(names.a);
        await expect(host.loadRemote(`${names.a}/Widget`)).rejects.toThrow(/broken CJS release/);
        selected.a = 'v1';
        revalidate(names.a);
        expect((await host.loadRemote<Widget>(`${names.a}/Widget`))!.marker).toBe('a-v1');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const global = globalThis as any;
        global.__FEDERATION__.__INSTANCES__ = global.__FEDERATION__.__INSTANCES__.filter(
          (instance: any) =>
            instance !== host && !Object.values(names).includes(instance.options.name)
        );
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  }
);
