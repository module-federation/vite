import { createServer } from 'node:http';
import { SourceTextModule } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { createInstance, type ModuleFederationRuntimePlugin } from '@module-federation/runtime';
import { describe, expect, it } from 'vitest';
import ssrEntryLoaderPlugin, { revalidate } from '../ssrEntryLoader';
import { sharedCacheHelperCode } from '../packageUtils';
import {
  getRuntimeInitPromiseBootstrapCode,
  getRuntimeInitResolveBootstrapCode,
} from '../../virtualModules/virtualRuntimeInitStatus';

describe.skipIf(!SourceTextModule)('SSR generated build lifecycle through loadRemote', () => {
  it.each(['revalidate', 'maxAge'] as const)(
    'isolates owner state during 100 %s replacements and keeps held exports subscribed',
    async (trigger) => {
      const name = `lifecycle_${trigger}_${Math.random().toString(36).slice(2)}`;
      const cacheKey = `default:${name}`;
      const cacheHolder = globalThis as any;
      cacheHolder.__mf_module_cache__ ||= { share: {}, remote: {} };
      const cache = cacheHolder.__mf_module_cache__.share;
      const singleton = { createElement: () => 'host' };
      cache[cacheKey] = singleton;
      let version = 0;
      let entryHits = 0;
      const owners: string[] = [];
      const server = createServer((request, response) => {
        if (request.url?.startsWith('/mf-manifest.json')) {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              id: name,
              name,
              metaData: {
                name,
                type: 'app',
                buildInfo: { buildVersion: `${version}`, buildName: name },
                remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
                ssrRemoteEntry: { name: 'remoteEntry.ssr.js', path: '', type: 'module' },
                types: { path: '', name: '', zip: '', api: '' },
                globalName: name,
                publicPath: 'auto',
              },
              shared: [],
              remotes: [],
              exposes: [],
            })
          );
        } else if (request.url?.startsWith('/remoteEntry.ssr.js')) {
          entryHits++;
          const owner = `${name}_${version}`;
          owners.push(`__mf_init__${owner}__`);
          response.end(`
          ${getRuntimeInitResolveBootstrapCode(false, owner)}
          ${getRuntimeInitPromiseBootstrapCode(false, owner)}
          ${sharedCacheHelperCode}
          const cache = globalThis.__mf_module_cache__.share;
          const descriptor = { canonical: ${JSON.stringify(cacheKey)}, aliases: [] };
          let shared = __mfReadSharedCache(cache, descriptor);
          __mfSubscribeSharedCache(cache, descriptor, next => shared = next);
          export const init = () => initResolve({ marker: ${version} });
          export const get = async () => {
            const initialized = await initPromise;
            return () => ({
              marker: initialized.marker,
              get reactIdentity() { return shared; },
              default: () => shared.createElement(),
              wait: async gate => { await gate; return shared.createElement(); }
            });
          };
        `);
        } else response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No server address');
      const host = createInstance({
        name: `${name}_host`,
        remotes: [{ name, entry: `http://127.0.0.1:${address.port}/mf-manifest.json` }],
        plugins: [
          ssrEntryLoaderPlugin({
            strategy: 'vm',
            maxAgeMs: trigger === 'maxAge' ? 0 : undefined,
          }) as ModuleFederationRuntimePlugin,
        ],
      });
      type Remote = {
        marker: number;
        reactIdentity: typeof singleton;
        default(): string;
        wait(gate: Promise<void>): Promise<string>;
      };
      let release!: () => void;
      try {
        const load = () => host.loadRemote<Remote>(`${name}/Widget`);
        const initial = (await load())!;
        const held = initial.default;
        const pending = initial.wait(
          new Promise<void>((resolve) => {
            release = resolve;
          })
        );
        for (version = 1; version <= 100; version++) {
          if (trigger === 'revalidate') revalidate(name);
          const current = (await load())!;
          expect(current.marker).toBe(version);
          expect(current.reactIdentity).toBe(singleton);
        }
        const hits = entryHits;
        version = 100;
        expect((await load())!.marker).toBe(100);
        expect(entryHits).toBe(hits);
        expect(owners.every((key) => !Object.hasOwn(globalThis, key))).toBe(true);
        for (let index = 0; global.gc && index < 6; index++) {
          await setImmediate();
          global.gc({ type: 'major', execution: 'sync' });
          await setImmediate();
        }
        const subscribers: Set<(value: unknown) => void> =
          cache[Symbol.for('module-federation.shared-cache-listeners')][cacheKey];
        for (const subscriber of subscribers) subscriber({ createElement: () => 'updated' });
        expect(held()).toBe('updated');
        release();
        await expect(pending).resolves.toBe('updated');
        for (const subscriber of subscribers) subscriber(singleton);
        expect((await load())!.reactIdentity).toBe(singleton);
      } finally {
        release?.();
        cacheHolder.__FEDERATION__.__INSTANCES__ = cacheHolder.__FEDERATION__.__INSTANCES__.filter(
          (instance: object) => instance !== host
        );
        delete cache[cacheKey];
        delete cache[Symbol.for('module-federation.shared-cache-listeners')]?.[cacheKey];
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
