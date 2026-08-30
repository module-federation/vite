import { NormalizedModuleFederationOptions } from './normalizeModuleFederationOptions';

/** Client/browser react-dom entries that are safe to auto-share in a browser graph. */
export const REACT_DOM_CLIENT_SHARED_SUBPATHS = [
  'react-dom/client',
  'react-dom/profiling',
] as const;

/**
 * Server/SSR/static react-dom entries. Includes React 19 server.* / static.*
 * variants. These must not be auto-mapped into a browser share set.
 */
export const REACT_DOM_SERVER_SHARED_SUBPATHS = [
  'react-dom/server',
  'react-dom/server.browser',
  'react-dom/server.node',
  'react-dom/server.edge',
  'react-dom/server.bun',
  'react-dom/static',
  'react-dom/static.browser',
  'react-dom/static.node',
  'react-dom/static.edge',
] as const;

export const COMMON_SHARED_SUBPATHS: Record<string, string[]> = {
  react: ['react/jsx-runtime', 'react/jsx-dev-runtime', 'react/compiler-runtime'],
  'react-dom': [...REACT_DOM_CLIENT_SHARED_SUBPATHS, ...REACT_DOM_SERVER_SHARED_SUBPATHS],
  'solid-js': ['solid-js/web', 'solid-js/store', 'solid-js/html', 'solid-js/h'],
  zustand: ['zustand/vanilla', 'zustand/react'],
};

/**
 * Share-set environment for filtering react-dom common subpaths.
 * - client/browser → client + profiling
 * - node/ssr/server/react-server → server* + static*
 */
export type SharedSubpathEnvironment =
  | 'browser'
  | 'client'
  | 'node'
  | 'ssr'
  | 'server'
  | 'react-server'
  | string;

export type SharedSubpathShareSet = 'client' | 'server';

export function resolveSharedSubpathShareSet(
  environment?: SharedSubpathEnvironment | null
): SharedSubpathShareSet {
  if (!environment) return 'client';
  const normalized = environment.trim().toLowerCase();
  if (
    normalized === 'node' ||
    normalized === 'ssr' ||
    normalized === 'server' ||
    normalized === 'react-server' ||
    normalized === 'rsc'
  ) {
    return 'server';
  }
  return 'client';
}

function filterReactDomSharedSubpaths(
  subpaths: string[],
  shareSet: SharedSubpathShareSet
): string[] {
  if (shareSet === 'server') {
    return subpaths.filter((subpath) =>
      (REACT_DOM_SERVER_SHARED_SUBPATHS as readonly string[]).includes(subpath)
    );
  }
  return subpaths.filter((subpath) =>
    (REACT_DOM_CLIENT_SHARED_SUBPATHS as readonly string[]).includes(subpath)
  );
}

const VITE_DEFAULT_ASSET_TYPES = [
  'apng',
  'bmp',
  'png',
  'jpe?g',
  'jfif',
  'pjpeg',
  'pjp',
  'gif',
  'svg',
  'ico',
  'webp',
  'avif',
  'cur',
  'jxl',
  'mp4',
  'webm',
  'ogg',
  'mp3',
  'wav',
  'flac',
  'aac',
  'opus',
  'mov',
  'm4a',
  'vtt',
  'woff2?',
  'eot',
  'ttf',
  'otf',
  'webmanifest',
  'pdf',
  'txt',
];

const CSS_ASSET_TYPES = ['css', 'scss', 'sass', 'less', 'styl', 'stylus'];

const ASSET_LIKE_IMPORT_RE = new RegExp(
  `\\.(${[...CSS_ASSET_TYPES, ...VITE_DEFAULT_ASSET_TYPES].join('|')})(?:[?#].*)?$`,
  'i'
);

export function isAssetLikeImport(source: string): boolean {
  return ASSET_LIKE_IMPORT_RE.test(source);
}

// Mirrors Vite's own OPTIMIZABLE_ENTRY_RE: its dependency optimizer only
// bundles .js/.cjs/.mjs/.ts/.cts/.mts entries — notably not .jsx/.tsx.
const VITE_OPTIMIZABLE_ENTRY_RE = /\.[cm]?[jt]s$/;

export function isViteOptimizableEntry(resolvedPath: string): boolean {
  return VITE_OPTIMIZABLE_ENTRY_RE.test(resolvedPath);
}

export function removeTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function ensureTrailingSlash(value: string): string {
  return `${removeTrailingSlash(value)}/`;
}

export function getBasePath(base?: string): string {
  return removeTrailingSlash(base || '/');
}

export function isNuxtClientBase(base?: string): boolean {
  return getBasePath(base).endsWith('/_nuxt');
}

export function normalizeNodeModulePath(source: string): string {
  const queryIndex = source.indexOf('?');
  const path = queryIndex === -1 ? source : source.slice(0, queryIndex);
  return path.replace(/\\/g, '/');
}

export function isNodeModulePath(source: string): boolean {
  return source.includes('/node_modules/') || source.includes('\\node_modules\\');
}

export function filterId(id: unknown): id is string {
  return typeof id === 'string' && !id.includes('\0');
}

export function getMatchingNodeModuleSubpath(
  source: string,
  candidates: Iterable<string>
): string | undefined {
  const normalized = normalizeNodeModulePath(source);
  return [...candidates]
    .sort((a, b) => b.length - a.length)
    .find(
      (candidate) =>
        normalized.includes(`/node_modules/${candidate}/`) ||
        normalized.includes(`/node_modules/${candidate}.`)
    );
}

/**
 * Known subpaths auto-mapped when a local provider exists for `sharedKey`.
 *
 * For `react-dom`, filter by share-set environment so browser graphs only see
 * client/profiling and node/ssr/react-server graphs only see server* + static*.
 * Pass `environment` whenever the active Vite graph is known; omitting it
 * defaults to the client share set (safe for optimizeDeps / browser resolves).
 */
export function getCommonSharedSubpaths(
  sharedKey: string,
  environment?: SharedSubpathEnvironment | null
): string[] {
  const keyBase = removeTrailingSlash(sharedKey);
  const all = COMMON_SHARED_SUBPATHS[keyBase] || [];
  if (keyBase !== 'react-dom') return all;
  return filterReactDomSharedSubpaths(all, resolveSharedSubpathShareSet(environment));
}

/**
 * Whether `source` is an allowed react-dom subpath for the given environment.
 * Used so `react-dom/` is not a blind prefix: only env-filtered subpaths match.
 */
export function isEnvironmentAllowedReactDomSubpath(
  source: string,
  environment?: SharedSubpathEnvironment | null
): boolean {
  if (source === 'react-dom') return true;
  return getCommonSharedSubpaths('react-dom', environment).includes(source);
}

export function getCommonSharedSubpathFromNodeModulePath(
  source: string,
  sharedKey: string,
  environment?: SharedSubpathEnvironment | null
): string | undefined {
  const keyBase = removeTrailingSlash(sharedKey);
  return getMatchingNodeModuleSubpath(source, getCommonSharedSubpaths(keyBase, environment));
}

/**
 * Resolves the public path for remote entries
 * @param options - Module Federation options
 * @param viteBase - Vite's base config value
 * @param originalBase - Original base config before any transformations
 * @returns The resolved public path
 */
export function resolvePublicPath(
  options: NormalizedModuleFederationOptions,
  viteBase: string,
  originalBase?: string
): string {
  // Use explicitly set publicPath if provided, but treat "auto" as unset
  // (webpack convention: "auto" means infer at runtime, not a literal path segment)
  if (options.publicPath && options.publicPath !== 'auto') {
    return options.publicPath;
  }

  // Use runtime inference when base was not explicitly configured.
  if (!originalBase) {
    return 'auto';
  }

  // Use viteBase if available, ensuring it ends with a slash
  if (viteBase) {
    // Embedded deployment using a relative base "./" should resolve to an
    // "auto" publicPath.
    if (viteBase === './') {
      return 'auto';
    }
    return ensureTrailingSlash(viteBase);
  }

  // Fallback to auto if no base is specified
  return 'auto';
}
