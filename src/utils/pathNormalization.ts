import { NormalizedModuleFederationOptions } from './normalizeModuleFederationOptions';

export const COMMON_SHARED_SUBPATHS: Record<string, string[]> = {
  react: ['react/jsx-runtime', 'react/jsx-dev-runtime'],
  'react-dom': ['react-dom/client', 'react-dom/server', 'react-dom/server.browser'],
  'solid-js': ['solid-js/web', 'solid-js/store', 'solid-js/html', 'solid-js/h'],
};

export function removeTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function ensureTrailingSlash(value: string): string {
  return `${removeTrailingSlash(value)}/`;
}

export function normalizeNodeModulePath(source: string): string {
  return source.replace(/\\/g, '/').replace(/\?.*$/, '');
}

export function isNodeModulePath(source: string): boolean {
  return source.includes('/node_modules/') || source.includes('\\node_modules\\');
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

export function getCommonSharedSubpaths(sharedKey: string): string[] {
  return COMMON_SHARED_SUBPATHS[removeTrailingSlash(sharedKey)] || [];
}

export function getCommonSharedSubpathFromNodeModulePath(
  source: string,
  sharedKey: string
): string | undefined {
  const keyBase = removeTrailingSlash(sharedKey);
  return getMatchingNodeModuleSubpath(source, getCommonSharedSubpaths(keyBase));
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

  // Handle empty original base case
  if (originalBase === '') {
    return 'auto';
  }

  // Use viteBase if available, ensuring it ends with a slash
  if (viteBase) {
    return ensureTrailingSlash(viteBase);
  }

  // Fallback to auto if no base is specified
  return 'auto';
}
