import type { Plugin, ViteDevServer } from 'vite';
import { mfWarn } from '../utils/logger';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

const REMOTE_HMR_ENDPOINT = '__mf_hmr';
const REMOTE_HMR_EVENT = 'mf:remote-update';
const REMOTE_HMR_CONNECT_RETRY_DELAY_MS = 1000;
const REMOTE_HMR_CONNECT_MAX_RETRIES = 10;

/**
 * Proxy module served for `/@react-refresh` on MF remote dev servers.
 * Delegates to the host page's RefreshRuntime instance via
 * `window.location.origin`, ensuring a single shared component registry
 * across federation boundaries. A `configureServer` middleware is used
 * instead of `resolveId` because `@vitejs/plugin-react`'s
 * `vite:react-refresh` sub-plugin uses `enforce: 'pre'` and typically
 * wins the `resolveId` race.
 */
const REACT_REFRESH_PROXY_MODULE = [
  `const __rt = await import(window.location.origin + '/@react-refresh');`,
  `export const injectIntoGlobalHook = __rt.injectIntoGlobalHook;`,
  `export const register = __rt.register;`,
  `export const createSignatureFunctionForTransform = __rt.createSignatureFunctionForTransform;`,
  `export const registerExportsForReactRefresh = __rt.registerExportsForReactRefresh;`,
  `export const validateRefreshBoundaryAndEnqueueUpdate = __rt.validateRefreshBoundaryAndEnqueueUpdate;`,
  `export const __hmr_import = __rt.__hmr_import;`,
  `export default __rt.default || __rt;`,
].join('\n');

function getBasePath(base: string) {
  if (!base) return '/';
  if (base.startsWith('http://') || base.startsWith('https://')) {
    try {
      return new URL(base).pathname || '/';
    } catch {
      return '/';
    }
  }
  return base;
}

function getRemoteHmrPath(base: string) {
  return `${getBasePath(base).replace(/\/?$/, '/')}${REMOTE_HMR_ENDPOINT}`.replace(/\/{2,}/g, '/');
}

function getHmrWsPath(base: string, hmrPath?: string) {
  const normalizedBase = getBasePath(base);
  const normalizedPath = getBasePath(hmrPath || '');
  if (!normalizedPath || normalizedPath === '/') return normalizedBase;
  const trimmedBase = normalizedBase.endsWith('/') ? normalizedBase.slice(0, -1) : normalizedBase;
  const trimmedPath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
  return `${trimmedBase}/${trimmedPath}`;
}

function shouldIgnoreFile(file: string, options: NormalizedModuleFederationOptions) {
  return (
    file.includes('/node_modules/') ||
    file.includes('\\node_modules\\') ||
    file.includes(`/${options.virtualModuleDir}/`) ||
    file.includes(`\\${options.virtualModuleDir}\\`) ||
    file.includes('/.vite/') ||
    file.includes('\\.vite\\') ||
    file.includes('/.__mf__temp/') ||
    file.includes('\\.__mf__temp\\') ||
    file.includes('/.mf/') ||
    file.includes('\\.mf\\') ||
    file.includes('/mf-manifest.json') ||
    file.includes('\\mf-manifest.json') ||
    file.includes('/mf-stats.json') ||
    file.includes('\\mf-stats.json')
  );
}

function getRemoteHmrWsUrl(server: ViteDevServer) {
  const hmr = server.config.server.hmr;
  const protocol =
    hmr && typeof hmr === 'object' && hmr.protocol
      ? hmr.protocol
      : server.config.server.https
        ? 'wss'
        : 'ws';
  const hostname =
    hmr && typeof hmr === 'object' && hmr.host
      ? hmr.host
      : typeof server.config.server.host === 'string' && server.config.server.host !== '0.0.0.0'
        ? server.config.server.host
        : 'localhost';
  const port =
    hmr && typeof hmr === 'object' && (hmr.clientPort || hmr.port)
      ? hmr.clientPort || hmr.port
      : server.config.server.port;
  return `${protocol}://${hostname}:${port}${getHmrWsPath(server.config.base, hmr && typeof hmr === 'object' ? hmr.path : '')}?token=${server.config.webSocketToken}`;
}

function getLocalFallbackOrigin(server: ViteDevServer) {
  const protocol = server.config.server.https ? 'https' : 'http';
  const host =
    typeof server.config.server.host === 'string' &&
    server.config.server.host !== '0.0.0.0' &&
    server.config.server.host !== '::'
      ? server.config.server.host
      : 'localhost';
  const port = server.config.server.port || 5173;
  return `${protocol}://${host}:${port}`;
}

function getRemoteHmrEndpoint(remoteEntry: string, server: ViteDevServer) {
  try {
    const remoteManifestUrl = new URL(remoteEntry, getLocalFallbackOrigin(server));
    const parts = remoteManifestUrl.pathname.split('/').filter(Boolean);
    remoteManifestUrl.pathname = `/${parts.slice(0, -1).join('/')}`;
    if (!remoteManifestUrl.pathname.endsWith('/')) {
      remoteManifestUrl.pathname += '/';
    }
    remoteManifestUrl.search = '';
    remoteManifestUrl.hash = '';
    return new URL(REMOTE_HMR_ENDPOINT, remoteManifestUrl).toString();
  } catch {
    return null;
  }
}

function parseRemoteHmrMessage(rawData: unknown) {
  if (typeof rawData !== 'string') return null;
  try {
    const parsed = JSON.parse(rawData);
    if (parsed?.type !== 'custom' || typeof parsed?.event !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function getStringPreview(value: unknown, max = 180) {
  let rawValue = '';
  if (typeof value === 'string') rawValue = value;
  else if (value instanceof Error) rawValue = `${value.name}: ${value.message}`;
  else if (typeof value === 'object' && value !== null) {
    try {
      rawValue = JSON.stringify(value);
    } catch {}
  }
  return rawValue.slice(0, max);
}

function isRemoteHmrEnabled(dev: NormalizedModuleFederationOptions['dev']) {
  return typeof dev === 'object' && dev !== null && !!dev.remoteHmr;
}

/**
 * Detects whether the Vite plugin pipeline includes a framework with
 * cross-federation HMR support (a shared runtime proxy that works
 * across module federation boundaries).
 *
 * Currently only React is supported via the shared /@react-refresh proxy.
 */
function hasCrossFederationHmr(plugins: readonly { name: string }[]): boolean {
  const supportedPlugins = [
    'vite:react-refresh', // @vitejs/plugin-react
    'vite:react-swc:refresh', // @vitejs/plugin-react-swc
  ];
  return plugins.some((p) => supportedPlugins.includes(p.name));
}

function resolveHmrStrategy(
  dev: NormalizedModuleFederationOptions['dev'],
  plugins: readonly { name: string }[]
): 'full-reload' | 'native' {
  if (typeof dev === 'object' && dev !== null && dev.remoteHmr === 'full-reload') {
    return 'full-reload';
  }
  return hasCrossFederationHmr(plugins) ? 'native' : 'full-reload';
}

export default function pluginDevRemoteHmr(options: NormalizedModuleFederationOptions): Plugin {
  return {
    name: 'module-federation-dev-remote-hmr',
    apply: 'serve',
    configureServer(server) {
      if (!isRemoteHmrEnabled(options.dev)) return;

      const isRemote = Object.keys(options.exposes).length > 0;
      const isHost = Object.keys(options.remotes).length > 0;
      const strategy = resolveHmrStrategy(options.dev, server.config.plugins);

      if (isRemote) {
        const endpointPath = getRemoteHmrPath(server.config.base);
        const wsUrl = getRemoteHmrWsUrl(server);

        // Intercept /@react-refresh to serve a proxy that delegates to the
        // host's RefreshRuntime, unifying the component registry across
        // federation boundaries for React Fast Refresh support.
        server.middlewares.use((req, res, next) => {
          const url = req.url?.replace(/\?.*$/, '');
          if (url !== '/@react-refresh') return next();

          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(REACT_REFRESH_PROXY_MODULE);
        });

        server.middlewares.use((req, res, next) => {
          if (req.url?.replace(/\?.*/, '') !== endpointPath) {
            next();
            return;
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(
            JSON.stringify({
              remote: options.name,
              event: REMOTE_HMR_EVENT,
              wsUrl,
            })
          );
        });

        const broadcast = (file: string) => {
          if (strategy === 'native') return;
          if (shouldIgnoreFile(file, options)) return;

          server.ws.send({
            type: 'custom',
            event: REMOTE_HMR_EVENT,
            data: {
              remote: options.name,
              file,
              ts: Date.now(),
            },
          });
        };

        server.watcher.on('change', broadcast);
        server.watcher.on('add', broadcast);
        server.watcher.on('unlink', broadcast);

        server.httpServer?.once('close', () => {
          server.watcher.off('change', broadcast);
          server.watcher.off('add', broadcast);
          server.watcher.off('unlink', broadcast);
        });
      }

      if (isHost) {
        const connections: WebSocket[] = [];
        const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
        let isTearingDown = false;

        const clearReconnectTimer = (remoteName: string) => {
          const timer = reconnectTimers.get(remoteName);
          if (!timer) return;
          clearTimeout(timer);
          reconnectTimers.delete(remoteName);
        };

        const scheduleReconnect = (
          remoteName: string,
          remote: { entry: string },
          attempt: number,
          reason: string
        ) => {
          if (isTearingDown) return;
          if (attempt >= REMOTE_HMR_CONNECT_MAX_RETRIES) {
            mfWarn(
              `Remote "${remoteName}" full HMR reconnect skipped after ${REMOTE_HMR_CONNECT_MAX_RETRIES} attempts: ${reason}`
            );
            return;
          }
          clearReconnectTimer(remoteName);
          const timer = setTimeout(() => {
            reconnectTimers.delete(remoteName);
            void connectRemote(remoteName, remote, attempt + 1);
          }, REMOTE_HMR_CONNECT_RETRY_DELAY_MS);
          reconnectTimers.set(remoteName, timer);
        };

        const connectRemote = async (
          remoteName: string,
          remote: { entry: string },
          attempt = 0
        ) => {
          if (isTearingDown) return;
          const endpoint = getRemoteHmrEndpoint(remote.entry, server);
          if (!endpoint) {
            mfWarn(`Failed to build HMR endpoint URL for remote "${remoteName}"`);
            return;
          }

          try {
            const metadataResponse = await fetch(endpoint);
            if (!metadataResponse.ok) {
              mfWarn(
                `Failed to fetch remote HMR metadata from "${remoteName}": ${metadataResponse.status}`
              );
              scheduleReconnect(remoteName, remote, attempt, `HTTP ${metadataResponse.status}`);
              return;
            }

            const metadata = (await metadataResponse.json()) as {
              remote?: string;
              event?: string;
              wsUrl?: string;
            };
            if (metadata.event !== REMOTE_HMR_EVENT || !metadata.wsUrl) {
              mfWarn(`Remote "${remoteName}" returned unexpected HMR metadata shape`);
              return;
            }

            const ws = new WebSocket(metadata.wsUrl, 'vite-hmr');
            ws.onmessage = (rawEvent: { data: unknown }) => {
              if (strategy === 'native') return;
              const message = parseRemoteHmrMessage(rawEvent.data);
              if (!message || message.event !== REMOTE_HMR_EVENT) return;
              server.ws.send({ type: 'full-reload' });
            };
            ws.onopen = () => clearReconnectTimer(remoteName);
            ws.onerror = (error) => mfWarn(`Remote HMR socket error for "${remoteName}":`, error);
            ws.onclose = () => scheduleReconnect(remoteName, remote, attempt, 'socket closed');

            connections.push(ws);
          } catch (error) {
            mfWarn(
              `Failed to connect remote HMR for "${remoteName}" on attempt ${attempt + 1}: ${getStringPreview(error)}`
            );
            scheduleReconnect(remoteName, remote, attempt, getStringPreview(error));
          }
        };

        const teardown = () => {
          isTearingDown = true;
          reconnectTimers.forEach((timer) => clearTimeout(timer));
          reconnectTimers.clear();
          connections.forEach((connection) => {
            if (
              connection.readyState !== connection.CLOSING &&
              connection.readyState !== connection.CLOSED
            )
              connection.close();
          });
          connections.length = 0;
        };

        for (const [remoteName, remote] of Object.entries(options.remotes)) {
          void connectRemote(remoteName, remote);
        }

        const triggerHostReload = (file: string) => {
          if (strategy === 'native') return;
          if (shouldIgnoreFile(file, options)) return;
          server.ws.send({ type: 'full-reload' });
        };

        server.watcher.on('change', triggerHostReload);
        server.watcher.on('add', triggerHostReload);
        server.watcher.on('unlink', triggerHostReload);

        server.httpServer?.once('close', teardown);
      }
    },
  };
}
