import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { federation } from '../src';

const roots: string[] = [];
const servers: ViteDevServer[] = [];

const workspaceRoot = path.resolve(import.meta.dirname, '..');

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mf-ssr-invalidate-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'mf-ssr-invalidate-repro',
      private: true,
      type: 'module',
      dependencies: {
        react: '19.2.4',
        'react-dom': '19.2.4',
        '@module-federation/runtime': '2.9.3',
        'cycle-lib': '1.0.0',
      },
    }),
    'src/entry.js': `import '@module-federation/runtime';\nexport const ready = true;\n`,
    'node_modules/cycle-lib/package.json': JSON.stringify({
      name: 'cycle-lib',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js', './widget': './widget.js' },
    }),
    'node_modules/cycle-lib/index.js': `export function root() { return 'root'; }\n`,
    'node_modules/cycle-lib/widget.js': `export function widget() { return 'widget'; }\n`,
  };
  await Promise.all(
    Object.entries(files).map(async ([file, source]) => {
      const filePath = path.join(root, file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, source);
    })
  );
  const modules = path.join(root, 'node_modules');
  await mkdir(path.join(modules, '@module-federation'), { recursive: true });
  await symlink(
    path.join(workspaceRoot, 'examples/vite-vite/vite-remote/node_modules/react'),
    path.join(modules, 'react')
  );
  await symlink(
    path.join(workspaceRoot, 'examples/vite-vite/vite-remote/node_modules/react-dom'),
    path.join(modules, 'react-dom')
  );
  await symlink(
    path.join(workspaceRoot, 'node_modules/@module-federation/runtime'),
    path.join(modules, '@module-federation/runtime')
  );
  return root;
}

describe('dev SSR shared import map invalidation', () => {
  it('keeps an evaluated SSR shared map intact when a client resolve registers a subpath', async () => {
    const root = await writeFixture();
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, preTransformRequests: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [
        ...federation({
          name: 'ssrHost',
          dts: false,
          filename: 'remoteEntry.js',
          remotes: { placeholder: 'http://127.0.0.1:9/mf-manifest.json' },
          shared: {
            react: { singleton: true, requiredVersion: '^19.2.4' },
            'cycle-lib/': { singleton: true },
          },
        }),
      ],
    });
    servers.push(server);

    await server.ssrLoadModule(pathToFileURL(path.join(root, 'src/entry.js')).href);
    const mapId = [...server.environments.ssr.moduleGraph.idToModuleMap.keys()].find((id) =>
      id.includes('localSharedImportMap')
    );
    expect(mapId, 'SSR should have evaluated the shared import map').toBeTruthy();
    await server.environments.client.transformRequest(mapId!);
    const ssrMod = server.environments.ssr.moduleGraph.getModuleById(mapId!);
    const clientMod = server.environments.client.moduleGraph.getModuleById(mapId!);
    expect(ssrMod?.transformResult).toBeTruthy();
    expect(clientMod?.transformResult).toBeTruthy();
    const ssrTimestamp = ssrMod!.lastInvalidationTimestamp;
    const ssrResult = ssrMod!.transformResult;

    await server.environments.client.pluginContainer.resolveId(
      'cycle-lib/widget',
      path.join(root, 'src/entry.js')
    );

    expect(
      server.environments.ssr.moduleGraph.getModuleById(mapId!)!.lastInvalidationTimestamp
    ).toBe(ssrTimestamp);
    expect(server.environments.ssr.moduleGraph.getModuleById(mapId!)!.transformResult).toBe(
      ssrResult
    );
    expect(
      server.environments.client.moduleGraph.getModuleById(mapId!)!.lastInvalidationTimestamp
    ).toBeGreaterThan(ssrTimestamp);
  });

  it('does not re-enter the SSR shared map while an eager share is still evaluating', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mf-ssr-invalidate-live-'));
    roots.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({
        name: 'mf-ssr-invalidate-live',
        private: true,
        type: 'module',
        dependencies: {
          react: '19.2.4',
          '@module-federation/runtime': '2.9.3',
          'cycle-lib': '1.0.0',
        },
      }),
      'src/entry.js': `
        import '@module-federation/runtime';
        import { value } from './cycle-b.js';
        export function render() { return value; }
      `,
      'src/cycle-b.js': `
        import { id } from './cycle-a.js';
        export const value = id();
      `,
      'src/cycle-a.js': `
        import { widget } from 'cycle-lib/widget';
        import { render } from './entry.js';
        export const id = () => widget(typeof render);
      `,
      'node_modules/cycle-lib/package.json': JSON.stringify({
        name: 'cycle-lib',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.js', './widget': './widget.js' },
      }),
      'node_modules/cycle-lib/index.js': `
        export const ready = await new Promise((resolve) => {
          globalThis.__mfReleaseEager = resolve;
        });
        export function root() { return 'root'; }
      `,
      'node_modules/cycle-lib/widget.js': `export function widget(kind) { return 'widget:' + kind; }\n`,
    };
    await Promise.all(
      Object.entries(files).map(async ([file, source]) => {
        const filePath = path.join(root, file);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, source);
      })
    );
    const modules = path.join(root, 'node_modules');
    await mkdir(path.join(modules, '@module-federation'), { recursive: true });
    await symlink(
      path.join(workspaceRoot, 'examples/vite-vite/vite-remote/node_modules/react'),
      path.join(modules, 'react')
    );
    await symlink(
      path.join(workspaceRoot, 'node_modules/@module-federation/runtime'),
      path.join(modules, '@module-federation/runtime')
    );

    const seen: unknown[] = [];
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, preTransformRequests: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      ssr: { noExternal: ['cycle-lib'] },
      plugins: [
        ...federation({
          name: 'ssrHost',
          dts: false,
          filename: 'remoteEntry.js',
          remotes: { placeholder: 'http://127.0.0.1:9/mf-manifest.json' },
          shared: {
            react: { singleton: true, requiredVersion: '^19.2.4' },
            'cycle-lib': { singleton: true, eager: true },
            'cycle-lib/': { singleton: true },
          },
        }),
        {
          name: 'probe-host-init-shared',
          enforce: 'post',
          transform(code, id) {
            if (!id.includes('hostAutoInit')) return;
            return code.replace(
              'const runtime = init({',
              'globalThis.__mfSeenSharedLog ??= []; globalThis.__mfSeenSharedLog.push(usedShared); const runtime = init({'
            );
          },
        },
      ],
    });
    servers.push(server);
    delete (globalThis as { __mfReleaseEager?: unknown }).__mfReleaseEager;
    delete (globalThis as { __mfSeenSharedLog?: unknown }).__mfSeenSharedLog;

    const loading = server.ssrLoadModule(pathToFileURL(path.join(root, 'src/entry.js')).href);
    const started = Date.now();
    while (!(globalThis as { __mfReleaseEager?: (value: boolean) => void }).__mfReleaseEager) {
      if (Date.now() - started > 5000) throw new Error('eager share gate was not reached');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await server.environments.client.pluginContainer.resolveId(
      'react/jsx-dev-runtime',
      path.join(root, 'src/entry.js')
    );
    const mapId = [...server.environments.ssr.moduleGraph.idToModuleMap.keys()].find((id) =>
      id.includes('localSharedImportMap')
    );
    const second = mapId ? server.ssrLoadModule(mapId) : Promise.resolve();
    (globalThis as { __mfReleaseEager?: (value: boolean) => void }).__mfReleaseEager?.(true);
    const loaded = await loading;
    await second;
    expect(loaded.render()).toBe('widget:function');
    seen.push(
      ...(((globalThis as { __mfSeenSharedLog?: unknown[] }).__mfSeenSharedLog ?? []) as unknown[])
    );
    expect(seen).not.toContain(null);
    expect(seen).not.toContain(undefined);
  });
});
