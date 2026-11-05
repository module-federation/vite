import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, version as viteVersion, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { federation } from '../src';
import { getNormalizeModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { getResolvedLocalSharedImportMapId } from '../src/virtualModules/virtualRemoteEntry';

const roots: string[] = [];
const servers: ViteDevServer[] = [];

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const viteMajor = Number(viteVersion.split('.')[0]);
// Vite 5 has one module graph. The mixed client+SSR graph, and this regression,
// start with the Environment API in Vite 6.
const hasEnvironmentModuleGraphs = viteMajor >= 6;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeFiles(root: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([file, source]) => {
      const filePath = path.join(root, file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, source);
    })
  );
}

async function linkRuntimeDeps(root: string, includeReactDom: boolean) {
  const modules = path.join(root, 'node_modules');
  await mkdir(path.join(modules, '@module-federation'), { recursive: true });
  await symlink(
    path.join(workspaceRoot, 'examples/vite-vite/vite-remote/node_modules/react'),
    path.join(modules, 'react')
  );
  if (includeReactDom) {
    await symlink(
      path.join(workspaceRoot, 'examples/vite-vite/vite-remote/node_modules/react-dom'),
      path.join(modules, 'react-dom')
    );
  }
  await symlink(
    path.join(workspaceRoot, 'node_modules/@module-federation/runtime'),
    path.join(modules, '@module-federation/runtime')
  );
}

function sharedMapId(): string {
  return getResolvedLocalSharedImportMapId(getNormalizeModuleFederationOptions());
}

describe.skipIf(!hasEnvironmentModuleGraphs)('dev SSR shared import map invalidation', () => {
  it('keeps an evaluated SSR shared map intact when a client resolve registers a subpath', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mf-ssr-invalidate-'));
    roots.push(root);
    await writeFiles(root, {
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
      'src/entry.js': `export const ready = true;\n`,
      'node_modules/cycle-lib/package.json': JSON.stringify({
        name: 'cycle-lib',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.js', './widget': './widget.js' },
      }),
      'node_modules/cycle-lib/index.js': `export function root() { return 'root'; }\n`,
      'node_modules/cycle-lib/widget.js': `export function widget() { return 'widget'; }\n`,
    });
    await linkRuntimeDeps(root, true);

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

    const mapId = sharedMapId();
    await server.environments.ssr.transformRequest(mapId);
    await server.environments.client.transformRequest(mapId);
    const ssrMod = server.environments.ssr.moduleGraph.getModuleById(mapId);
    const clientMod = server.environments.client.moduleGraph.getModuleById(mapId);
    expect(
      ssrMod?.transformResult,
      'SSR should have transformed the shared import map'
    ).toBeTruthy();
    expect(
      clientMod?.transformResult,
      'client should have transformed the shared import map'
    ).toBeTruthy();
    const ssrTimestamp = ssrMod!.lastInvalidationTimestamp;
    const ssrResult = ssrMod!.transformResult;

    await server.environments.client.pluginContainer.resolveId(
      'cycle-lib/widget',
      path.join(root, 'src/entry.js')
    );

    expect(
      server.environments.ssr.moduleGraph.getModuleById(mapId)!.lastInvalidationTimestamp
    ).toBe(ssrTimestamp);
    expect(server.environments.ssr.moduleGraph.getModuleById(mapId)!.transformResult).toBe(
      ssrResult
    );
    expect(
      server.environments.client.moduleGraph.getModuleById(mapId)!.lastInvalidationTimestamp
    ).toBeGreaterThan(ssrTimestamp);
  });

  // Host-init injection and the dev ModuleRunner re-entry are Vite 8 behavior.
  // Vite 6–7 still cover the mixed-graph invalidation in the test above.
  it.runIf(viteMajor >= 8)(
    'does not re-enter the SSR shared map while an eager share is still evaluating',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'mf-ssr-invalidate-live-'));
      roots.push(root);
      await writeFiles(root, {
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
      });
      await linkRuntimeDeps(root, false);

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

      const loading = server.ssrLoadModule('/src/entry.js');
      loading.catch(() => {});
      const started = Date.now();
      while (!(globalThis as { __mfReleaseEager?: (value: boolean) => void }).__mfReleaseEager) {
        if (Date.now() - started > 5000) throw new Error('eager share gate was not reached');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await server.environments.client.pluginContainer.resolveId(
        'react/jsx-dev-runtime',
        path.join(root, 'src/entry.js')
      );
      const mapId = sharedMapId();
      const second = server.ssrLoadModule(mapId);
      second.catch(() => {});
      (globalThis as { __mfReleaseEager?: (value: boolean) => void }).__mfReleaseEager?.(true);
      const loaded = await loading;
      await second;
      expect(loaded.render()).toBe('widget:function');
      const seen = ((globalThis as { __mfSeenSharedLog?: unknown[] }).__mfSeenSharedLog ??
        []) as unknown[];
      expect(seen).not.toContain(null);
      expect(seen).not.toContain(undefined);
    }
  );
});
