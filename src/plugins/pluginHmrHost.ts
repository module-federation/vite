import * as http from 'http';
import * as https from 'https';
import { Plugin, ViteDevServer, Update } from 'vite';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { createMfLogger, MfLogger } from '../utils/logger';
import { onServerReady } from '../utils/hmrUtils';

interface MfUpdateEvent {
  type: 'mf:update';
  remoteName: string;
  exposes: string[];
  timestamp: number;
}

/**
 * Guard script that runs BEFORE any ES modules to prevent remote Vue
 * instances from overwriting __VUE_HMR_RUNTIME__. In dev mode, host and
 * remote load separate Vue bundles; each sets __VUE_HMR_RUNTIME__ on
 * globalThis. The remote's Vue overwrites the host's, breaking HMR
 * because records and instances end up in different internal maps.
 * Locking to the first Vue (host's) fixes this.
 */
const VUE_HMR_GUARD_CODE = `
(function() {
  var h = null;
  Object.defineProperty(globalThis, "__VUE_HMR_RUNTIME__", {
    get: function() { return h },
    set: function(v) { if (h === null) h = v },
    configurable: true,
    enumerable: true
  });
})();`;

/**
 * Client-side code that clears the federation runtime's module cache
 * when receiving an mf:update event, so loadRemote() re-fetches fresh content.
 */
const CLIENT_MODULE_CODE = `
if (import.meta.hot) {
  import.meta.hot.on("mf:update", function() {
    try { 
      var f = globalThis.__FEDERATION__ || globalThis.__VMOK__;
      if (!f || !f.__INSTANCES__)
        return;
      for (var i=0; i<f.__INSTANCES__.length; i++) {
        if (f.__INSTANCES__[i] && f.__INSTANCES__[i].moduleCache)
          f.__INSTANCES__[i].moduleCache.clear()
      }
    } catch(e) {}   
  })
}`;

/**
 * HMR Host Plugin
 *
 * Runs on the host app's dev server. Connects to each remote's SSE endpoint
 * (/__mf_hmr) and listens for module update events.
 *
 * Strategy:
 * 1. Track which source files import from remotes (in transform hook)
 * 2. On remote update, send custom event to clear runtime cache in the browser
 * 3. Update browserHash for pre-bundled remote modules in Vite's dep optimizer
 *    metadata — this makes import-analysis generate new ?v= URLs when it
 *    re-transforms consuming files, forcing the browser to re-fetch and
 *    re-execute loadRemote()
 * 4. Invalidate consuming source files and send js-update
 * 5. Framework HMR (Vue/React) detects the change and re-renders
 */
export default function pluginHmrHost(options: NormalizedModuleFederationOptions): Plugin {
  const { remotes } = options;

  if (!remotes || Object.keys(remotes).length === 0) {
    return { name: 'module-federation-hmr-host' };
  }

  let server: ViteDevServer;
  let log: MfLogger;
  let hasVuePlugin = false;
  const connections: Array<{ destroy: () => void }> = [];

  // Track which source files import from which remotes (built during transform)
  const remoteConsumers = new Map<string, Set<string>>(); // remoteKey → source file IDs

  // Build a list of remote names and import-match patterns for transform
  const remoteNames: Array<{ key: string; name: string; pattern: RegExp }> = [];
  for (const key of Object.keys(remotes)) {
    const name = remotes[key].name;
    // Match remote name in import specifiers: quotes or backticks followed by the name
    remoteNames.push({ key, name, pattern: new RegExp(`['"\`]${escapeRegExp(name)}[/'"\`]`) });
  }

  return {
    name: 'module-federation-hmr-host',
    apply: 'serve',

    configResolved(config) {
      hasVuePlugin = config.plugins.some((p) => p.name === 'vite:vue');
      log = createMfLogger(config.logger);
    },

    // Inject client-side scripts into the host's HTML
    transformIndexHtml() {
      const tags: Array<{
        tag: string;
        children: string;
        injectTo: 'head-prepend' | 'head';
        attrs?: Record<string, string>;
      }> = [];

      if (hasVuePlugin) {
        tags.push({
          tag: 'script',
          children: VUE_HMR_GUARD_CODE,
          injectTo: 'head-prepend',
        });
      }

      tags.push({
        tag: 'script',
        attrs: { type: 'module' },
        children: CLIENT_MODULE_CODE,
        injectTo: 'head',
      });

      return tags;
    },

    // Track which source files import from remotes
    transform(code, id) {
      // Skip node_modules, virtual modules, and non-source files
      if (id.includes('node_modules') || id.includes('__mf__virtual') || id.includes('.vite/'))
        return;

      for (let i = 0; i < remoteNames.length; i++) {
        const consumers = remoteConsumers.get(remoteNames[i].key);
        if (remoteNames[i].pattern.test(code)) {
          if (!consumers) {
            remoteConsumers.set(remoteNames[i].key, new Set([id]));
          } else {
            consumers.add(id);
          }
        } else if (consumers) {
          // File no longer imports this remote — remove stale entry
          consumers.delete(id);
        }
      }
    },

    configureServer(_server) {
      server = _server;

      return () => {
        onServerReady(_server, connectToRemotes);
      };
    },
  };

  function connectToRemotes() {
    for (const key of Object.keys(remotes)) {
      const remote = remotes[key];
      const sseUrl = deriveSSEUrl(remote.entry);
      if (!sseUrl) {
        log.warn(`Cannot derive HMR URL for remote "${key}" (entry: ${remote.entry})`);
        continue;
      }
      log.info(`Connecting to remote "${key}" HMR at ${sseUrl}`);
      connectToRemote(key, remote.name, sseUrl);
    }

    server.httpServer?.on('close', () => {
      for (let i = 0; i < connections.length; i++) {
        connections[i].destroy();
      }
      connections.length = 0;
    });
  }

  function deriveSSEUrl(entry: string): string | null {
    try {
      const url = new URL(entry);
      return `${url.protocol}//${url.host}/__mf_hmr`;
    } catch {
      return null;
    }
  }

  function connectToRemote(remoteKey: string, remoteName: string, sseUrl: string) {
    const url = new URL(sseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    let reconnectDelay = 1000;
    let destroyed = false;
    let currentReq: http.ClientRequest | null = null;

    const conn = {
      destroy() {
        destroyed = true;
        if (currentReq) {
          currentReq.destroy();
          currentReq = null;
        }
      },
    };
    connections.push(conn);

    function connect() {
      if (destroyed) return;

      const req = transport.get(sseUrl, { headers: { Accept: 'text/event-stream' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect();
          return;
        }

        reconnectDelay = 1000;
        log.info(`Connected to remote "${remoteName}" HMR`);

        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (let i = 0; i < parts.length; i++) {
            processSSEMessage(parts[i], remoteKey, remoteName);
          }
        });

        res.on('end', () => {
          if (!destroyed) {
            log.info(`Disconnected from remote "${remoteName}" HMR, reconnecting...`);
          }
          scheduleReconnect();
        });

        res.on('error', () => {
          scheduleReconnect();
        });
      });

      currentReq = req;
      req.on('error', () => {
        scheduleReconnect();
      });
    }

    function scheduleReconnect() {
      if (destroyed) return;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }

    connect();
  }

  function processSSEMessage(raw: string, remoteKey: string, remoteName: string) {
    const dataLines: string[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('data: ')) {
        dataLines.push(lines[i].slice(6));
      }
    }
    if (dataLines.length === 0) return;

    let event: { type: string; remoteName?: string; exposes?: string[]; timestamp?: number };
    try {
      event = JSON.parse(dataLines.join(''));
    } catch {
      return;
    }

    if (event.type !== 'mf:update') return;
    handleRemoteUpdate(remoteKey, remoteName, event as MfUpdateEvent);
  }

  function handleRemoteUpdate(remoteKey: string, remoteName: string, event: MfUpdateEvent) {
    if (!server) return;

    const timestamp = Date.now();

    // Step 1: Send custom event to clear runtime cache in the browser.
    // Must happen BEFORE the HMR update so loadRemote() re-fetches.
    server.ws.send({
      type: 'custom',
      event: 'mf:update',
      data: { remoteName },
    });

    // Step 2: Update browserHash for pre-bundled remote modules.
    // Vite's import-analysis uses depInfo.browserHash to generate the ?v= URL
    // parameter. By changing it, the re-transformed consuming file will import
    // from a new URL, forcing the browser to re-fetch and re-execute the module
    // (which calls loadRemote() again with cleared runtime cache).
    bustPreBundledRemoteModules();

    // Step 3: Find consuming source files tracked during transform
    const consumers = remoteConsumers.get(remoteKey);
    if (!consumers || consumers.size === 0) {
      // Fallback: no tracked consumers, full reload
      server.ws.send({ type: 'full-reload' });
      log.info(
        `HMR update from remote "${remoteName}": ${event.exposes.join(', ')} (full reload — no tracked consumers)`
      );
      return;
    }

    // Step 4: Invalidate consuming files and send js-update.
    // When the browser re-fetches these files, Vite re-transforms them.
    // import-analysis generates new ?v= URLs for the remote deps (because
    // we changed browserHash above), so the browser re-fetches and re-executes
    // the pre-bundled remote module → loadRemote() runs with cleared cache.
    const updates: Update[] = [];

    consumers.forEach((id) => {
      // Find in module graph and invalidate
      const mod = server.moduleGraph.getModuleById(id);
      if (mod) {
        server.moduleGraph.invalidateModule(mod);
        if (mod.url) {
          updates.push({
            type: 'js-update',
            timestamp,
            path: mod.url,
            acceptedPath: mod.url,
          });
        }
      }
    });

    if (updates.length > 0) {
      server.ws.send({ type: 'update', updates });
      log.info(
        `HMR update from remote "${remoteName}": ${event.exposes.join(', ')} → ${updates.length} module(s) updated`
      );
    } else {
      server.ws.send({ type: 'full-reload' });
      log.info(
        `HMR update from remote "${remoteName}": ${event.exposes.join(', ')} (full reload — modules not in graph)`
      );
    }
  }

  /**
   * Change the browserHash for all pre-bundled remote virtual modules.
   * This makes Vite's import-analysis generate new ?v= URLs on next transform,
   * which forces the browser to treat the import as a new module and re-execute it.
   */
  function bustPreBundledRemoteModules() {
    // Vite 7+: server.environments.client.depsOptimizer
    const depsOptimizer = (server as any).environments?.client?.depsOptimizer;
    if (!depsOptimizer?.metadata) return;

    const metadata = depsOptimizer.metadata;
    const newHash = metadata.browserHash + '_' + Date.now().toString(36);
    let busted = 0;

    // Pre-bundled remote modules are keyed by the original import specifier
    // (e.g., "@namespace/viteViteRemote/App1"), NOT by the virtual module path.
    // Match by remote name prefix.
    const isRemoteKey = (key: string) =>
      remoteNames.some((r) => key === r.name || key.startsWith(r.name + '/'));

    if (metadata.optimized) {
      for (const key of Object.keys(metadata.optimized)) {
        if (isRemoteKey(key)) {
          metadata.optimized[key].browserHash = newHash;
          busted++;
        }
      }
    }

    if (busted > 0) {
      log.info(`Updated browserHash for ${busted} pre-bundled remote module(s)`);
    }
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
