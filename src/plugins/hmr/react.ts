import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HmrAdapter } from '../pluginDevRemoteHmr';

const REACT_REFRESH_PATH = '/@react-refresh';
const LOCAL_REACT_REFRESH_PATH = '/@mf-react-refresh-local';
const HOST_REACT_REFRESH_URL = '__MF_REACT_REFRESH_URL__';
const HOST_REACT_REFRESH_RUNTIME = '__MF_REACT_REFRESH_RUNTIME__';
const LOCAL_REACT_REFRESH_ID = 'virtual:mf-react-refresh-local';
const REACT_REFRESH_EXPORTS = [
  'injectIntoGlobalHook',
  'register',
  'getRefreshReg',
  'createSignatureFunctionForTransform',
  'registerExportsForReactRefresh',
  'validateRefreshBoundaryAndEnqueueUpdate',
];

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
  `const __remoteUrl = new URL(import.meta.url);`,
  `const __isHost = window.location.origin !== __remoteUrl.origin;`,
  `const __target = __isHost ? globalThis.${HOST_REACT_REFRESH_URL} || window.location.origin + '${REACT_REFRESH_PATH}' : new URL('.${LOCAL_REACT_REFRESH_PATH}', __remoteUrl).href;`,
  `const __rt = (__isHost && globalThis.${HOST_REACT_REFRESH_RUNTIME}) || await import(__target);`,
  `export const injectIntoGlobalHook = __rt.injectIntoGlobalHook;`,
  `export const register = __rt.register;`,
  `export const getRefreshReg = __rt.getRefreshReg;`,
  `export const createSignatureFunctionForTransform = __rt.createSignatureFunctionForTransform;`,
  `export const registerExportsForReactRefresh = __rt.registerExportsForReactRefresh;`,
  `export const validateRefreshBoundaryAndEnqueueUpdate = __rt.validateRefreshBoundaryAndEnqueueUpdate;`,
  `export const __hmr_import = __rt.__hmr_import;`,
  `export default __rt.default || __rt;`,
].join('\n');

/**
 * `/@react-refresh` for a bundledDev remote. The bundle cannot fetch the
 * host's runtime by URL, so it binds lazily to the runtime the host page
 * publishes on a global and falls back to its own copy when opened directly.
 * Both share one component registry with the host's React.
 */
const BUNDLED_REACT_REFRESH_MODULE = [
  `import * as __local from '${LOCAL_REACT_REFRESH_ID}';`,
  `const __rt = () => globalThis.${HOST_REACT_REFRESH_RUNTIME} || __local;`,
  ...REACT_REFRESH_EXPORTS.map(
    (name) => `export function ${name}(...args) { return __rt().${name}(...args); }`
  ),
  `export const __hmr_import = __local.__hmr_import;`,
  `export const __mfLocalRuntime = __local;`,
  `export default { injectIntoGlobalHook };`,
].join('\n');

export const reactAdapter: HmrAdapter = {
  name: 'react',
  pluginNames: [
    'vite:react-refresh', // @vitejs/plugin-react
    'vite:react-swc', // @vitejs/plugin-react-swc
  ],
  host: {
    transformIndexHtml({ server }) {
      const refreshPath = `${server.config.base.replace(/\/$/, '')}${REACT_REFRESH_PATH}`;
      // plugin-react's bundledDev preamble imports the runtime without base.
      const isBundled = server.config.experimental?.bundledDev === true;
      return [
        {
          tag: 'script',
          children: `globalThis.${HOST_REACT_REFRESH_URL} = new URL(${JSON.stringify(refreshPath)}, window.location.origin).href;`,
          injectTo: 'head-prepend',
        },
        {
          // Publish this page's RefreshRuntime instance for remote modules.
          tag: 'script',
          attrs: { type: 'module' },
          children: `import * as rt from ${JSON.stringify(isBundled ? REACT_REFRESH_PATH : refreshPath)};\nglobalThis.${HOST_REACT_REFRESH_RUNTIME} ??= rt.__mfLocalRuntime || rt;`,
          injectTo: 'head-prepend',
        },
      ];
    },
  },
  remote: {
    configureServer({ server }) {
      let reactRefreshRuntime: string | undefined;

      server.middlewares.use((req, res, next) => {
        const url = stripQuery(req.url);
        if (url?.endsWith(LOCAL_REACT_REFRESH_PATH)) {
          reactRefreshRuntime ??= resolveReactRefreshRuntime(server.config.root);
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(reactRefreshRuntime);
          return;
        }

        if (!url?.endsWith(REACT_REFRESH_PATH)) return next();

        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(REACT_REFRESH_PROXY_MODULE);
      });
    },
    resolveId(id) {
      if (id === LOCAL_REACT_REFRESH_ID) return `\0${LOCAL_REACT_REFRESH_ID}`;
    },
    load(id, { root, isBundled }) {
      if (!isBundled) return;
      if (id === REACT_REFRESH_PATH) return BUNDLED_REACT_REFRESH_MODULE;
      if (id === `\0${LOCAL_REACT_REFRESH_ID}`) return resolveReactRefreshRuntime(root);
    },
  },
};
