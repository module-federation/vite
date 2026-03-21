import * as http from 'http';
import * as https from 'https';
import { Logger, Plugin, Update, ViteDevServer } from 'vite';
import { deriveMfHmrUrl, onServerReady } from '../utils/hmrUtils';
import { formatModuleFederationMessage } from '../utils/logger';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getIsRolldown } from '../utils/packageUtils';
import {
  addUsedRemote,
  getRemoteVirtualModule,
  getUsedRemotesMap,
  invalidateRemoteVirtualModule,
} from '../virtualModules';

export default function (options: NormalizedModuleFederationOptions): Plugin {
  const { remotes } = options;
  const connections: Array<{ destroy: () => void }> = [];
  const remoteConsumers = new Map<string, Set<string>>();
  let command: string;
  let server: ViteDevServer;
  let logger: Logger;
  const remoteMatchers = Object.entries(remotes).map(([remoteKey, remote]) => ({
    remoteKey,
    pattern: new RegExp(`['"\`]${escapeRegExp(remote.name)}(?:['"\`]|/)`),
  }));

  return {
    name: 'proxyRemotes',
    configResolved(config) {
      logger = config.logger;
    },
    config(config, { command: _command }) {
      command = _command;
      const isRolldown = getIsRolldown(this);
      Object.keys(remotes).forEach((key) => {
        const remote = remotes[key];
        (config.resolve as any).alias.push({
          find: new RegExp(`^(${remote.name}(\/.*|$))`),
          replacement: '$1',
          customResolver(source: string) {
            const remoteModule = getRemoteVirtualModule(source, command, isRolldown);
            addUsedRemote(remote.name, source);
            return remoteModule.getPath();
          },
        });
      });
    },
    transform(code, id) {
      if (command !== 'serve') return;
      if (id.includes('node_modules') || id.includes('.vite/') || id.includes('__mf__virtual')) {
        return;
      }

      for (let i = 0; i < remoteMatchers.length; i++) {
        const matcher = remoteMatchers[i];
        const consumers = remoteConsumers.get(matcher.remoteKey);
        if (matcher.pattern.test(code)) {
          if (consumers) {
            consumers.add(id);
          } else {
            remoteConsumers.set(matcher.remoteKey, new Set([id]));
          }
        } else if (consumers) {
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
    // Serve-only federation HMR client: subscribe to each remote's SSE channel from the host.
    for (const [remoteKey, remote] of Object.entries(remotes)) {
      const hmrUrl = deriveMfHmrUrl(remote.entry);
      if (!hmrUrl) {
        logger.warn(
          formatModuleFederationMessage(`Cannot derive HMR URL for remote "${remoteKey}"`)
        );
        continue;
      }
      connectToRemote(remoteKey, remote.name, hmrUrl);
    }

    server.httpServer?.on('close', () => {
      for (let i = 0; i < connections.length; i++) {
        connections[i].destroy();
      }
      connections.length = 0;
    });
  }

  function connectToRemote(remoteKey: string, remoteName: string, hmrUrl: string) {
    const transport = hmrUrl.startsWith('https:') ? https : http;
    let currentReq: http.ClientRequest | null = null;
    let reconnectDelay = 1000;
    let destroyed = false;

    connections.push({
      destroy() {
        destroyed = true;
        if (currentReq) {
          currentReq.destroy();
          currentReq = null;
        }
      },
    });

    function connect() {
      if (destroyed) return;

      currentReq = transport.get(hmrUrl, { headers: { Accept: 'text/event-stream' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect();
          return;
        }

        reconnectDelay = 1000;
        let buffer = '';
        res.setEncoding('utf-8');

        res.on('data', (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (let i = 0; i < parts.length; i++) {
            handleEvent(parts[i], remoteKey, remoteName);
          }
        });

        res.on('end', scheduleReconnect);
        res.on('error', scheduleReconnect);
      });

      currentReq.on('error', scheduleReconnect);
    }

    function scheduleReconnect() {
      if (destroyed) return;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }

    connect();
  }

  function handleEvent(raw: string, remoteKey: string, remoteName: string) {
    const dataLines = raw
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));

    if (dataLines.length === 0) return;

    let event: { type: 'mf:update'; remoteName: string; timestamp: number };
    try {
      event = JSON.parse(dataLines.join(''));
    } catch {
      return;
    }

    if (event.type !== 'mf:update') return;
    invalidateRemoteModules(remoteKey, remoteName);
  }

  function invalidateRemoteModules(remoteKey: string, remoteName: string) {
    // Serve-only: invalidate virtual remotes and their consumers when a remote publishes an update.
    if (!server) return;

    const remoteModules = collectRemoteModules(remoteKey, remoteName);
    bustRemoteOptimizedDeps(remoteModules);
    const timestamp = Date.now();
    const updates: Update[] = [];

    remoteModules.forEach((remoteModule) => {
      const virtualModule = invalidateRemoteVirtualModule(remoteModule);
      if (!virtualModule) return;

      const mod = server.moduleGraph.getModuleById(virtualModule.getPath());
      if (!mod?.url) return;

      server.moduleGraph.invalidateModule(mod);
      updates.push({
        type: 'js-update',
        timestamp,
        path: mod.url,
        acceptedPath: mod.url,
      });
    });

    const consumers = remoteConsumers.get(remoteKey);
    consumers?.forEach((id) => {
      const mod = server.moduleGraph.getModuleById(id);
      if (!mod?.url) return;
      server.moduleGraph.invalidateModule(mod);
      updates.push({
        type: 'js-update',
        timestamp,
        path: mod.url,
        acceptedPath: mod.url,
      });
    });

    if (updates.length > 0) {
      server.ws.send({ type: 'update', updates });
      logger.info(
        formatModuleFederationMessage(
          `Remote "${remoteName}" updated ${updates.length} federation module(s)`
        )
      );
      return;
    }

    server.ws.send({ type: 'full-reload' });
  }

  function collectRemoteModules(remoteKey: string, remoteName: string): Set<string> {
    const usedRemotes = getUsedRemotesMap();
    const remoteModules = new Set<string>();

    const fromKey = usedRemotes[remoteKey];
    if (fromKey) {
      fromKey.forEach((id) => remoteModules.add(id));
    }

    const fromName = usedRemotes[remoteName];
    if (fromName) {
      fromName.forEach((id) => remoteModules.add(id));
    }

    return remoteModules;
  }

  function bustRemoteOptimizedDeps(remoteModules: Set<string>) {
    const metadata =
      (server as any).environments?.client?.depsOptimizer?.metadata ||
      (server as any)._optimizeDepsMetadata;

    if (!metadata?.optimized) return;

    const newHash = `${metadata.browserHash || 'mf'}_${Date.now().toString(36)}`;
    remoteModules.forEach((remoteModule) => {
      const dep = metadata.optimized[remoteModule];
      if (dep) {
        dep.browserHash = newHash;
      }
    });
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
