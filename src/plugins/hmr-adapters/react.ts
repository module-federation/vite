import type { HmrAdapter } from '../pluginDevRemoteHmr';

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

export const reactAdapter: HmrAdapter = {
  name: 'react',
  pluginNames: [
    'vite:react-refresh', // @vitejs/plugin-react
    'vite:react-swc:refresh', // @vitejs/plugin-react-swc
  ],
  configureRemote({ server }) {
    server.middlewares.use((req, res, next) => {
      const url = req.url?.replace(/\?.*$/, '');
      if (url !== '/@react-refresh') return next();

      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(REACT_REFRESH_PROXY_MODULE);
    });
  },
};
