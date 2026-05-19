import type { HtmlTagDescriptor, Plugin, ViteDevServer } from 'vite';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { reactAdapter } from './hmr/react';
import { vueAdapter } from './hmr/vue';
import {
  setupHostFullReloadRelay,
  setupRemoteBroadcast,
  setupRemoteMetadataEndpoint,
} from './hmr/fullReload';

/**
 * Clears the federation runtime's `moduleCache` on every Vite `vite:beforeUpdate`
 * event. Without this, after a remote SFC change Vite would patch the in-memory
 * component, but `loadRemote()` would still return the cached stale module on
 * the next call (e.g. after route navigation), making the patched version
 * effectively unreachable.
 */
const FEDERATION_MODULE_CACHE_CLEAR_SCRIPT = `
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', function () {
    try {
      var f = globalThis.__FEDERATION__ || globalThis.__VMOK__;
      if (!f || !f.__INSTANCES__) return;
      for (var i = 0; i < f.__INSTANCES__.length; i++) {
        if (f.__INSTANCES__[i] && f.__INSTANCES__[i].moduleCache)
          f.__INSTANCES__[i].moduleCache.clear();
      }
    } catch (e) {}
  });
}`;

export type HmrStrategy = 'full-reload' | 'native';

export interface VitePluginLike {
  name: string;
}

export interface AdapterContext {
  server: ViteDevServer;
  options: NormalizedModuleFederationOptions;
}

/**
 * Framework-specific cross-federation HMR adapter.
 *
 * Each adapter declares which Vite plugin names indicate its framework is
 * present, then groups its hooks under `remote` / `host` namespaces — the
 * plugin only runs the namespace that matches the current process's role.
 * An adapter can ship hooks for one side, the other, or both.
 *
 * Hooks inside each namespace mirror Vite's plugin API but are scoped to
 * that role:
 *   - `remote.configureServer` — middleware on the remote dev server
 *     (e.g. the `/@react-refresh` proxy).
 *   - `remote.transform` — rewrite code served by the remote dev server
 *     (e.g. prefix Vue's `__hmrId` so host/remote SFCs don't collide).
 *   - `host.configureServer` — middleware on the host dev server (rare;
 *     intended for diagnostics or host-side endpoints).
 *   - `host.transformIndexHtml` — HTML tags injected into the host page
 *     (e.g. the `__VUE_HMR_RUNTIME__` guard script).
 *
 * Adapters are stateless; all per-server state belongs in the closures
 * they create inside the hooks. New frameworks plug in by implementing
 * this interface and adding the instance to `HMR_ADAPTERS` below.
 */
export interface HmrAdapter {
  readonly name: string;
  readonly pluginNames: readonly string[];
  remote?: {
    configureServer?(ctx: AdapterContext): void;
    /**
     * Use this to rewrite framework-emitted identifiers (e.g. Vue's
     * `__hmrId`) so that host and remote don't collide on the shared HMR
     * runtime. Return `undefined` to leave the code unchanged.
     */
    transform?(code: string, id: string, ctx: Omit<AdapterContext, 'server'>): string | undefined;
  };
  host?: {
    configureServer?(ctx: AdapterContext): void;
    transformIndexHtml?(ctx: AdapterContext): HtmlTagDescriptor[];
  };
}

export const HMR_ADAPTERS: readonly HmrAdapter[] = [reactAdapter, vueAdapter];

export function resolveAdapters(plugins: readonly VitePluginLike[]): HmrAdapter[] {
  const pluginNames = new Set(plugins.map((p) => p.name));
  return HMR_ADAPTERS.filter((adapter) =>
    adapter.pluginNames.some((name) => pluginNames.has(name))
  );
}

export function hasCrossFederationHmr(plugins: readonly VitePluginLike[]): boolean {
  return resolveAdapters(plugins).length > 0;
}

function isRemoteHmrEnabled(dev: NormalizedModuleFederationOptions['dev']) {
  return typeof dev === 'object' && dev !== null && !!dev.remoteHmr;
}

/**
 * `'native'` — a matched framework adapter owns HMR through Vite's native
 * channel (e.g. React Fast Refresh via the `/@react-refresh` proxy, Vue's
 * patched `__VUE_HMR_RUNTIME__`). The broadcast/relay path stays idle.
 *
 * `'full-reload'` — no adapter matched, or the user explicitly opted in with
 * `remoteHmr: 'full-reload'` to bypass adapters: the plugin's broadcast/relay
 * machinery triggers a page reload on every remote file change.
 */
function resolveHmrStrategy(
  dev: NormalizedModuleFederationOptions['dev'],
  plugins: readonly VitePluginLike[]
): HmrStrategy {
  if (typeof dev === 'object' && dev !== null && dev.remoteHmr === 'full-reload') {
    return 'full-reload';
  }
  return hasCrossFederationHmr(plugins) ? 'native' : 'full-reload';
}

export function shouldIgnoreFile(file: string, options: NormalizedModuleFederationOptions) {
  return (
    file.includes('/node_modules/') ||
    file.includes('\\node_modules\\') ||
    file.includes(`/${options.virtualModuleDir}/`) ||
    file.includes(`\\${options.virtualModuleDir}\\`) ||
    file.includes('/.vite/') ||
    file.includes('\\.vite\\') ||
    file.includes('/.mf/') ||
    file.includes('\\.mf\\') ||
    file.includes('/mf-manifest.json') ||
    file.includes('\\mf-manifest.json') ||
    file.includes('/mf-stats.json') ||
    file.includes('\\mf-stats.json')
  );
}

function collectHostTags(
  server: ViteDevServer,
  options: NormalizedModuleFederationOptions,
  adapters: readonly HmrAdapter[]
) {
  const ctx: AdapterContext = { server, options };

  const tags: HtmlTagDescriptor[] = [];
  for (const adapter of adapters) {
    const adapterTags = adapter.host?.transformIndexHtml?.(ctx);
    if (adapterTags) tags.push(...adapterTags);
  }

  // Generic federation cache-clear runs after framework-specific guards so the
  // guards (e.g. Vue's __VUE_HMR_RUNTIME__ trap) are in place before any module
  // evaluates.
  tags.push({
    tag: 'script',
    attrs: { type: 'module' },
    children: FEDERATION_MODULE_CACHE_CLEAR_SCRIPT,
    injectTo: 'head',
  });

  return tags;
}

export default function pluginDevRemoteHmr(options: NormalizedModuleFederationOptions): Plugin {
  const isHost = Object.keys(options.remotes).length > 0;
  const isRemote = Object.keys(options.exposes).length > 0;

  // Resolved once in `configResolved` from `config.plugins`. Vite calls
  // `configResolved` before any other hook below, so these are populated by
  // the time `configureServer` / `transform` / `transformIndexHtml` run.
  let adapters: readonly HmrAdapter[] = [];
  let strategy: HmrStrategy = 'full-reload';

  return {
    name: 'module-federation-dev-remote-hmr',
    apply: 'serve',
    configResolved(config) {
      adapters = resolveAdapters(config.plugins);
      strategy = resolveHmrStrategy(options.dev, config.plugins);
    },
    configureServer(server) {
      if (!isRemoteHmrEnabled(options.dev)) return;
      if (isRemote) {
        for (const adapter of adapters) {
          adapter.remote?.configureServer?.({ server, options });
        }
        setupRemoteMetadataEndpoint(server, options);

        if (strategy === 'full-reload') setupRemoteBroadcast(server, options);
      }

      if (isHost) {
        for (const adapter of adapters) {
          adapter.host?.configureServer?.({ server, options });
        }

        if (strategy === 'full-reload') setupHostFullReloadRelay(server, options);
      }
    },
    transform: {
      order: 'post',
      handler(code, id) {
        if (!isRemote || !isRemoteHmrEnabled(options.dev)) return;
        if (!adapters.length) return;
        let result = code;
        const adapterCtx = { options };
        for (const adapter of adapters) {
          const next = adapter.remote?.transform?.(result, id, adapterCtx);
          if (typeof next === 'string') result = next;
        }
        return result === code ? undefined : result;
      },
    },
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        if (!isRemoteHmrEnabled(options.dev)) return;
        if (!isHost || !ctx.server) return;
        return collectHostTags(ctx.server, options, adapters);
      },
    },
  };
}
