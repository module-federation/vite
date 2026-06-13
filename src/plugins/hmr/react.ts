import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HmrAdapter } from '../pluginDevRemoteHmr';

const REACT_REFRESH_PATH = '/@react-refresh';
const LOCAL_REACT_REFRESH_PATH = '/@mf-react-refresh-local';

function stripQuery(url?: string): string | undefined {
  return url?.replace(/\?.*$/, '');
}

function resolveReactRefreshRuntime(root: string): string {
  const requireFromRoot = createRequire(pathToFileURL(path.join(root, 'package.json')));
  const reactPluginEntry = requireFromRoot.resolve('@vitejs/plugin-react');
  const requireFromReactPlugin = createRequire(reactPluginEntry);
  const reactPluginRoot = path.dirname(reactPluginEntry);
  const runtimePath = path.join(reactPluginRoot, 'refresh-runtime.js');
  const refreshUtilsPath = path.join(reactPluginRoot, 'refreshUtils.js');
  if (existsSync(runtimePath)) return readFileSync(runtimePath, 'utf-8');

  const reactRefreshDir = path.dirname(
    requireFromReactPlugin.resolve('react-refresh/package.json')
  );
  const reactRefreshRuntimePath = path.join(
    reactRefreshDir,
    'cjs/react-refresh-runtime.development.js'
  );
  return [
    'const exports = {}',
    readFileSync(reactRefreshRuntimePath, 'utf-8'),
    readFileSync(refreshUtilsPath, 'utf-8'),
    'export default exports',
  ].join('\n');
}

/**
 * Proxy module served for `/@react-refresh` on MF remote dev servers.
 * Delegates to the host page's RefreshRuntime when consumed by a host, but
 * falls back to this remote's local runtime when the remote is opened directly.
 */
const REACT_REFRESH_PROXY_MODULE = [
  `const __remoteOrigin = new URL(import.meta.url).origin;`,
  `const __target = window.location.origin === __remoteOrigin ? '${LOCAL_REACT_REFRESH_PATH}' : window.location.origin + '${REACT_REFRESH_PATH}';`,
  `const __rt = await import(__target);`,
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
    'vite:react-swc', // @vitejs/plugin-react-swc
  ],
  remote: {
    configureServer({ server }) {
      let reactRefreshRuntime: string | undefined;

      server.middlewares.use((req, res, next) => {
        const url = stripQuery(req.url);
        if (url === LOCAL_REACT_REFRESH_PATH) {
          reactRefreshRuntime ??= resolveReactRefreshRuntime(server.config.root);
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(reactRefreshRuntime);
          return;
        }

        if (url !== REACT_REFRESH_PATH) return next();

        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(REACT_REFRESH_PROXY_MODULE);
      });
    },
  },
};
