import type { Plugin } from 'vite';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

const PROXY_MODULE = [
  `const __rt = await import(window.location.origin + '/@react-refresh');`,
  `export const injectIntoGlobalHook = __rt.injectIntoGlobalHook;`,
  `export const register = __rt.register;`,
  `export const createSignatureFunctionForTransform = __rt.createSignatureFunctionForTransform;`,
  `export const registerExportsForReactRefresh = __rt.registerExportsForReactRefresh;`,
  `export const validateRefreshBoundaryAndEnqueueUpdate = __rt.validateRefreshBoundaryAndEnqueueUpdate;`,
  `export const __hmr_import = __rt.__hmr_import;`,
  `export default __rt.default || __rt;`,
].join('\n');

/**
 * Intercepts `/@react-refresh` on MF remote dev servers and serves a
 * proxy module that delegates to the host page's RefreshRuntime instance.
 *
 * Without this, cross-origin modules loaded from the remote dev server
 * create a separate `react-refresh` component registry. Components
 * registered in the remote's runtime are invisible to the host's
 * `injectIntoGlobalHook` patch, so React Fast Refresh silently does nothing.
 *
 * The proxy uses `window.location.origin` to dynamically import the host's
 * `/@react-refresh` — this works because the browser page is always served
 * by the host dev server.
 *
 * A `configureServer` middleware is used instead of `resolveId` because
 * `@vitejs/plugin-react`'s `vite:react-refresh` sub-plugin also uses
 * `enforce: 'pre'` and typically runs first in the plugin pipeline.
 * The middleware intercepts the HTTP request before Vite's transform
 * middleware, making it independent of plugin ordering.
 */
export default function pluginSharedReactRefresh(
  options: NormalizedModuleFederationOptions
): Plugin {
  const isRemote = Object.keys(options.exposes).length > 0;
  const hmrEnabled =
    typeof options.dev === 'object' && options.dev !== null && options.dev.remoteHmr === true;

  return {
    name: 'module-federation-shared-react-refresh',
    apply: 'serve',

    configureServer(server) {
      if (!isRemote || !hmrEnabled) return;

      server.middlewares.use((req, res, next) => {
        const url = req.url?.replace(/\?.*$/, '');
        if (url !== '/@react-refresh') return next();

        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(PROXY_MODULE);
      });
    },
  };
}
